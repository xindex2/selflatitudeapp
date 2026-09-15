import type { Request } from 'express';
import { run } from '../db/db.js';

/**
 * Record important administrator / security actions.
 * Never pass private chat, memory, or journal content in `details`.
 */
export function audit(
  req: Request | null,
  action: string,
  target?: { type: string; id?: string },
  details?: Record<string, unknown>,
) {
  const actor = req?.user;
  run(
    `INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, details_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    actor?.id ?? null,
    actor?.email ?? null,
    action,
    target?.type ?? null,
    target?.id ?? null,
    details ? JSON.stringify(details) : null,
    req?.ip ?? null,
  );
}
