import { Router } from 'express';
import { z } from 'zod';
import { one, run, all, nowIso, tx } from '../../db/db.js';
import { badRequest, notFound, parse, wrap } from '../../lib/http.js';
import { requireAdmin, requireSuperAdmin } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { listPlans, getPlan, planShape, applyPlanToUser } from '../../lib/plans.js';

export const adminPlansRouter = Router();

const planBody = z.object({
  id: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens.').optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: z.string().min(3).max(3).default('USD'),
  durationMonths: z.number().int().min(0).max(600),
  grantsCourse: z.boolean().default(true),
  repliesPerPeriod: z.number().int().min(0).max(1_000_000).nullable().default(null),
  costCeilingUsd: z.number().min(0).max(10_000).nullable().default(null),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

/** GET /api/admin/plans - with how many users are on each plan. */
adminPlansRouter.get(
  '/',
  requireAdmin,
  wrap((_req, res) => {
    const counts = all<{ plan_id: string; n: number }>(
      `SELECT plan_id, COUNT(*) AS n FROM users WHERE status != 'deleted' AND plan_id IS NOT NULL GROUP BY plan_id`,
    );
    const map = Object.fromEntries(counts.map((c) => [c.plan_id, c.n]));
    res.json({ plans: listPlans().map((p) => ({ ...p, userCount: map[p.id] ?? 0 })) });
  }),
);

adminPlansRouter.post(
  '/',
  requireSuperAdmin,
  wrap((req, res) => {
    const b = parse(planBody, req.body);
    const id = (b.id ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 60);
    if (!id) throw badRequest('Give the plan a name that contains letters or numbers.');
    if (one('SELECT id FROM plans WHERE id = ?', id)) throw badRequest('A plan with that id already exists.');
    tx(() => {
      if (b.isDefault) run('UPDATE plans SET is_default = 0');
      run(
        `INSERT INTO plans (id, name, description, price_cents, currency, duration_months, grants_course, replies_per_period, cost_ceiling_usd, is_default, active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, b.name, b.description, b.priceCents, b.currency.toUpperCase(), b.durationMonths,
        b.grantsCourse ? 1 : 0, b.repliesPerPeriod, b.costCeilingUsd, b.isDefault ? 1 : 0, b.active ? 1 : 0, b.sortOrder,
      );
    });
    audit(req, 'plan.created', { type: 'plan', id }, { name: b.name });
    res.json({ plan: getPlan(id) });
  }),
);

adminPlansRouter.put(
  '/:id',
  requireSuperAdmin,
  wrap((req, res) => {
    const existing = getPlan(req.params.id);
    if (!existing) throw notFound('Plan not found.');
    const b = parse(planBody, req.body);
    tx(() => {
      if (b.isDefault) run('UPDATE plans SET is_default = 0');
      run(
        `UPDATE plans SET name=?, description=?, price_cents=?, currency=?, duration_months=?, grants_course=?,
           replies_per_period=?, cost_ceiling_usd=?, is_default=?, active=?, sort_order=?, updated_at=? WHERE id=?`,
        b.name, b.description, b.priceCents, b.currency.toUpperCase(), b.durationMonths, b.grantsCourse ? 1 : 0,
        b.repliesPerPeriod, b.costCeilingUsd, b.isDefault ? 1 : 0, b.active ? 1 : 0, b.sortOrder, nowIso(), existing.id,
      );
    });
    audit(req, 'plan.updated', { type: 'plan', id: existing.id });
    res.json({ plan: getPlan(existing.id) });
  }),
);

adminPlansRouter.delete(
  '/:id',
  requireSuperAdmin,
  wrap((req, res) => {
    const p = getPlan(req.params.id);
    if (!p) throw notFound('Plan not found.');
    const inUse = one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE plan_id = ?', p.id)!.n;
    if (inUse > 0) throw badRequest(`${inUse} user(s) are on this plan. Move them to another plan first, or mark this plan inactive instead.`);
    run('DELETE FROM plans WHERE id = ?', p.id);
    audit(req, 'plan.deleted', { type: 'plan', id: p.id });
    res.json({ ok: true });
  }),
);

/** POST /api/admin/plans/:id/assign { userId, mode } - put a user on a plan and grant access. */
adminPlansRouter.post(
  '/:id/assign',
  requireSuperAdmin,
  wrap((req, res) => {
    const plan = getPlan(req.params.id);
    if (!plan) throw notFound('Plan not found.');
    const { userId, mode } = parse(z.object({ userId: z.string(), mode: z.enum(['start', 'extend']).default('extend') }), req.body);
    const u = one('SELECT id FROM users WHERE id = ? AND status != ?', userId, 'deleted');
    if (!u) throw notFound('User not found.');
    const r = applyPlanToUser(userId, plan, mode);
    audit(req, 'plan.assigned', { type: 'user', id: userId }, { plan: plan.id, mode });
    res.json({ ...r, planId: plan.id });
  }),
);

export { planShape };
