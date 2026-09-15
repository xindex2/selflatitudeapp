import { Router } from 'express';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { one, run, nowIso } from '../db/db.js';
import { config } from '../config.js';
import {
  hashPassword, verifyPassword, newId, randomToken, sessionHash, encrypt, decrypt,
} from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, parse, unauthorized, wrap, HttpError, limiter } from '../lib/http.js';
import {
  loadSessionUser, createSession, destroySession, destroyAllSessions, markSessionMfa, requireAuth,
  requireSecondFactorToChange, companionActive,
} from '../middleware/auth.js';
import { getUsageStatus } from '../lib/usage.js';
import { authSettings, issueLoginCode, verifyLoginCode, mfaRequiredFor, mfaMethodFor } from '../lib/loginCodes.js';
import { sendTemplate } from '../lib/mail.js';
import { defaultPlan, applyPlanToUser, getPlan } from '../lib/plans.js';
import { supportSettings } from './profile.js';

export const authRouter = Router();

const loginLimiter = limiter({ windowMs: 15 * 60_000, limit: 20 });
const resetLimiter = limiter({ windowMs: 60 * 60_000, limit: 5 });

const passwordSchema = z.string().min(10, 'Password must be at least 10 characters.').max(200);

/**
 * Per-account sign-in throttle. The per-IP limiter does not stop a spread-out attack on one
 * account, so failures are also counted against the email address.
 */
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS_PER_ACCOUNT = 10;
const attempts = new Map<string, { count: number; first: number }>();

function accountThrottled(email: string): boolean {
  const key = email.toLowerCase();
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS_PER_ACCOUNT;
}
function noteFailure(email: string) {
  const key = email.toLowerCase();
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
  // Keep the map from growing without bound on a broad attack.
  if (attempts.size > 5000) {
    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
  }
}
const clearFailures = (email: string) => attempts.delete(email.toLowerCase());

export function publicUser(u: NonNullable<import('express').Request['user']>, mfaVerified: boolean) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    companionActive: companionActive(u),
    companionEnd: u.companion_end,
    courseAccess: !!u.course_access,
    onboardingCompleted: !!u.onboarding_completed,
    memoryEnabledDefault: !!u.memory_enabled_default,
    journalShareAllowed: !!u.journal_share_allowed,
    mfaEnabled: !!u.mfa_enabled || u.mfa_method === 'email',
    mfaMethod: u.mfa_method ?? 'none',
    mfaRequired: mfaRequiredFor(u),
    planId: u.plan_id ?? null,
    avatarUrl: u.avatar_path ? `/api/profile/avatar/${u.id}` : null,
    pendingEmail: u.pending_email ?? null,
    mfaVerified,
    mustChangePassword: !!u.must_change_password,
  };
}

/** GET /api/auth/config - what the sign-in screens need before anyone is signed in. */
authRouter.get(
  '/config',
  wrap((_req, res) => {
    const s = authSettings();
    const support = supportSettings();
    res.json({
      allowSelfRegistration: s.allowSelfRegistration,
      emailCodeMinutes: s.emailCodeMinutes,
      supportEmail: support.email,
    });
  }),
);

/** GET /api/auth/me */
authRouter.get(
  '/me',
  wrap((req, res) => {
    if (!req.user) return res.json({ user: null });
    const plan = getPlan(req.user.plan_id);
    res.json({
      user: publicUser(req.user, !!req.mfaVerified),
      usage: companionActive(req.user) ? getUsageStatus(req.user) : null,
      plan: plan ? { id: plan.id, name: plan.name, description: plan.description, durationMonths: plan.durationMonths, priceCents: plan.priceCents, currency: plan.currency } : null,
    });
  }),
);

/** POST /api/auth/register - self-signup. Companion access must be granted by owner (or by future checkout). */
authRouter.post(
  '/register',
  loginLimiter,
  wrap(async (req, res) => {
    const body = parse(
      z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120), password: passwordSchema }),
      req.body,
    );
    const settings = authSettings();
    if (!settings.allowSelfRegistration) {
      throw new HttpError(403, 'Accounts are created when you purchase SelfLatitude Foundations. If you have bought the course and cannot sign in, contact SelfLatitude.', 'registration_closed');
    }
    const exists = one('SELECT id FROM users WHERE email = ?', body.email);
    if (exists) throw badRequest('An account with that email already exists. Try signing in or resetting your password.');
    const id = newId('usr');
    run(
      `INSERT INTO users (id, email, name, password_hash, role, status, source) VALUES (?, ?, ?, ?, 'student', 'active', 'self')`,
      id,
      body.email.toLowerCase(),
      body.name.trim(),
      await hashPassword(body.password),
    );
    if (settings.selfRegistrationMonths > 0) {
      const plan = defaultPlan();
      if (plan) applyPlanToUser(id, { ...plan, durationMonths: settings.selfRegistrationMonths }, 'start');
    }
    audit(req, 'user.register', { type: 'user', id });
    createSession(res, req, id, false);
    res.json({ user: publicUser(loadSessionUser(id)!, false) });
  }),
);

