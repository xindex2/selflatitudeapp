import { all, one, run, nowIso } from '../db/db.js';

export interface Plan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  durationMonths: number;   // 0 = does not expire
  grantsCourse: boolean;
  repliesPerPeriod: number | null;
  costCeilingUsd: number | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const planShape = (p: any): Plan => ({
  id: p.id,
  name: p.name,
  description: p.description,
  priceCents: p.price_cents,
  currency: p.currency,
  durationMonths: p.duration_months,
  grantsCourse: !!p.grants_course,
  repliesPerPeriod: p.replies_per_period,
  costCeilingUsd: p.cost_ceiling_usd,
  isDefault: !!p.is_default,
  active: !!p.active,
  sortOrder: p.sort_order,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export function listPlans(includeInactive = true): Plan[] {
  const rows = includeInactive
    ? all('SELECT * FROM plans ORDER BY sort_order, name')
    : all('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order, name');
  return rows.map(planShape);
}

export function getPlan(id: string | null | undefined): Plan | null {
  if (!id) return null;
  const p = one('SELECT * FROM plans WHERE id = ?', id);
  return p ? planShape(p) : null;
}

export function defaultPlan(): Plan | null {
  const p = one('SELECT * FROM plans WHERE is_default = 1 AND active = 1 ORDER BY sort_order LIMIT 1')
    ?? one('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order LIMIT 1');
  return p ? planShape(p) : null;
}

/** Add months to a date, clamping to the end of shorter months. Returns YYYY-MM-DD. */
export function addMonths(from: Date, months: number): string {
  const day = from.getUTCDate();
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Apply a plan to a user: set the plan, grant course access if the plan includes it,
 * and start or extend Companion access. Extending never shortens an existing end date.
 */
export function applyPlanToUser(userId: string, plan: Plan, mode: 'start' | 'extend'): { companionStart: string | null; companionEnd: string | null } {
  const u = one<any>('SELECT companion_start, companion_end FROM users WHERE id = ?', userId);
  if (!u) throw new Error('User not found');
  const now = new Date();
  const start = u.companion_start ?? today();

  const alreadyUnlimited = !!u.companion_start && u.companion_end === null;
  let end: string | null;
  if (plan.durationMonths <= 0) {
    end = null; // never expires
  } else if (mode === 'extend' && alreadyUnlimited) {
    end = null; // never shorten access that already has no expiry
  } else if (mode === 'extend' && u.companion_end && u.companion_end > today()) {
    end = addMonths(new Date(`${u.companion_end}T00:00:00Z`), plan.durationMonths);
  } else {
    end = addMonths(now, plan.durationMonths);
  }

  // Deliberately does not touch `status`: a purchase must never lift a suspension an
  // administrator applied. The payment is still recorded and shown in the admin area.
  run(
    `UPDATE users SET plan_id = ?, companion_start = ?, companion_end = ?,
       course_access = CASE WHEN ? = 1 THEN 1 ELSE course_access END,
       updated_at = ?
     WHERE id = ?`,
    plan.id, start, end, plan.grantsCourse ? 1 : 0, nowIso(), userId,
  );
  return { companionStart: start, companionEnd: end };
}

/** Take months off a date, clamping to the end of shorter months. Returns YYYY-MM-DD. */
export function subtractMonths(fromIsoDate: string, months: number): string {
  return addMonths(new Date(`${fromIsoDate}T00:00:00Z`), -months);
}

export interface Grant {
  months: number;        // 0 when the plan never expires
  unlimited: boolean;
  grantsCourse: boolean;
  planId: string | null;
}

/**
 * Undo a single purchase after a refund or chargeback: take back exactly the access it
 * granted, and nothing else. Other purchases the student made keep their time.
 *
 * `remaining` describes the student's other purchases that are still valid.
 */
export function reverseGrant(
  userId: string,
  grant: Grant,
  remaining: { hasOther: boolean; anyUnlimited: boolean; anyCourse: boolean; latestPlanId: string | null },
): { companionEnd: string | null; courseAccess: boolean } {
  const u = one<any>('SELECT companion_end, course_access, plan_id FROM users WHERE id = ?', userId);
  if (!u) throw new Error('User not found');
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  let end: string | null;
  if (!remaining.hasOther) {
    // Nothing else was ever paid for, so the refund leaves no access at all.
    end = yesterday;
  } else if (grant.unlimited || u.companion_end === null) {
    // A refunded never-expiring purchase ends access unless another one still covers them.
    end = remaining.anyUnlimited ? null : yesterday;
  } else {
    end = subtractMonths(u.companion_end, grant.months);
  }

  // Course access is lifetime, but a refunded course purchase takes it back unless
  // another purchase also granted it.
  const courseAccess = grant.grantsCourse && !remaining.anyCourse ? false : !!u.course_access;

  // Move them off the refunded plan.
  const planId = u.plan_id && u.plan_id === grant.planId ? remaining.latestPlanId : u.plan_id;

  run(
    'UPDATE users SET companion_end = ?, course_access = ?, plan_id = ?, updated_at = ? WHERE id = ?',
    end, courseAccess ? 1 : 0, planId, nowIso(), userId,
  );
  return { companionEnd: end, courseAccess };
}

/** End Companion access now. Used when a refund has no matching purchase to reverse. */
export function endCompanionAccess(userId: string, reason: string) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  run('UPDATE users SET companion_end = ?, notes = COALESCE(notes || char(10), \'\') || ?, updated_at = ? WHERE id = ?',
    yesterday, `${nowIso()}: ${reason}`, nowIso(), userId);
}
