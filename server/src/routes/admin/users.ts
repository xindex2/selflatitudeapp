import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso, tx } from '../../db/db.js';
import { config } from '../../config.js';
import { hashPassword, newId, randomToken, sessionHash, generateTempPassword } from '../../lib/crypto.js';
import { badRequest, notFound, parse, wrap } from '../../lib/http.js';
import { requireSuperAdmin, destroyAllSessions, type SessionUser } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { getUsageStatus, usageHistory } from '../../lib/usage.js';
import { issuePasswordReset } from '../auth.js';
import { sendTemplate } from '../../lib/mail.js';
import { getPlan, defaultPlan, applyPlanToUser, listPlans } from '../../lib/plans.js';

export const adminUsersRouter = Router();
adminUsersRouter.use(requireSuperAdmin);

/** Never expose password hashes, MFA secrets, or API keys. */
const USER_COLS = `id, email, name, role, status, course_access, companion_start, companion_end, reply_limit_override, cost_limit_override,
  mfa_enabled, mfa_method, must_change_password, onboarding_completed, consent_at, last_login_at, created_at, updated_at, plan_id, source, notes, email_verified`;

const shape = (u: any) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, courseAccess: !!u.course_access,
  companionStart: u.companion_start, companionEnd: u.companion_end, replyLimitOverride: u.reply_limit_override, costLimitOverride: u.cost_limit_override,
  mfaEnabled: !!u.mfa_enabled || u.mfa_method === 'email', mfaMethod: u.mfa_method ?? 'none',
  mustChangePassword: !!u.must_change_password, onboardingCompleted: !!u.onboarding_completed,
  consentAt: u.consent_at, lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
  planId: u.plan_id ?? null, planName: u.plan_name ?? null, source: u.source ?? 'manual',
  emailVerified: !!u.email_verified, notes: u.notes ?? null,
});

function load(id: string) {
  const u = one<any>(`SELECT ${USER_COLS} FROM users WHERE id = ? AND status != 'deleted'`, id);
  if (!u) throw notFound('User not found.');
  return u;
}