/** POST /api/auth/login */
authRouter.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    if (accountThrottled(body.email)) {
      throw new HttpError(429, 'Too many sign-in attempts for this account. Wait 15 minutes and try again, or reset your password.', 'too_many_attempts');
    }
    const user = one<any>('SELECT * FROM users WHERE email = ? AND status != ?', body.email, 'deleted');
    const ok = await verifyPassword(user?.password_hash, body.password);
    if (!user || !ok) {
      noteFailure(body.email);
      throw unauthorized('Incorrect email or password.');
    }
    clearFailures(body.email);
    if (user.status === 'suspended') throw new HttpError(403, 'Your account is suspended. Please contact SelfLatitude.', 'suspended');
    createSession(res, req, user.id, false);
    const needsMfa = mfaRequiredFor(user);
    const method = needsMfa ? mfaMethodFor(user) : null;
    if (needsMfa && method === 'email') {
      await issueLoginCode(user.id, user.email);
    }
    res.json({ user: publicUser(loadSessionUser(user.id)!, false), mfaRequired: needsMfa, mfaMethod: method });
  }),
);

/** POST /api/auth/logout */
authRouter.post(
  '/logout',
  wrap((req, res) => {
    destroySession(res, req.sessionId);
    res.json({ ok: true });
  }),
);

/** POST /api/auth/forgot - always returns ok to avoid account enumeration */
authRouter.post(
  '/forgot',
  resetLimiter,
  wrap(async (req, res) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    const user = one<any>('SELECT id, email, name FROM users WHERE email = ? AND status = ?', email, 'active');
    if (user) await issuePasswordReset(user.id, user.email, 'self');
    res.json({ ok: true });
  }),
);

export async function issuePasswordReset(userId: string, email: string, createdBy: string) {
  const raw = randomToken(32);
  run(
    `INSERT INTO auth_tokens (id, user_id, kind, expires_at, created_by) VALUES (?, ?, 'password_reset', ?, ?)`,
    sessionHash(raw),
    userId,
    new Date(Date.now() + 60 * 60_000).toISOString(),
    createdBy,
  );
  const link = `${config.appUrl}/reset-password?token=${raw}`;
  await sendTemplate(email, 'passwordReset', { link });
}

/** POST /api/auth/reset */
authRouter.post(
  '/reset',
  resetLimiter,
  wrap(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), password: passwordSchema }), req.body);
    const row = consumeToken(body.token, 'password_reset');
    if (!one('SELECT id FROM users WHERE id = ? AND status = ?', row.user_id, 'active')) {
      throw badRequest('This link is no longer valid.', 'token_invalid');
    }
    run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', await hashPassword(body.password), nowIso(), row.user_id);
    destroyAllSessions(row.user_id);
    audit(null, 'user.password_reset', { type: 'user', id: row.user_id });
    res.json({ ok: true });
  }),
);

/** GET /api/auth/one-time?token=... -> signs the user in once, then the token is spent */
authRouter.post(
  '/one-time',
  loginLimiter,
  wrap(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    const row = consumeToken(token, 'one_time_login');
    const user = one<any>('SELECT * FROM users WHERE id = ? AND status = ?', row.user_id, 'active');
    if (!user) throw notFound('This link is no longer valid.');
    createSession(res, req, user.id, false);
    audit(req, 'user.one_time_login', { type: 'user', id: user.id });
    const needsMfa = mfaRequiredFor(user);
    const method = needsMfa ? mfaMethodFor(user) : null;
    if (needsMfa && method === 'email') await issueLoginCode(user.id, user.email);
    res.json({ user: publicUser(loadSessionUser(user.id)!, false), mfaRequired: needsMfa, mfaMethod: method });
  }),
);

function consumeToken(raw: string, kind: string) {
  const id = sessionHash(raw);
  const row = one<any>('SELECT * FROM auth_tokens WHERE id = ? AND kind = ?', id, kind);
  if (!row || row.used_at || row.expires_at < nowIso()) throw badRequest('This link is invalid or has expired.', 'token_invalid');
  run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', nowIso(), id);
  return row;
}

