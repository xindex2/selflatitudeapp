import { Router } from 'express';
import { z } from 'zod';
import { one, run, nowIso } from '../db/db.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest, parse, wrap, limiter } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getUsageStatus, usageHistory, currentPeriod } from '../lib/usage.js';
import { testApiKey } from '../lib/openai.js';
import { audit } from '../lib/audit.js';

export const usageRouter = Router();
usageRouter.use(requireAuth);

/** These reach out to OpenAI, so they must not be usable as a key-checking oracle. */
const keyLimiter = limiter({ windowMs: 60 * 60_000, limit: 12 });

/** GET /api/usage */
usageRouter.get(
  '/',
  wrap((req, res) => {
    res.json({ usage: getUsageStatus(req.user!), history: usageHistory(req.user!.id) });
  }),
);

/**
 * POST /api/usage/api-key { apiKey }
 * Validates with OpenAI, stores encrypted. Does NOT switch to the key until the student confirms (see /activate).
 */
usageRouter.post(
  '/api-key',
  keyLimiter,
  wrap(async (req, res) => {
    const { apiKey } = parse(z.object({ apiKey: z.string().min(20).max(300) }), req.body);
    const key = apiKey.trim();
    if (!/^sk-/.test(key)) throw badRequest('That does not look like an OpenAI API key (they start with "sk-").');
    const err = await testApiKey(key);
    if (err) throw badRequest(err, 'key_invalid');
    const last4 = key.slice(-4);
    const existing = one<any>('SELECT keep_using, use_until FROM customer_api_keys WHERE user_id = ?', req.user!.id);
    run(
      `INSERT INTO customer_api_keys (user_id, key_enc, last4, validated_at, valid, use_until, keep_using, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET key_enc = excluded.key_enc, last4 = excluded.last4, validated_at = excluded.validated_at, valid = 1, updated_at = excluded.updated_at`,
      req.user!.id, encrypt(key), last4, nowIso(), existing?.use_until ?? null, existing?.keep_using ?? 0, nowIso(),
    );
    audit(req, 'apikey.saved', { type: 'user', id: req.user!.id }, { last4 });
    res.json({ usage: getUsageStatus(req.user!) });
  }),
);

/** POST /api/usage/api-key/test - re-validate stored key */
usageRouter.post(
  '/api-key/test',
  keyLimiter,
  wrap(async (req, res) => {
    const row = one<any>('SELECT key_enc FROM customer_api_keys WHERE user_id = ?', req.user!.id);
    if (!row) throw badRequest('No API key saved.');
    const { decrypt } = await import('../lib/crypto.js');
    const err = await testApiKey(decrypt(row.key_enc));
    run('UPDATE customer_api_keys SET valid = ?, validated_at = ?, updated_at = ? WHERE user_id = ?', err ? 0 : 1, nowIso(), nowIso(), req.user!.id);
    res.json({ ok: !err, error: err, usage: getUsageStatus(req.user!) });
  }),
);

/**
 * POST /api/usage/api-key/activate { keepUsing?: boolean }
 * Explicit student confirmation to use their key for the remainder of the current period.
 */
usageRouter.post(
  '/api-key/activate',
  wrap((req, res) => {
    const { keepUsing } = parse(z.object({ keepUsing: z.boolean().optional() }), req.body ?? {});
    const row = one<any>('SELECT valid FROM customer_api_keys WHERE user_id = ?', req.user!.id);
    if (!row?.valid) throw badRequest('Add and verify an API key first.');
    const { end } = currentPeriod(req.user!.companion_start);
    run('UPDATE customer_api_keys SET use_until = ?, keep_using = ?, updated_at = ? WHERE user_id = ?', end, keepUsing ? 1 : 0, nowIso(), req.user!.id);
    audit(req, 'apikey.activated', { type: 'user', id: req.user!.id }, { until: end, keepUsing: !!keepUsing });
    res.json({ usage: getUsageStatus(req.user!) });
  }),
);

/** POST /api/usage/api-key/deactivate - return to included usage now */
usageRouter.post(
  '/api-key/deactivate',
  wrap((req, res) => {
    run('UPDATE customer_api_keys SET use_until = NULL, keep_using = 0, updated_at = ? WHERE user_id = ?', nowIso(), req.user!.id);
    res.json({ usage: getUsageStatus(req.user!) });
  }),
);

/** DELETE /api/usage/api-key */
usageRouter.delete(
  '/api-key',
  wrap((req, res) => {
    run('DELETE FROM customer_api_keys WHERE user_id = ?', req.user!.id);
    audit(req, 'apikey.deleted', { type: 'user', id: req.user!.id });
    res.json({ usage: getUsageStatus(req.user!) });
  }),
);