/** GET /api/admin/users?q=&status=&page= */
adminUsersRouter.get(
  '/',
  wrap((req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = String(req.query.status ?? '');
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 50;
    const planId = String(req.query.planId ?? '');
    const where: string[] = [`u.status != 'deleted'`];
    const params: any[] = [];
    if (q) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (status) { where.push('u.status = ?'); params.push(status); }
    if (planId) { where.push('u.plan_id = ?'); params.push(planId); }
    const cols = USER_COLS.split(',').map((c) => `u.${c.trim()}`).join(', ');
    const rows = all<any>(
      `SELECT ${cols}, p.name AS plan_name,
         (SELECT COUNT(*) FROM usage_ledger l WHERE l.user_id = u.id AND l.status='completed') AS replies_total,
         (SELECT MAX(created_at) FROM conversations c WHERE c.user_id = u.id) AS last_activity
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
       WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    );
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, ...params)!.n;
    res.json({
      users: rows.map((r) => ({ ...shape(r), repliesTotal: r.replies_total ?? 0, lastActivityAt: r.last_activity ?? null })),
      total, page, pageSize: size,
      plans: listPlans().map((p) => ({ id: p.id, name: p.name })),
    });
  }),
);

/**
 * POST /api/admin/users - create an account by hand.
 * Always returns the sign-in details once so the administrator can copy them; optionally
 * emails them to the student as well.
 */
adminUsersRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        email: z.string().email().max(200),
        name: z.string().min(1).max(120),
        role: z.enum(['student', 'owner', 'superadmin']).default('student'),
        planId: z.string().max(60).nullable().optional(),
        grantCompanionMonths: z.number().int().min(0).max(120).optional(),
        password: z.string().min(10).max(200).optional(),
        sendWelcomeEmail: z.boolean().default(true),
        sendResetEmail: z.boolean().default(false),
        requirePasswordChange: z.boolean().default(true),
      }),
      req.body,
    );
    if (one('SELECT id FROM users WHERE email = ?', body.email)) throw badRequest('A user with that email already exists.');

    const id = newId('usr');
    const password = body.password ?? generateTempPassword();
    run(
      `INSERT INTO users (id, email, name, password_hash, role, status, must_change_password, source)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 'manual')`,
      id, body.email.toLowerCase(), body.name.trim(), await hashPassword(password), body.role,
      body.requirePasswordChange ? 1 : 0,
    );

    // Access: a plan when given, otherwise a plain month grant.
    const plan = body.planId ? getPlan(body.planId) : null;
    if (body.planId && !plan) throw badRequest('That plan does not exist.');
    let companionEnd: string | null = null;
    if (plan) {
      companionEnd = applyPlanToUser(id, plan, 'start').companionEnd;
    } else {
      const months = body.grantCompanionMonths ?? 12;
      if (months > 0) {
        const start = new Date().toISOString().slice(0, 10);
        companionEnd = addMonths(new Date(), months);
        run('UPDATE users SET companion_start = ?, companion_end = ? WHERE id = ?', start, companionEnd, id);
      }
    }

    audit(req, 'admin.user_created', { type: 'user', id }, { role: body.role, plan: plan?.id ?? null });

    let emailed: 'welcome' | 'reset' | null = null;
    let emailError: string | null = null;
    try {
      if (body.sendResetEmail) {
        await issuePasswordReset(id, body.email, req.user!.id);
        emailed = 'reset';
      } else if (body.sendWelcomeEmail) {
        await sendTemplate(body.email, plan ? 'welcome' : 'invite', {
          name: body.name.trim(), password, planName: plan?.name ?? 'SelfLatitude Companion',
          companionEnd: companionEnd ?? 'no expiry', loginUrl: `${config.appUrl}/login`,
        });
        emailed = 'welcome';
      }
    } catch (e: any) {
      emailError = String(e?.message ?? e).slice(0, 200);
    }

    res.json({
      user: shape(load(id)),
      // Shown once so the administrator can copy and share it securely.
      credentials: { email: body.email.toLowerCase(), password, loginUrl: `${config.appUrl}/login` },
      emailed,
      emailError,
    });
  }),
);

adminUsersRouter.get(
  '/:id',
  wrap((req, res) => {
    const u = load(req.params.id);
    const sessionUser = u as unknown as SessionUser;
    const sessions = all('SELECT created_at, ip, user_agent, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', u.id);
    const counts = one<any>(
      `SELECT (SELECT COUNT(*) FROM conversations WHERE user_id = ? AND is_temporary = 0) AS conversations,
              (SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'approved') AS memories,
              (SELECT COUNT(*) FROM journal_entries WHERE user_id = ?) AS journalEntries,
              (SELECT COUNT(*) FROM usage_ledger WHERE user_id = ? AND status = 'completed') AS repliesAllTime,
              (SELECT ROUND(COALESCE(SUM(actual_cost),0), 4) FROM usage_ledger WHERE user_id = ? AND status = 'completed' AND payment_source = 'included') AS costAllTime,
              (SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ?) AS lastMessageAt`,
      u.id, u.id, u.id, u.id, u.id, u.id,
    );
    const payments = all(
      `SELECT receipt, transaction_type AS type, product_code AS productCode, product_title AS productTitle,
              amount_cents AS amountCents, currency, result, note, created_at AS createdAt
       FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, u.id,
    );
    const key = one<any>('SELECT last4, valid, use_until, keep_using, validated_at FROM customer_api_keys WHERE user_id = ?', u.id);
    const recent = all('SELECT action, created_at, actor_email, details_json FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 20', u.id);
    res.json({
      user: shape(u),
      usage: getUsageStatus(sessionUser),
      history: usageHistory(u.id),
      counts, // counts only - never private content
      plan: getPlan(u.plan_id),
      plans: listPlans().map((p) => ({ id: p.id, name: p.name, durationMonths: p.durationMonths, priceCents: p.priceCents, currency: p.currency })),
      payments,
      apiKey: key ? { last4: key.last4, valid: !!key.valid, activeUntil: key.use_until, keepUsing: !!key.keep_using, validatedAt: key.validated_at } : null,
      sessions,
      audit: recent,
    });
  }),
);

/** PATCH /api/admin/users/:id - name, email, role, access, usage overrides */
adminUsersRouter.patch(
  '/:id',
  wrap((req, res) => {
    const u = load(req.params.id);
    const body = parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        email: z.string().email().max(200).optional(),
        role: z.enum(['student', 'owner', 'superadmin']).optional(),
        courseAccess: z.boolean().optional(),
        companionStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        companionEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        replyLimitOverride: z.number().int().min(0).nullable().optional(),
        costLimitOverride: z.number().min(0).nullable().optional(),
        planId: z.string().max(60).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
      }),
      req.body,
    );
    if (body.email && one('SELECT id FROM users WHERE email = ? AND id != ?', body.email, u.id)) throw badRequest('Another user already has that email.');
    if (body.role && u.id === req.user!.id && body.role !== 'superadmin') throw badRequest('You cannot remove your own Super Admin role.');
    const sets: string[] = [];
    const params: any[] = [];
    if (body.planId && !getPlan(body.planId)) throw badRequest('That plan does not exist.');
    const map: Record<string, string> = { name: 'name', email: 'email', role: 'role', companionStart: 'companion_start', companionEnd: 'companion_end', replyLimitOverride: 'reply_limit_override', costLimitOverride: 'cost_limit_override', planId: 'plan_id', notes: 'notes' };
    for (const [k, col] of Object.entries(map)) {
      if (k in body) { sets.push(`${col} = ?`); params.push((body as any)[k] === undefined ? null : (body as any)[k]); }
    }
    if (body.courseAccess !== undefined) { sets.push('course_access = ?'); params.push(body.courseAccess ? 1 : 0); }
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), u.id);
    audit(req, 'admin.user_updated', { type: 'user', id: u.id }, { fields: Object.keys(body) });
    res.json({ user: shape(load(u.id)) });
  }),
);

