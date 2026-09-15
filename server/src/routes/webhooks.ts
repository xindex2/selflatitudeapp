/**
 * JVZoo Instant Payment Notification (IPN).
 *
 * JVZoo POSTs application/x-www-form-urlencoded fields for every transaction and signs
 * them with `cverify`: the first 8 characters (uppercase) of the SHA-1 of every posted
 * value except cverify, sorted by field name, joined with "|", with the secret key appended.
 *
 * On a sale we find or create the student, apply the mapped plan, and email their sign-in
 * details. Refunds, chargebacks and cancelled rebills end Companion access; lifetime course
 * access is a separate flag and is never removed automatically.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { all, one, run, getSetting, nowIso } from '../db/db.js';
import { config } from '../config.js';
import { newId, hashPassword, generateTempPassword, decrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { wrap, limiter } from '../lib/http.js';
import { sendTemplate } from '../lib/mail.js';
import { applyPlanToUser, defaultPlan, endCompanionAccess, getPlan, reverseGrant, type Plan } from '../lib/plans.js';
import { DEFAULT_JVZOO_SETTINGS, type JvzooSettings } from '../lib/defaults.js';

export const webhooksRouter = Router();
export const JVZOO_SETTING = 'jvzoo';

export function jvzooSettings(): JvzooSettings {
  return { ...DEFAULT_JVZOO_SETTINGS, ...getSetting<Partial<JvzooSettings>>(JVZOO_SETTING, {}) };
}

/** JVZoo's documented cverify algorithm. */
export function jvzooVerify(fields: Record<string, string>, secret: string): boolean {
  const provided = String(fields.cverify ?? '');
  if (!provided) return false;
  const pop = Object.keys(fields)
    .filter((k) => k !== 'cverify')
    .sort()
    .map((k) => `${fields[k]}|`)
    .join('') + secret;
  const calc = crypto.createHash('sha1').update(pop, 'utf8').digest('hex').slice(0, 8).toUpperCase();
  // constant-time compare
  const a = Buffer.from(calc);
  const b = Buffer.from(provided.toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Money in: create or extend access. SALE covers first purchases and upsells (an upsell is
 * simply another SALE with a different product code, which maps to its own plan). BILL is a
 * subscription rebill.
 */
const GRANTING = new Set(['SALE', 'BILL']);

/** Money back: reverse exactly the purchase being refunded. */
const REVERSING = new Set(['RFND', 'CGBK']);

/**
 * No change to access. Cancelling a subscription does not take back time already paid for -
 * access simply lapses on its own date - and un-cancelling does not add any. A failed rebill
 * attempt is retried by JVZoo.
 */
const INFORMATIONAL: Record<string, string> = {
  'CANCEL-REBILL': 'Subscription cancelled. Access already paid for runs to its normal end date and will not renew.',
  'UNCANCEL-REBILL': 'Subscription resumed. The next rebill will extend access.',
  INSF: 'A rebill payment failed. JVZoo will retry; access is unchanged.',
};

function planFor(settings: JvzooSettings, productCode: string): Plan | null {
  const mapped = settings.productMap?.[productCode];
  return (mapped ? getPlan(mapped) : null) ?? defaultPlan();
}

const ipnLimiter = limiter({ windowMs: 60_000, limit: 120 });

/**
 * `cverify` is only 32 bits, so a distributed attacker could in principle guess a valid
 * signature. Cap failures across all addresses, not just per address, and stop accepting
 * notifications for a while once the budget is spent.
 */
const SIGNATURE_FAILURE_BUDGET = 50;
const SIGNATURE_WINDOW_MS = 60 * 60_000;
let signatureFailures = { count: 0, since: Date.now() };

function noteSignatureFailure(): { overBudget: boolean; count: number } {
  if (Date.now() - signatureFailures.since > SIGNATURE_WINDOW_MS) signatureFailures = { count: 0, since: Date.now() };
  signatureFailures.count += 1;
  return { overBudget: signatureFailures.count > SIGNATURE_FAILURE_BUDGET, count: signatureFailures.count };
}
export function signatureFailureCount(): number {
  if (Date.now() - signatureFailures.since > SIGNATURE_WINDOW_MS) return 0;
  return signatureFailures.count;
}
export function resetSignatureFailures() { signatureFailures = { count: 0, since: Date.now() }; }

/**
 * POST /api/webhooks/jvzoo
 * Always answers 200 so JVZoo does not retry forever; the outcome is stored in `payments`
 * and shown in the admin area.
 */
webhooksRouter.post(
  '/jvzoo',
  ipnLimiter,
  wrap(async (req, res) => {
    const settings = jvzooSettings();
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) fields[k] = Array.isArray(v) ? String(v[0]) : String(v ?? '');

    const receipt = (fields.ctransreceipt ?? '').trim();
    const type = (fields.ctransaction || 'UNKNOWN').toUpperCase();
    const email = (fields.ccustemail || '').trim().toLowerCase();
    const name = (fields.ccustname || '').trim();
    const productCode = fields.cproditem || '';
    const amountCents = Math.round(Number(fields.ctransamount || 0) * 100) || 0;

    /**
     * Insert a row for this notification. `uniqueReceipt` is the value used against the
     * UNIQUE(source, receipt, transaction_type) constraint: the real receipt when we are
     * claiming the work (so a concurrent duplicate loses the race), or a suffixed value for
     * notes that must never block a legitimate retry. Returns false when the claim was lost.
     */
    const insertPayment = (result: string, note: string, uniqueReceipt: string, id: string, userId?: string | null, planId?: string | null): boolean => {
      try {
        const r = run(
          `INSERT OR IGNORE INTO payments (id, source, receipt, transaction_type, user_id, plan_id, product_code, product_title,
             customer_email, customer_name, amount_cents, currency, affiliate, payload_json, result, note)
           VALUES (?, 'jvzoo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, uniqueReceipt, type, userId ?? null, planId ?? null, productCode, fields.cprodtitle ?? '',
          email, name, amountCents, fields.ccurrency || 'USD', fields.caffitid ?? '',
          // Only store the notification body once its signature has been verified: anyone can
          // post to this endpoint, and unverified content must never reach the admin screens.
          verified ? JSON.stringify(fields) : null, result, note,
        );
        return r.changes > 0;
      } catch (e) {
        console.error('payment record failed', (e as Error).message);
        return false;
      }
    };

    /** Record something that needs no further action and must not block a retry. */
    const note = (result: string, text: string, userId?: string | null) =>
      insertPayment(result, text, `${receipt || 'no-receipt'}#${result}-${Date.now()}`, newId('pay'), userId ?? null);

    const finish = (result: string, text: string, userId?: string | null, planId?: string | null) =>
      run('UPDATE payments SET result = ?, note = ?, user_id = ?, plan_id = ? WHERE id = ?',
        result, text, userId ?? null, planId ?? null, claimId);

    /** Remember what this purchase gave, so a later refund can take back exactly that. */
    const recordGrant = (plan: Plan) =>
      run('UPDATE payments SET months_granted = ?, granted_course = ?, granted_unlimited = ? WHERE id = ?',
        Math.max(0, plan.durationMonths), plan.grantsCourse ? 1 : 0, plan.durationMonths <= 0 ? 1 : 0, claimId);
    const claimId = newId('pay');
    /** Set once access has actually been granted, so the claim is never released afterwards. */
    let granted = false;
    /** Only true once `cverify` has been checked against the secret. */
    let verified = false;

    if (!settings.enabled) {
      note('ignored', 'JVZoo integration is turned off in the admin area.');
      res.type('text/plain').send('ok');
      return;
    }

    let secret = '';
    try { secret = settings.secretEnc ? decrypt(settings.secretEnc) : ''; } catch { secret = ''; }
    if (!secret || !jvzooVerify(fields, secret)) {
      const { overBudget, count } = noteSignatureFailure();
      // Record that it happened and why, but never the unverified body.
      if (!overBudget) {
        note('error', `Signature check failed (${count} failure(s) in the last hour). The JVZoo secret key may be wrong, or this was not sent by JVZoo.`);
      }
      audit(null, 'jvzoo.signature_failed', { type: 'payment', id: receipt.slice(0, 64) }, { transactionType: type, failuresThisHour: count, overBudget });
      if (overBudget) console.error(`JVZoo: ${count} signature failures in the last hour; not recording further attempts.`);
      res.status(200).type('text/plain').send('ok');
      return;
    }
    verified = true;

    if (!email) {
      note('error', 'No customer email in the notification.');
      res.type('text/plain').send('ok');
      return;
    }

    // Without a receipt there is no idempotency key, so a retry would grant access twice.
    if (!receipt) {
      note('error', 'The notification has no transaction receipt, so it cannot be applied safely.');
      res.type('text/plain').send('ok');
      return;
    }

    // Claim the notification. The UNIQUE(source, receipt, transaction_type) constraint means a
    // duplicate or a simultaneous retry loses this insert and does no work.
    if (!insertPayment('processing', 'Received.', receipt, claimId)) {
      note('ignored', 'Duplicate notification; already handled.');
      res.type('text/plain').send('ok');
      return;
    }

    try {
      if (GRANTING.has(type)) {
        const plan = planFor(settings, productCode);
        if (!plan) {
          finish('error', 'No plan is configured to grant. Create a plan and mark it as the default.');
          res.type('text/plain').send('ok');
          return;
        }
        let user = one<any>('SELECT * FROM users WHERE email = ? AND status != ?', email, 'deleted');
        let tempPassword: string | null = null;

        if (!user) {
          const id = newId('usr');
          tempPassword = generateTempPassword();
          run(
            `INSERT INTO users (id, email, name, password_hash, role, status, source, must_change_password)
             VALUES (?, ?, ?, ?, 'student', 'active', 'jvzoo', 1)`,
            id, email, name || email.split('@')[0], await hashPassword(tempPassword),
          );
          user = one<any>('SELECT * FROM users WHERE id = ?', id);
        }

        const isNew = !!tempPassword;
        const { companionEnd } = applyPlanToUser(user.id, plan, isNew ? 'start' : 'extend');
        granted = true; // from here on the claim must stand, or a retry would grant twice
        recordGrant(plan);
        const what = plan.durationMonths > 0 ? `${plan.durationMonths} month(s)` : 'never-expiring access';
        finish(
          'processed',
          isNew ? `Account created; ${plan.name} applied (${what}).` : `${plan.name} applied to the existing account (${what}).`,
          user.id, plan.id,
        );
        audit(null, isNew ? 'jvzoo.account_created' : 'jvzoo.access_extended', { type: 'user', id: user.id }, { plan: plan.id, type, receipt });

        if (settings.sendWelcomeEmail) {
          try {
            if (isNew) {
              await sendTemplate(email, 'welcome', {
                name: user.name, password: tempPassword!, planName: plan.name,
                companionEnd: companionEnd ?? 'no expiry', loginUrl: `${config.appUrl}/login`,
              });
            } else {
              await sendTemplate(email, 'renewal', {
                name: user.name, planName: plan.name,
                companionEnd: companionEnd ?? 'no expiry', loginUrl: `${config.appUrl}/login`,
              });
            }
          } catch (e) {
            console.error('welcome email failed', (e as Error).message);
            run("UPDATE payments SET note = COALESCE(note,'') || ? WHERE id = ?",
              ' Email could not be sent - check the Email settings.', claimId);
          }
        }
      } else if (REVERSING.has(type)) {
        const user = one<any>('SELECT id, email FROM users WHERE email = ? AND status != ?', email, 'deleted');
        if (!user) {
          finish('ignored', 'No matching account, so there is nothing to reverse.');
        } else if (!settings.revokeOnRefund) {
          finish('ignored', 'Refund handling is turned off, so access was left as it is.', user.id);
        } else {
          // The purchase being refunded: the earlier granting notification with this receipt.
          const original = one<any>(
            `SELECT * FROM payments
             WHERE source = 'jvzoo' AND receipt = ? AND result = 'processed' AND reversed_at IS NULL
               AND transaction_type IN ('SALE','BILL')
             ORDER BY created_at DESC LIMIT 1`,
            receipt,
          );

          if (original) {
            // Everything else this student bought that is still valid.
            const rest = all<any>(
              `SELECT months_granted, granted_course, granted_unlimited, plan_id FROM payments
               WHERE source = 'jvzoo' AND user_id = ? AND result = 'processed' AND reversed_at IS NULL
                 AND id != ? AND transaction_type IN ('SALE','BILL')
               ORDER BY created_at DESC`,
              user.id, original.id,
            );
            const remaining = {
              hasOther: rest.length > 0,
              anyUnlimited: rest.some((r) => r.granted_unlimited === 1),
              anyCourse: rest.some((r) => r.granted_course === 1),
              latestPlanId: rest.find((r) => r.plan_id)?.plan_id ?? null,
            };

            const result = reverseGrant(user.id, {
              months: original.months_granted ?? 0,
              unlimited: original.granted_unlimited === 1,
              grantsCourse: original.granted_course === 1,
              planId: original.plan_id ?? null,
            }, remaining);
            granted = true;

            run('UPDATE payments SET reversed_at = ?, reversed_by = ? WHERE id = ?', nowIso(), receipt, original.id);
            const plan = getPlan(original.plan_id);
            const took = original.granted_unlimited === 1
              ? 'never-expiring access'
              : `${original.months_granted} month(s)`;
            finish(
              'processed',
              `${type}: reversed ${plan?.name ?? 'the purchase'} (${took}).`
                + ` Companion access now ${result.companionEnd ? `ends ${result.companionEnd}` : 'has no expiry'}.`
                + (original.granted_course === 1
                    ? result.courseAccess ? ' Course access kept (granted by another purchase).' : ' Course access removed.'
                    : ' Course access unchanged.'),
              user.id, original.plan_id ?? null,
            );
            audit(null, 'jvzoo.grant_reversed', { type: 'user', id: user.id },
              { type, receipt, plan: original.plan_id, months: original.months_granted, courseRemoved: original.granted_course === 1 && !result.courseAccess });
          } else {
            // No matching purchase on record (for example a sale from before this app).
            endCompanionAccess(user.id, `Companion access ended by JVZoo ${type} (receipt ${receipt}).`);
            granted = true;
            finish('processed', `${type}: no matching purchase on record, so Companion access was ended. Course access was not changed.`, user.id);
            audit(null, 'jvzoo.access_revoked', { type: 'user', id: user.id }, { type, receipt });
          }
        }
      } else if (INFORMATIONAL[type]) {
        const user = one<any>('SELECT id FROM users WHERE email = ? AND status != ?', email, 'deleted');
        finish('processed', INFORMATIONAL[type], user?.id ?? null);
        if (user) audit(null, `jvzoo.${type.toLowerCase().replace(/-/g, '_')}`, { type: 'user', id: user.id }, { receipt });
      } else {
        finish('ignored', `Transaction type ${type} needs no action.`);
      }
    } catch (e: any) {
      console.error('jvzoo ipn failed', e?.message);
      if (granted) {
        // The access change already happened; keep the claim so a retry cannot repeat it.
        try {
          run("UPDATE payments SET result = 'processed', note = ? WHERE id = ?",
            `Applied, but finishing up failed: ${String(e?.message ?? e).slice(0, 200)}`, claimId);
        } catch { /* nothing more we can do */ }
      } else {
        // Nothing was granted, so free the claim and let JVZoo retry.
        run('DELETE FROM payments WHERE id = ?', claimId);
        note('error', String(e?.message ?? e).slice(0, 300));
      }
    }

    res.type('text/plain').send('ok');
  }),
);

/** Recent notifications for the admin area. */
export function recentPayments(limit = 100) {
  return all(
    `SELECT p.*, u.email AS user_email FROM payments p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC LIMIT ?`, limit,
  );
}
