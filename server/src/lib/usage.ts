import { all, getSetting, one, run, nowIso, txImmediate } from '../db/db.js';
import { DEFAULT_USAGE_SETTINGS, type UsageSettings } from './defaults.js';
import { newId } from './crypto.js';
import type { SessionUser } from '../middleware/auth.js';

/** Reply and cost limits for a user: personal override, then their plan, then the global setting. */
export function effectiveLimits(user: SessionUser): { repliesLimit: number; costLimit: number; planId: string | null } {
  const s = usageSettings();
  const plan = user.plan_id
    ? one<{ replies_per_period: number | null; cost_ceiling_usd: number | null }>(
        'SELECT replies_per_period, cost_ceiling_usd FROM plans WHERE id = ?', user.plan_id)
    : undefined;
  return {
    repliesLimit: user.reply_limit_override ?? plan?.replies_per_period ?? s.repliesPerPeriod,
    costLimit: user.cost_limit_override ?? plan?.cost_ceiling_usd ?? s.costCeilingUsd,
    planId: user.plan_id ?? null,
  };
}

export function usageSettings(): UsageSettings {
  return { ...DEFAULT_USAGE_SETTINGS, ...getSetting<Partial<UsageSettings>>('usage', {}) };
}

/**
 * Monthly usage period anchored on the companion activation date:
 * from the activation-day anniversary through the day before the next anniversary.
 */
export function currentPeriod(anchorIso: string | null, today = new Date()): { start: string; end: string } {
  const anchor = anchorIso ? new Date(anchorIso + 'T00:00:00Z') : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const day = anchor.getUTCDate();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  const clampDay = (yy: number, mm: number) => Math.min(day, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
  let start = new Date(Date.UTC(y, m, clampDay(y, m)));
  if (start > today) start = new Date(Date.UTC(y, m - 1, clampDay(y, m - 1)));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, clampDay(start.getUTCFullYear(), start.getUTCMonth() + 1)));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export interface UsageStatus {
  periodStart: string;
  periodEnd: string;          // next reset date
  repliesUsed: number;
  repliesLimit: number;
  repliesRemaining: number;
  costUsed: number;
  costLimit: number;
  costRemaining: number;
  includedExhausted: boolean;
  warning: 'none' | 'low' | 'very_low' | 'critical' | 'cost';
  paymentSource: 'included' | 'customer_key';
  customerKey: { last4: string; valid: boolean; activeUntil: string | null; keepUsing: boolean } | null;
}