/** POST /api/admin/users/:id/access { action: 'grant'|'suspend'|'revoke'|'reactivate', months? } */
adminUsersRouter.post(
  '/:id/access',
  wrap((req, res) => {
    const u = load(req.params.id);
    const body = parse(z.object({ action: z.enum(['grant', 'renew', 'suspend', 'revoke', 'reactivate']), months: z.number().int().min(1).max(120).optional() }), req.body);
    if (u.id === req.user!.id && (body.action === 'suspend' || body.action === 'revoke')) throw badRequest('You cannot suspend your own account.');
    const today = new Date();
    tx(() => {
      switch (body.action) {
        case 'grant': {
          run('UPDATE users SET companion_start = ?, companion_end = ?, status = ?, updated_at = ? WHERE id = ?', today.toISOString().slice(0, 10), addMonths(today, body.months ?? 12), 'active', nowIso(), u.id);
          break;
        }
        case 'renew': {
          const base = u.companion_end && u.companion_end > today.toISOString().slice(0, 10) ? new Date(u.companion_end) : today;
          run('UPDATE users SET companion_start = COALESCE(companion_start, ?), companion_end = ?, updated_at = ? WHERE id = ?', today.toISOString().slice(0, 10), addMonths(base, body.months ?? 12), nowIso(), u.id);
          break;
        }
        case 'suspend':
          run("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", nowIso(), u.id);
          destroyAllSessions(u.id);
          break;
        case 'reactivate':
          run("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), u.id);
          break;
        case 'revoke':
          run('UPDATE users SET companion_end = ?, updated_at = ? WHERE id = ?', new Date(today.getTime() - 86400_000).toISOString().slice(0, 10), nowIso(), u.id);
          break;
      }
    });
    audit(req, `admin.access_${body.action}`, { type: 'user', id: u.id }, { months: body.months });
    res.json({ user: shape(load(u.id)) });
  }),
);

/** POST /api/admin/users/:id/reset-email */
adminUsersRouter.post(
  '/:id/reset-email',
  wrap(async (req, res) => {
    const u = load(req.params.id);
    await issuePasswordReset(u.id, u.email, req.user!.id);
    audit(req, 'admin.reset_email_sent', { type: 'user', id: u.id });
    res.json({ ok: true });
  }),
);

/** POST /api/admin/users/:id/temp-password -> returns the temporary password once */
adminUsersRouter.post(
  '/:id/temp-password',
  wrap(async (req, res) => {
    const u = load(req.params.id);
    const temp = generateTempPassword();
    run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', await hashPassword(temp), nowIso(), u.id);
    destroyAllSessions(u.id);
    audit(req, 'admin.temp_password_set', { type: 'user', id: u.id });
    res.json({ temporaryPassword: temp, credentials: { email: u.email, password: temp, loginUrl: `${config.appUrl}/login` } });
  }),
);

/** POST /api/admin/users/:id/one-time-link { minutes? } -> secure short-lived link */
adminUsersRouter.post(
  '/:id/one-time-link',
  wrap((req, res) => {
    const u = load(req.params.id);
    const minutes = parse(z.object({ minutes: z.number().int().min(5).max(1440).optional() }), req.body ?? {}).minutes ?? 30;
    const raw = randomToken(32);
    run(
      `INSERT INTO auth_tokens (id, user_id, kind, expires_at, created_by) VALUES (?, ?, 'one_time_login', ?, ?)`,
      sessionHash(raw), u.id, new Date(Date.now() + minutes * 60_000).toISOString(), req.user!.id,
    );
    audit(req, 'admin.one_time_link', { type: 'user', id: u.id }, { minutes });
    res.json({ link: `${config.appUrl}/one-time?token=${raw}`, expiresInMinutes: minutes });
  }),
);

/** POST /api/admin/users/:id/sign-out-everywhere */
adminUsersRouter.post(
  '/:id/sign-out-everywhere',
  wrap((req, res) => {
    const u = load(req.params.id);
    destroyAllSessions(u.id);
    audit(req, 'admin.sessions_revoked', { type: 'user', id: u.id });
    res.json({ ok: true });
  }),
);

/** DELETE /api/admin/users/:id - permanent (GDPR erasure by admin) */
adminUsersRouter.delete(
  '/:id',
  wrap((req, res) => {
    const u = load(req.params.id);
    if (u.id === req.user!.id) throw badRequest('You cannot delete your own account here.');
    tx(() => {
      for (const t of ['conversations', 'memories', 'journal_entries', 'customer_api_keys', 'usage_ledger', 'auth_tokens', 'privacy_requests']) run(`DELETE FROM ${t} WHERE user_id = ?`, u.id);
      run(`UPDATE users SET email = ?, name = '', password_hash = NULL, status = 'deleted', mfa_secret_enc = NULL, mfa_enabled = 0, updated_at = ? WHERE id = ?`, `deleted-${u.id}@deleted.invalid`, nowIso(), u.id);
      destroyAllSessions(u.id);
    });
    audit(req, 'admin.user_deleted', { type: 'user', id: u.id });
    res.json({ ok: true });
  }),
);

function addMonths(d: Date, months: number): string {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + months);
  return x.toISOString().slice(0, 10);
}