/** POST /api/auth/change-password */
authRouter.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
    const user = one<any>('SELECT password_hash FROM users WHERE id = ?', req.user!.id);
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) throw badRequest('Current password is incorrect.');
    run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', await hashPassword(body.newPassword), nowIso(), req.user!.id);
    // Anyone else holding a session for this account is signed out; this one continues.
    run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user!.id, req.sessionId);
    run('DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL', req.user!.id);
    audit(req, 'user.password_change', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

/** POST /api/auth/onboarding - accept terms/privacy/age + memory preference */
authRouter.post(
  '/onboarding',
  requireAuth,
  wrap((req, res) => {
    const body = parse(
      z.object({ acceptTerms: z.literal(true), acceptPrivacy: z.literal(true), isAdult: z.literal(true), memoryEnabled: z.boolean() }),
      req.body,
    );
    run(
      `UPDATE users SET onboarding_completed = 1, terms_version = ?, privacy_version = ?, consent_at = ?,
        memory_enabled_default = ?, updated_at = ? WHERE id = ?`,
      config.policyVersions.terms,
      config.policyVersions.privacy,
      nowIso(),
      body.memoryEnabled ? 1 : 0,
      nowIso(),
      req.user!.id,
    );
    audit(req, 'user.consent', { type: 'user', id: req.user!.id }, { terms: config.policyVersions.terms, privacy: config.policyVersions.privacy });
    res.json({ ok: true });
  }),
);

/** PATCH /api/auth/profile */
authRouter.patch(
  '/profile',
  requireAuth,
  wrap((req, res) => {
    const body = parse(z.object({ name: z.string().min(1).max(120) }), req.body);
    run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', body.name.trim(), nowIso(), req.user!.id);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// MFA (TOTP). Required for Super Admin; optional for everyone else.
// ---------------------------------------------------------------------------
authRouter.post(
  '/mfa/setup',
  requireAuth,
  requireSecondFactorToChange,
  wrap(async (req, res) => {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user!.email, 'SelfLatitude Companion', secret);
    // Store as pending (not enabled) until verified
    run('UPDATE users SET mfa_secret_enc = ?, updated_at = ? WHERE id = ?', encrypt(secret), nowIso(), req.user!.id);
    const qr = await QRCode.toDataURL(otpauth);
    res.json({ secret, qr });
  }),
);

authRouter.post(
  '/mfa/enable',
  requireAuth,
  requireSecondFactorToChange,
  wrap((req, res) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    const row = one<any>('SELECT mfa_secret_enc FROM users WHERE id = ?', req.user!.id);
    if (!row?.mfa_secret_enc) throw badRequest('Start MFA setup first.');
    if (!authenticator.check(code, decrypt(row.mfa_secret_enc))) throw badRequest('That code is not valid. Try again.');
    run("UPDATE users SET mfa_enabled = 1, mfa_method = 'totp', updated_at = ? WHERE id = ?", nowIso(), req.user!.id);
    markSessionMfa(req.sessionId!);
    audit(req, 'user.mfa_enabled', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

/** POST /api/auth/mfa/use-email - switch this account to emailed sign-in codes. */
authRouter.post(
  '/mfa/use-email',
  requireAuth,
  requireSecondFactorToChange,
  wrap(async (req, res) => {
    run("UPDATE users SET mfa_method = 'email', mfa_enabled = 0, mfa_secret_enc = NULL, updated_at = ? WHERE id = ?", nowIso(), req.user!.id);
    audit(req, 'user.mfa_email_enabled', { type: 'user', id: req.user!.id });
    // The session is not marked verified here: the student must enter a code from the new method.
    await issueLoginCode(req.user!.id, req.user!.email);
    res.json({ ok: true, codeSent: true });
  }),
);

/** POST /api/auth/mfa/send-code - email a fresh sign-in code to the current account. */
authRouter.post(
  '/mfa/send-code',
  requireAuth,
  resetLimiter,
  wrap(async (req, res) => {
    await issueLoginCode(req.user!.id, req.user!.email);
    res.json({ ok: true, minutes: authSettings().emailCodeMinutes });
  }),
);

/** POST /api/auth/mfa/verify - accepts an authenticator code or an emailed code. */
authRouter.post(
  '/mfa/verify',
  requireAuth,
  loginLimiter,
  wrap((req, res) => {
    const { code } = parse(z.object({ code: z.string().min(4).max(10) }), req.body);
    const row = one<any>('SELECT mfa_secret_enc, mfa_enabled, mfa_method FROM users WHERE id = ?', req.user!.id);
    const method = mfaMethodFor(row ?? {});
    if (method === 'totp') {
      if (!row?.mfa_secret_enc) throw badRequest('Two-step verification is not set up on this account.');
      if (!authenticator.check(code.trim(), decrypt(row.mfa_secret_enc))) throw unauthorized('That code is not valid.');
    } else {
      const r = verifyLoginCode(req.user!.id, code);
      if (r === 'expired') throw unauthorized('That code has expired. Send a new one.');
      if (r === 'too_many') throw unauthorized('Too many attempts. Send a new code.');
      if (r !== 'ok') throw unauthorized('That code is not valid.');
      run('UPDATE users SET email_verified = 1 WHERE id = ?', req.user!.id);
    }
    markSessionMfa(req.sessionId!);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/mfa/disable',
  requireAuth,
  requireSecondFactorToChange,
  wrap(async (req, res) => {
    const { password } = parse(z.object({ password: z.string() }), req.body);
    if (req.user!.role === 'superadmin' && authSettings().requireMfaForAdmins) throw badRequest('Super Admin accounts must keep two-step verification enabled.');
    const row = one<any>('SELECT password_hash FROM users WHERE id = ?', req.user!.id);
    if (!(await verifyPassword(row.password_hash, password))) throw badRequest('Password is incorrect.');
    run("UPDATE users SET mfa_enabled = 0, mfa_method = 'none', mfa_secret_enc = NULL, updated_at = ? WHERE id = ?", nowIso(), req.user!.id);
    audit(req, 'user.mfa_disabled', { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

