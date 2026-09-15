/**
 * Super Admin settings: outgoing email (SMTP), email templates, JVZoo IPN, and
 * sign-in policy. Secrets are encrypted and never returned to the browser.
 */
import { Router } from 'express';
import { z } from 'zod';
import { all, getSetting, setSetting, run, one } from '../../db/db.js';
import { config } from '../../config.js';
import { encrypt } from '../../lib/crypto.js';
import { badRequest, parse, wrap } from '../../lib/http.js';
import { requireAdmin, requireSuperAdmin } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import {
  resolveSmtp, verifySmtp, sendMail, templates, TEMPLATES_SETTING, SMTP_SETTING,
} from '../../lib/mail.js';
import { authSettings, AUTH_SETTING } from '../../lib/loginCodes.js';
import { jvzooSettings, JVZOO_SETTING, recentPayments } from '../webhooks.js';
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_SMTP_SETTINGS, type SmtpSettings } from '../../lib/defaults.js';
import { listPlans } from '../../lib/plans.js';
import { supportSettings, SUPPORT_SETTING } from '../profile.js';

export const adminSettingsRouter = Router();

// ---------------------------------------------------------------------------
// Email (SMTP)
// ---------------------------------------------------------------------------
adminSettingsRouter.get(
  '/email',
  requireAdmin,
  wrap((_req, res) => {
    const saved = { ...DEFAULT_SMTP_SETTINGS, ...getSetting<Partial<SmtpSettings>>(SMTP_SETTING, {}) };
    const resolved = resolveSmtp();
    res.json({
      configured: !!resolved,
      source: resolved?.source ?? null,
      settings: {
        host: saved.host, port: saved.port, secure: saved.secure, user: saved.user,
        from: saved.from || config.mail.from, replyTo: saved.replyTo, hasPassword: !!saved.passEnc,
      },
      env: config.mail.host ? { host: config.mail.host, port: config.mail.port, from: config.mail.from } : null,
      templates: templates(),
      defaults: DEFAULT_EMAIL_TEMPLATES,
    });
  }),
);

const smtpBody = z.object({
  host: z.string().max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(200),
  password: z.string().max(300).optional(), // omitted = keep the stored password
  from: z.string().min(3).max(200),
  replyTo: z.string().max(200).default(''),
});

adminSettingsRouter.put(
  '/email',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(smtpBody, req.body);
    const saved = { ...DEFAULT_SMTP_SETTINGS, ...getSetting<Partial<SmtpSettings>>(SMTP_SETTING, {}) };
    setSetting(SMTP_SETTING, {
      host: b.host.trim(),
      port: b.port,
      secure: b.secure,
      user: b.user.trim(),
      passEnc: b.password ? encrypt(b.password) : saved.passEnc,
      from: b.from.trim(),
      replyTo: b.replyTo.trim(),
    } satisfies SmtpSettings);
    audit(req, 'settings.email_updated', undefined, { host: b.host, port: b.port });
    res.json({ ok: true });
  }),
);

/** POST /api/admin/settings/email/test { to } - verify the connection and send a test message. */
adminSettingsRouter.post(
  '/email/test',
  requireAdmin,
  wrap(async (req, res) => {
    const { to } = parse(z.object({ to: z.string().email() }), req.body);
    const s = resolveSmtp();
    if (!s) throw badRequest('No SMTP settings yet. Add a host, port and credentials first.');
    const err = await verifySmtp(s);
    if (err) return res.json({ ok: false, error: `Could not connect: ${err}` });
    try {
      await sendMail(to, 'SelfLatitude Companion test email', 'This is a test message from the SelfLatitude Companion admin area. If you received it, outgoing email is working.');
      audit(req, 'settings.email_test', undefined, { to });
      res.json({ ok: true });
    } catch (e: any) {
      res.json({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }),
);

const templateBody = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(10000) });
adminSettingsRouter.put(
  '/email/templates',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(
      z.object({
        welcome: templateBody, renewal: templateBody, passwordReset: templateBody,
        loginCode: templateBody, emailChange: templateBody, invite: templateBody,
      }),
      req.body,
    );
    setSetting(TEMPLATES_SETTING, b);
    audit(req, 'settings.email_templates_updated');
    res.json({ templates: templates() });
  }),
);

// ---------------------------------------------------------------------------
// Sign-in policy
// ---------------------------------------------------------------------------
adminSettingsRouter.get('/auth', requireAdmin, wrap((_req, res) => res.json({ auth: authSettings() })));

adminSettingsRouter.put(
  '/auth',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(
      z.object({
        allowSelfRegistration: z.boolean(),
        selfRegistrationMonths: z.number().int().min(0).max(120),
        requireEmailCodeForAll: z.boolean(),
        requireMfaForAdmins: z.boolean(),
        emailCodeMinutes: z.number().int().min(2).max(60),
      }),
      req.body,
    );
    if (b.requireEmailCodeForAll && !resolveSmtp()) {
      throw badRequest('Set up outgoing email before requiring emailed sign-in codes, or nobody will be able to sign in.');
    }
    if (!b.requireMfaForAdmins && config.looksDeployed) {
      throw badRequest('Two-step verification for administrators cannot be turned off on a live site. It can only be turned off on a local development machine.');
    }
    setSetting(AUTH_SETTING, b);
    audit(req, 'settings.auth_updated', undefined, b);
    res.json({ auth: authSettings() });
  }),
);

