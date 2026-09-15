import type { Request, Response, NextFunction } from 'express';
import { one, run, nowIso } from '../db/db.js';
import { config } from '../config.js';
import { randomToken, sessionHash } from '../lib/crypto.js';
import { forbidden, unauthorized, HttpError } from '../lib/http.js';
import { mfaRequiredFor, authSettings } from '../lib/loginCodes.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'owner' | 'superadmin';
  status: 'active' | 'suspended' | 'deleted';
  course_access: number;
  companion_start: string | null;
  companion_end: string | null;
  reply_limit_override: number | null;
  cost_limit_override: number | null;
  memory_enabled_default: number;
  journal_share_allowed: number;
  onboarding_completed: number;
  mfa_enabled: number;
  mfa_method: 'none' | 'totp' | 'email';
  must_change_password: number;
  plan_id: string | null;
  avatar_path: string | null;
  pending_email: string | null;
}

export const COOKIE = 'sl_session';

export function createSession(res: Response, req: Request, userId: string, mfaVerified: boolean): string {
  const raw = randomToken(32);
  const id = sessionHash(raw);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  run(
    `INSERT INTO sessions (id, user_id, mfa_verified, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    mfaVerified ? 1 : 0,
    (req.headers['user-agent'] ?? '').slice(0, 250),
    req.ip ?? null,
    expires.toISOString(),
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
  res.cookie(COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    expires,
    path: '/',
  });
  return id;
}

export function destroySession(res: Response, sessionId?: string) {
  if (sessionId) run('DELETE FROM sessions WHERE id = ?', sessionId);
  res.clearCookie(COOKIE, { path: '/' });
}

export function destroyAllSessions(userId: string) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function markSessionMfa(sessionId: string) {
  run('UPDATE sessions SET mfa_verified = 1 WHERE id = ?', sessionId);
}

export function loadSessionUser(userId: string): SessionUser | undefined {
  return one<SessionUser>(
    `SELECT id, email, name, role, status, course_access, companion_start, companion_end,
            reply_limit_override, cost_limit_override, memory_enabled_default, journal_share_allowed,
            onboarding_completed, mfa_enabled, mfa_method, must_change_password, plan_id, avatar_path, pending_email
     FROM users WHERE id = ? AND status != 'deleted'`,
    userId,
  );
}

/** Attach req.user if a valid session cookie exists (does not enforce). */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return next();
  const id = sessionHash(raw);
  const sess = one<{ user_id: string; expires_at: string; mfa_verified: number }>(
    'SELECT user_id, expires_at, mfa_verified FROM sessions WHERE id = ?',
    id,
  );
  if (!sess || sess.expires_at < nowIso()) {
    if (sess) run('DELETE FROM sessions WHERE id = ?', id);
    return next();
  }
  const user = loadSessionUser(sess.user_id);
  if (!user) return next();
  req.user = user;
  req.sessionId = id;
  req.mfaVerified = !!sess.mfa_verified;
  next();
}

/** Endpoints a half-signed-in session may still use: finishing the second step, and signing out. */
const MFA_EXEMPT_PATHS = new Set([
  '/api/auth/mfa/verify',
  '/api/auth/mfa/send-code',
  '/api/auth/logout',
  '/api/auth/me',
]);
function exemptFromMfa(req: Request): boolean {
  return MFA_EXEMPT_PATHS.has((req.originalUrl || '').split('?')[0]);
}

/** The checks every signed-in request must pass, whatever the role. */
function baseChecks(req: Request): Error | null {
  if (!req.user) return unauthorized();
  if (req.user.status === 'suspended') return forbidden('Your account is suspended. Please contact SelfLatitude.');
  if (mfaRequiredFor(req.user) && !req.mfaVerified && !exemptFromMfa(req)) {
    return new HttpError(403, 'Finish two-step verification to continue.', 'mfa_required');
  }
  return null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  // A password alone is not a signed-in session when the account requires a second step.
  const problem = baseChecks(req);
  return problem ? next(problem) : next();
}

/**
 * Guards the two-step verification settings themselves. Enrolling for the first time is
 * allowed, but an account that already has a second factor cannot change or remove it
 * from a session that has not passed that factor - otherwise a stolen password would be enough.
 */
export function requireSecondFactorToChange(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  // Covers both an individually enrolled factor and one required by the owner's policy:
  // otherwise a stolen password could enrol the attacker's own authenticator and skip it.
  if (mfaRequiredFor(req.user) && !req.mfaVerified) {
    return next(new HttpError(403, 'Enter your current verification code before changing two-step verification.', 'mfa_required'));
  }
  next();
}

export function isAdmin(u: SessionUser) {
  return u.role === 'owner' || u.role === 'superadmin';
}

/** Owner or Super Admin. Runs the same suspension and two-step checks as every other route. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const problem = baseChecks(req);
  if (problem) return next(problem);
  if (!isAdmin(req.user!)) return next(forbidden());
  next();
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  const problem = baseChecks(req);
  if (problem) return next(problem);
  if (req.user!.role !== 'superadmin') return next(forbidden());
  // The owner can turn this off, but only on a machine that is not a real deployment
  // (see the guard on PUT /api/admin/settings/auth).
  if (!authSettings().requireMfaForAdmins) return next();
  const hasSecondStep = !!req.user!.mfa_enabled || req.user!.mfa_method === 'email' || req.user!.mfa_method === 'totp';
  if (!hasSecondStep) return next(forbidden('Super Admin accounts must enable multifactor authentication first.'));
  if (!req.mfaVerified) return next(forbidden('Please verify your sign-in code to continue.'));
  next();
}

export function companionActive(u: SessionUser): boolean {
  if (u.status !== 'active') return false;
  if (isAdmin(u)) return true;
  if (!u.companion_start) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (u.companion_start > today) return false;
  if (u.companion_end && u.companion_end < today) return false;
  return true;
}

/** Student endpoints that consume the Companion require active membership. */
export function requireCompanion(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!companionActive(req.user)) {
    return next(forbidden('Your Companion access is not active. Your course access is unaffected; renew to continue using the Companion.'));
  }
  next();
}