export function getUsageStatus(user: SessionUser): UsageStatus {
  const s = usageSettings();
  const { start, end } = currentPeriod(user.companion_start);
  const agg = one<{ replies: number; cost: number; reserved: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS replies,
       COALESCE(SUM(CASE WHEN status='completed' THEN actual_cost ELSE 0 END),0) AS cost,
       COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_cost ELSE 0 END),0) AS reserved
     FROM usage_ledger WHERE user_id = ? AND period_start = ? AND payment_source = 'included'`,
    user.id,
    start,
  )!;
  const { repliesLimit, costLimit } = effectiveLimits(user);
  const reservedReplies = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id=? AND period_start=? AND payment_source='included' AND status='reserved'`,
    user.id, start,
  )!.n;
  const repliesRemaining = Math.max(0, repliesLimit - agg.replies - reservedReplies);
  const costUsed = agg.cost + agg.reserved;
  const costRemaining = Math.max(0, costLimit - costUsed);
  const includedExhausted = repliesRemaining <= 0 || costRemaining <= 0;

  const key = one<any>('SELECT last4, valid, use_until, keep_using FROM customer_api_keys WHERE user_id = ?', user.id);
  const today = new Date().toISOString().slice(0, 10);
  const keyActive = !!key && !!key.valid && (key.keep_using === 1 || (key.use_until != null && key.use_until > today));

  let warning: UsageStatus['warning'] = 'none';
  const [w1, w2, w3] = [...s.warnAtReplies].sort((a, b) => b - a);
  if (repliesRemaining <= (w3 ?? 5)) warning = 'critical';
  else if (repliesRemaining <= (w2 ?? 20)) warning = 'very_low';
  else if (repliesRemaining <= (w1 ?? 50)) warning = 'low';
  if (costUsed >= costLimit * s.warnAtCostFraction && warning === 'none') warning = 'cost';

  return {
    periodStart: start,
    periodEnd: end,
    repliesUsed: agg.replies,
    repliesLimit,
    repliesRemaining,
    costUsed: round(agg.cost),
    costLimit,
    costRemaining: round(costRemaining),
    includedExhausted,
    warning,
    paymentSource: keyActive ? 'customer_key' : 'included',
    customerKey: key
      ? { last4: key.last4, valid: !!key.valid, activeUntil: key.keep_using ? null : key.use_until, keepUsing: !!key.keep_using }
      : null,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Reserve included usage for a request. Runs inside a transaction so simultaneous
 * requests cannot exceed the reply or cost limit. Returns ledger id or null if exhausted.
 */
export function reserveIncluded(user: SessionUser, conversationId: string, modelId: string): string | null {
  const s = usageSettings();
  // Immediate transaction: take the write lock before reading, so two workers on the
  // same database file cannot both pass the limit check.
  return txImmediate(() => {
    const status = getUsageStatus(user);
    if (status.repliesRemaining <= 0) return null;
    // count reserved rows toward replies too
    const reserved = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id=? AND period_start=? AND payment_source='included' AND status='reserved'`,
      user.id,
      status.periodStart,
    )!.n;
    if (status.repliesUsed + reserved >= status.repliesLimit) return null;
    if (status.costRemaining < s.reserveEstimateUsd) return null;
    const id = newId('use');
    run(
      `INSERT INTO usage_ledger (id, user_id, period_start, period_end, conversation_id, model_id, payment_source, status, reserved_cost)
       VALUES (?, ?, ?, ?, ?, ?, 'included', 'reserved', ?)`,
      id,
      user.id,
      status.periodStart,
      status.periodEnd,
      conversationId,
      modelId,
      s.reserveEstimateUsd,
    );
    return id;
  });
}

export function recordCustomerKeyUsage(user: SessionUser, conversationId: string, modelId: string): string {
  const { start, end } = currentPeriod(user.companion_start);
  const id = newId('use');
  run(
    `INSERT INTO usage_ledger (id, user_id, period_start, period_end, conversation_id, model_id, payment_source, status, reserved_cost)
     VALUES (?, ?, ?, ?, ?, ?, 'customer_key', 'reserved', 0)`,
    id, user.id, start, end, conversationId, modelId,
  );
  return id;
}

export function completeUsage(ledgerId: string, messageId: string, inputTokens: number, outputTokens: number, cost: number) {
  run(
    `UPDATE usage_ledger SET status='completed', message_id=?, input_tokens=?, output_tokens=?, actual_cost=?, completed_at=? WHERE id=?`,
    messageId, inputTokens, outputTokens, cost, nowIso(), ledgerId,
  );
}

/** Only a still-reserved row may be released, so a late error cannot refund a completed reply. */
export function releaseUsage(ledgerId: string, failed = true) {
  run(`UPDATE usage_ledger SET status=?, completed_at=? WHERE id=? AND status='reserved'`, failed ? 'failed' : 'released', nowIso(), ledgerId);
}

/**
 * Reservations are only cleared by the request that made them, so a crash or redeploy
 * mid-reply would leave them counting against the student forever. Sweep them.
 */
export function sweepStaleReservations(olderThanMinutes = 15): number {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const r = run(
    `UPDATE usage_ledger SET status='released', completed_at=? WHERE status='reserved' AND created_at < ?`,
    nowIso(), cutoff,
  );
  return r.changes;
}

export function usageHistory(userId: string, limit = 12) {
  return all(
    `SELECT period_start, MAX(period_end) AS period_end, payment_source,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS replies,
            ROUND(COALESCE(SUM(CASE WHEN status='completed' THEN actual_cost END),0), 4) AS cost
     FROM usage_ledger WHERE user_id = ? GROUP BY period_start, payment_source ORDER BY period_start DESC LIMIT ?`,
    userId,
    limit,
  );
}