// ---------------------------------------------------------------------------
// Support details shown on the Help page
// ---------------------------------------------------------------------------
adminSettingsRouter.get('/support', requireAdmin, wrap((_req, res) => res.json({ support: supportSettings() })));

adminSettingsRouter.put(
  '/support',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(
      z.object({
        email: z.string().email().max(200),
        responseTime: z.string().max(120),
        helpUrl: z.string().max(300),
        crisisNote: z.string().max(2000),
      }),
      req.body,
    );
    setSetting(SUPPORT_SETTING, b);
    audit(req, 'settings.support_updated', undefined, { email: b.email });
    res.json({ support: supportSettings() });
  }),
);

// ---------------------------------------------------------------------------
// JVZoo
// ---------------------------------------------------------------------------
adminSettingsRouter.get(
  '/jvzoo',
  requireAdmin,
  wrap((_req, res) => {
    const s = jvzooSettings();
    res.json({
      settings: {
        enabled: s.enabled,
        hasSecret: !!s.secretEnc,
        productMap: s.productMap ?? {},
        sendWelcomeEmail: s.sendWelcomeEmail,
        revokeOnRefund: s.revokeOnRefund,
      },
      ipnUrl: `${config.appUrl.replace(/\/$/, '')}/api/webhooks/jvzoo`,
      plans: listPlans().map((p) => ({ id: p.id, name: p.name, durationMonths: p.durationMonths })),
      stats: one(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN result='processed' THEN 1 ELSE 0 END) AS processed,
                SUM(CASE WHEN result='error' THEN 1 ELSE 0 END) AS errors,
                -- money kept: sales and rebills that have not been refunded or charged back
                COALESCE(SUM(CASE WHEN result='processed' AND transaction_type IN ('SALE','BILL') AND reversed_at IS NULL THEN amount_cents END),0) AS revenue_cents,
                COALESCE(SUM(CASE WHEN result='processed' AND transaction_type IN ('SALE','BILL') AND reversed_at IS NOT NULL THEN amount_cents END),0) AS refunded_cents,
                SUM(CASE WHEN result='processed' AND transaction_type IN ('RFND','CGBK') THEN 1 ELSE 0 END) AS refunds
         FROM payments WHERE source='jvzoo'`,
      ),
    });
  }),
);

adminSettingsRouter.put(
  '/jvzoo',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(
      z.object({
        enabled: z.boolean(),
        secret: z.string().max(200).optional(), // omitted = keep the stored secret
        productMap: z.record(z.string().max(80), z.string().max(60)).default({}),
        sendWelcomeEmail: z.boolean(),
        revokeOnRefund: z.boolean(),
      }),
      req.body,
    );
    const current = jvzooSettings();
    const secretEnc = b.secret ? encrypt(b.secret.trim()) : current.secretEnc;
    if (b.enabled && !secretEnc) throw badRequest('Add the JVZoo secret key before turning the integration on.');
    setSetting(JVZOO_SETTING, {
      enabled: b.enabled,
      secretEnc,
      productMap: b.productMap,
      sendWelcomeEmail: b.sendWelcomeEmail,
      revokeOnRefund: b.revokeOnRefund,
    });
    audit(req, 'settings.jvzoo_updated', undefined, { enabled: b.enabled, products: Object.keys(b.productMap).length });
    res.json({ ok: true });
  }),
);

/** GET /api/admin/settings/payments - the IPN log. */
adminSettingsRouter.get(
  '/payments',
  requireSuperAdmin,
  wrap((req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    res.json({
      payments: recentPayments(limit).map((p: any) => ({
        id: p.id, receipt: p.receipt, type: p.transaction_type, userId: p.user_id, userEmail: p.user_email,
        planId: p.plan_id, productCode: p.product_code, productTitle: p.product_title,
        customerEmail: p.customer_email, customerName: p.customer_name,
        amountCents: p.amount_cents, currency: p.currency, result: p.result, note: p.note, createdAt: p.created_at,
        monthsGranted: p.months_granted ?? 0, grantedCourse: !!p.granted_course, grantedUnlimited: !!p.granted_unlimited,
        reversedAt: p.reversed_at ?? null,
      })),
    });
  }),
);

/** POST /api/admin/settings/payments/:id/replay - re-apply a stored notification (support tool). */
adminSettingsRouter.post(
  '/payments/:id/replay',
  requireSuperAdmin,
  wrap((req, res) => {
    const p = one<any>('SELECT * FROM payments WHERE id = ?', req.params.id);
    if (!p) throw badRequest('Notification not found.');
    // Removing the row frees the receipt so the next identical notification is processed again.
    run('DELETE FROM payments WHERE id = ?', p.id);
    audit(req, 'payment.replay_cleared', { type: 'payment', id: p.id }, { receipt: p.receipt, transactionType: p.transaction_type });
    res.json({ ok: true, note: 'Cleared. Resend the notification from JVZoo and it will be processed again.' });
  }),
);

void all;
