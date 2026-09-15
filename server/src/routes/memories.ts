import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso } from '../db/db.js';
import { notFound, parse, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { createMemory, updateMemoryContent, MEMORY_CATEGORIES } from '../lib/memory.js';

export const memoriesRouter = Router();
memoriesRouter.use(requireAuth);

const shape = (m: any) => ({
  id: m.id,
  category: m.category,
  content: m.content,
  status: m.status,
  sourceConversationId: m.source_conversation_id,
  sourceConversationTitle: m.source_title ?? null,
  sourceJournalId: m.source_journal_id,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const SELECT = `SELECT m.*, c.title AS source_title FROM memories m LEFT JOIN conversations c ON c.id = m.source_conversation_id`;

/** GET /api/memories?status=approved|pending|disabled */
memoriesRouter.get(
  '/',
  wrap((req, res) => {
    const status = String(req.query.status ?? '');
    const rows = status
      ? all(`${SELECT} WHERE m.user_id = ? AND m.status = ? ORDER BY m.updated_at DESC`, req.user!.id, status)
      : all(`${SELECT} WHERE m.user_id = ? AND m.status != 'rejected' ORDER BY m.status = 'pending' DESC, m.updated_at DESC`, req.user!.id);
    res.json({
      memories: rows.map(shape),
      memoryEnabledDefault: !!req.user!.memory_enabled_default,
    });
  }),
);

/** POST /api/memories - add manually (approved immediately) */
memoriesRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(z.object({ category: z.enum(MEMORY_CATEGORIES), content: z.string().min(3).max(400) }), req.body);
    const m = await createMemory(req.user!.id, { ...body, status: 'approved' });
    res.json({ memory: shape(m) });
  }),
);

/** PATCH /api/memories/:id - edit content/category, approve/reject/disable/enable */
memoriesRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const m = one<any>('SELECT * FROM memories WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!m) throw notFound('Memory not found.');
    const body = parse(
      z.object({
        content: z.string().min(3).max(400).optional(),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        status: z.enum(['approved', 'rejected', 'disabled']).optional(),
      }),
      req.body,
    );
    if (body.content !== undefined || body.category) await updateMemoryContent(m.id, body.content ?? m.content, body.category);
    if (body.status) run('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?', body.status, nowIso(), m.id);
    res.json({ memory: shape(one(`${SELECT} WHERE m.id = ?`, m.id)) });
  }),
);

/** DELETE /api/memories/:id */
memoriesRouter.delete(
  '/:id',
  wrap((req, res) => {
    const r = run('DELETE FROM memories WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!r.changes) throw notFound('Memory not found.');
    res.json({ ok: true });
  }),
);

/** DELETE /api/memories - clear all */
memoriesRouter.delete(
  '/',
  wrap((req, res) => {
    run('DELETE FROM memories WHERE user_id = ?', req.user!.id);
    res.json({ ok: true });
  }),
);

/** PATCH /api/memories/settings/default { enabled } - cross-chat memory default */
memoriesRouter.patch(
  '/settings/default',
  wrap((req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    run('UPDATE users SET memory_enabled_default = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, nowIso(), req.user!.id);
    res.json({ ok: true });
  }),
);
