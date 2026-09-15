import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso } from '../../db/db.js';
import { notFound, parse, wrap } from '../../lib/http.js';
import { requireAdmin, requireSuperAdmin } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

export const adminMiscRouter = Router();

/** GET /api/admin/overview - counts for the dashboard (no private content) */
adminMiscRouter.get(
  '/overview',
  requireAdmin,
  wrap((_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const o = one<any>(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE status = 'active' AND role = 'student') AS activeStudents,
        (SELECT COUNT(*) FROM users WHERE status = 'active' AND companion_start IS NOT NULL
           AND companion_start <= ? AND (companion_end IS NULL OR companion_end >= ?)) AS companionActive,
        (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS suspended,
        (SELECT COUNT(*) FROM conversations WHERE is_temporary = 0) AS conversations,
        (SELECT COUNT(*) FROM usage_ledger WHERE status = 'completed' AND created_at >= date('now','-30 days')) AS replies30d,
        (SELECT ROUND(COALESCE(SUM(actual_cost),0),2) FROM usage_ledger WHERE status = 'completed' AND payment_source = 'included' AND created_at >= date('now','-30 days')) AS includedCost30d,
        (SELECT COUNT(*) FROM course_files WHERE status = 'indexed') AS indexedFiles,
        (SELECT COUNT(*) FROM privacy_requests WHERE status != 'closed') AS openPrivacyRequests`,
      today, today,
    );
    res.json({ overview: o });
  }),
);

/** GET /api/admin/audit?page= */
adminMiscRouter.get(
  '/audit',
  requireSuperAdmin,
  wrap((req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 100;
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? all('SELECT * FROM audit_log WHERE action LIKE ? OR actor_email LIKE ? OR target_id LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?', `%${q}%`, `%${q}%`, `%${q}%`, size, (page - 1) * size)
      : all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', size, (page - 1) * size);
    res.json({ entries: rows.map((r: any) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : null, details_json: undefined })) });
  }),
);

/** Privacy requests queue */
adminMiscRouter.get(
  '/privacy-requests',
  requireSuperAdmin,
  wrap((_req, res) => {
    const rows = all(
      `SELECT p.*, u.email AS user_email, u.name AS user_name FROM privacy_requests p JOIN users u ON u.id = p.user_id ORDER BY p.status = 'closed', p.due_at ASC`,
    );
    res.json({ requests: rows });
  }),
);

adminMiscRouter.patch(
  '/privacy-requests/:id',
  requireSuperAdmin,
  wrap((req, res) => {
    const r = one('SELECT id FROM privacy_requests WHERE id = ?', req.params.id);
    if (!r) throw notFound('Request not found.');
    const body = parse(z.object({ status: z.enum(['open', 'in_progress', 'closed']).optional(), adminNote: z.string().max(2000).optional() }), req.body);
    run('UPDATE privacy_requests SET status = COALESCE(?, status), admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?', body.status ?? null, body.adminNote ?? null, nowIso(), req.params.id);
    audit(req, 'privacy_request.updated', { type: 'privacy_request', id: req.params.id }, { status: body.status });
    res.json({ request: one('SELECT * FROM privacy_requests WHERE id = ?', req.params.id) });
  }),
);
