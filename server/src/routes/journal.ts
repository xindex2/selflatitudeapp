import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso } from '../db/db.js';
import { newId } from '../lib/crypto.js';
import { notFound, parse, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';

export const journalRouter = Router();
journalRouter.use(requireAuth);

const shape = (e: any) => ({
  id: e.id,
  title: e.title,
  entryDate: e.entry_date,
  contentHtml: e.content_html,
  wordCount: e.word_count,
  createdAt: e.created_at,
  updatedAt: e.updated_at,
});

/** Basic HTML sanitizer for the editor: allow a small tag whitelist, strip attributes. */
export function sanitizeHtml(html: string): string {
  const allowed = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'div']);
  return html
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*([a-zA-Z0-9]+)[^>]*>/g, (tag, name: string) => {
      const n = name.toLowerCase();
      if (!allowed.has(n)) return '';
      const closing = /^<\s*\//.test(tag);
      return closing ? `</${n}>` : n === 'br' || n === 'hr' ? `<${n}>` : `<${n}>`;
    });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** GET /api/journal?month=YYYY-MM  (list; month optional -> all) */
journalRouter.get(
  '/',
  wrap((req, res) => {
    const month = String(req.query.month ?? '');
    const rows = /^\d{4}-\d{2}$/.test(month)
      ? all(`SELECT id, title, entry_date, word_count, created_at, updated_at FROM journal_entries WHERE user_id = ? AND entry_date LIKE ? ORDER BY entry_date DESC, updated_at DESC`, req.user!.id, `${month}%`)
      : all(`SELECT id, title, entry_date, word_count, created_at, updated_at FROM journal_entries WHERE user_id = ? ORDER BY entry_date DESC, updated_at DESC LIMIT 500`, req.user!.id);
    // dates that have entries (for calendar dots)
    const dates = all<{ d: string }>(`SELECT DISTINCT entry_date AS d FROM journal_entries WHERE user_id = ?`, req.user!.id).map((r) => r.d);
    res.json({ entries: rows.map((e) => ({ ...shape(e), contentHtml: undefined })), dates });
  }),
);

/** POST /api/journal */
journalRouter.post(
  '/',
  wrap((req, res) => {
    const body = parse(z.object({ entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), title: z.string().max(200).optional() }), req.body ?? {});
    const id = newId('jrn');
    run(
      `INSERT INTO journal_entries (id, user_id, title, entry_date) VALUES (?, ?, ?, ?)`,
      id, req.user!.id, body.title ?? '', body.entryDate ?? new Date().toISOString().slice(0, 10),
    );
    res.json({ entry: shape(one('SELECT * FROM journal_entries WHERE id = ?', id)) });
  }),
);

journalRouter.get(
  '/:id',
  wrap((req, res) => {
    const e = one('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!e) throw notFound('Entry not found.');
    res.json({ entry: shape(e) });
  }),
);

/** PATCH /api/journal/:id - autosave */
journalRouter.patch(
  '/:id',
  wrap((req, res) => {
    const e = one<any>('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!e) throw notFound('Entry not found.');
    const body = parse(
      z.object({ title: z.string().max(200).optional(), entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), contentHtml: z.string().max(500_000).optional() }),
      req.body,
    );
    const html = body.contentHtml !== undefined ? sanitizeHtml(body.contentHtml) : e.content_html;
    const text = htmlToText(html);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    run(
      `UPDATE journal_entries SET title = COALESCE(?, title), entry_date = COALESCE(?, entry_date), content_html = ?, content_text = ?, word_count = ?, updated_at = ? WHERE id = ?`,
      body.title ?? null, body.entryDate ?? null, html, text, words, nowIso(), e.id,
    );
    res.json({ entry: shape(one('SELECT * FROM journal_entries WHERE id = ?', e.id)) });
  }),
);

journalRouter.delete(
  '/:id',
  wrap((req, res) => {
    const r = run('DELETE FROM journal_entries WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!r.changes) throw notFound('Entry not found.');
    res.json({ ok: true });
  }),
);

/** GET /api/journal/:id/download?format=md|txt */
journalRouter.get(
  '/:id/download',
  wrap((req, res) => {
    const e = one<any>('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!e) throw notFound('Entry not found.');
    const md = `# ${e.title || 'Untitled entry'}\n\n_${e.entry_date}_\n\n${e.content_text}\n`;
    const name = `${e.entry_date}-${(e.title || 'entry').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(md);
  }),
);
