import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso, tx } from '../db/db.js';
import { newId, verifyPassword } from '../lib/crypto.js';
import { badRequest, notFound, parse, wrap } from '../lib/http.js';
import { requireAuth, destroyAllSessions, destroySession } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { usageSettings } from '../lib/usage.js';
import { config } from '../config.js';

export const privacyRouter = Router();
privacyRouter.use(requireAuth);

/** GET /api/privacy - settings + consent record + open requests */
privacyRouter.get(
  '/',
  wrap((req, res) => {
    const u = one<any>('SELECT memory_enabled_default, journal_share_allowed, terms_version, privacy_version, consent_at, created_at FROM users WHERE id = ?', req.user!.id);
    const requests = all('SELECT id, kind, message, status, due_at, created_at FROM privacy_requests WHERE user_id = ? ORDER BY created_at DESC', req.user!.id);
    res.json({
      settings: { memoryEnabledDefault: !!u.memory_enabled_default, journalShareAllowed: !!u.journal_share_allowed },
      consent: { termsVersion: u.terms_version, privacyVersion: u.privacy_version, consentAt: u.consent_at, currentTerms: config.policyVersions.terms, currentPrivacy: config.policyVersions.privacy },
      requests,
    });
  }),
);

privacyRouter.patch(
  '/settings',
  wrap((req, res) => {
    const body = parse(z.object({ memoryEnabledDefault: z.boolean().optional(), journalShareAllowed: z.boolean().optional() }), req.body);
    run(
      `UPDATE users SET memory_enabled_default = COALESCE(?, memory_enabled_default), journal_share_allowed = COALESCE(?, journal_share_allowed), updated_at = ? WHERE id = ?`,
      body.memoryEnabledDefault == null ? null : body.memoryEnabledDefault ? 1 : 0,
      body.journalShareAllowed == null ? null : body.journalShareAllowed ? 1 : 0,
      nowIso(), req.user!.id,
    );
    res.json({ ok: true });
  }),
);

/** POST /api/privacy/requests */
privacyRouter.post(
  '/requests',
  wrap((req, res) => {
    const body = parse(z.object({ kind: z.enum(['access', 'correction', 'portability', 'deletion', 'consent', 'other']), message: z.string().max(2000).optional() }), req.body);
    const id = newId('prq');
    const due = new Date(Date.now() + usageSettings().privacyRequestDays * 86400_000).toISOString();
    run('INSERT INTO privacy_requests (id, user_id, kind, message, due_at) VALUES (?, ?, ?, ?, ?)', id, req.user!.id, body.kind, body.message ?? '', due);
    audit(req, 'privacy.request', { type: 'privacy_request', id }, { kind: body.kind });
    res.json({ request: one('SELECT id, kind, message, status, due_at, created_at FROM privacy_requests WHERE id = ?', id) });
  }),
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** GET /api/privacy/export/account.json - structured export of everything (never includes API key) */
privacyRouter.get(
  '/export/account.json',
  wrap((req, res) => {
    const uid = req.user!.id;
    const user = one<any>('SELECT id, email, name, role, created_at, companion_start, companion_end, terms_version, privacy_version, consent_at, memory_enabled_default, journal_share_allowed FROM users WHERE id = ?', uid);
    const conversations = all<any>('SELECT * FROM conversations WHERE user_id = ? AND is_temporary = 0', uid).map((c) => ({
      id: c.id, title: c.title, model: c.model_id, depth: c.depth, memoryEnabled: !!c.memory_enabled, archived: !!c.archived, createdAt: c.created_at, summary: c.summary,
      messages: all<any>('SELECT id, role, content, status, model_id, depth, prompt_version, sources_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at', c.id).map((m) => ({
        id: m.id, role: m.role, content: m.content, status: m.status, model: m.model_id, depth: m.depth, promptVersion: m.prompt_version, sources: m.sources_json ? JSON.parse(m.sources_json) : [], createdAt: m.created_at,
      })),
    }));
    const memories = all('SELECT id, category, content, status, source_conversation_id, created_at, updated_at FROM memories WHERE user_id = ?', uid);
    const journal = all('SELECT id, title, entry_date, content_html, content_text, created_at, updated_at FROM journal_entries WHERE user_id = ?', uid);
    const usage = all('SELECT period_start, period_end, model_id, payment_source, status, actual_cost, input_tokens, output_tokens, created_at FROM usage_ledger WHERE user_id = ?', uid);
    const requests = all('SELECT id, kind, message, status, due_at, created_at FROM privacy_requests WHERE user_id = ?', uid);
    audit(req, 'privacy.export', { type: 'user', id: uid });
    res.setHeader('Content-Disposition', `attachment; filename="selflatitude-account-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exportedAt: nowIso(), user, conversations, memories, journal, usage, privacyRequests: requests });
  }),
);

/** GET /api/privacy/export/conversations.md */
privacyRouter.get(
  '/export/conversations.md',
  wrap((req, res) => {
    const convs = all<any>('SELECT * FROM conversations WHERE user_id = ? AND is_temporary = 0 ORDER BY created_at', req.user!.id);
    const out: string[] = [`# SelfLatitude Companion - Conversations\n\nExported ${new Date().toISOString().slice(0, 10)}\n`];
    for (const c of convs) out.push(conversationMarkdown(c));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="selflatitude-conversations.md"`);
    res.send(out.join('\n\n---\n\n'));
  }),
);

/** GET /api/privacy/export/conversation/:id.md */
privacyRouter.get(
  '/export/conversation/:id.md',
  wrap((req, res) => {
    const c = one<any>('SELECT * FROM conversations WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
    if (!c) throw notFound('Conversation not found.');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${c.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'conversation'}.md"`);
    res.send(conversationMarkdown(c));
  }),
);

/** GET /api/privacy/export/journal.md */
privacyRouter.get(
  '/export/journal.md',
  wrap((req, res) => {
    const entries = all<any>('SELECT * FROM journal_entries WHERE user_id = ? ORDER BY entry_date', req.user!.id);
    const md = [`# SelfLatitude Journal\n`, ...entries.map((e) => `## ${e.title || 'Untitled entry'}\n\n_${e.entry_date}_\n\n${e.content_text}\n`)].join('\n');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="selflatitude-journal.md"`);
    res.send(md);
  }),
);

function conversationMarkdown(c: any) {
  const msgs = all<any>('SELECT role, content, created_at, sources_json FROM messages WHERE conversation_id = ? AND status != ? ORDER BY created_at', c.id, 'failed');
  const lines = [`## ${c.title}\n\n_Started ${c.created_at.slice(0, 10)} · ${c.model_id} · ${c.depth}_\n`];
  if (c.summary) lines.push(`**Summary**\n\n${c.summary}\n`);
  for (const m of msgs) {
    lines.push(`**${m.role === 'user' ? 'You' : 'Companion'}** · ${m.created_at.slice(0, 16).replace('T', ' ')}\n\n${m.content}\n`);
    const src = m.sources_json ? JSON.parse(m.sources_json) : [];
    if (src.length) lines.push(`_Course references: ${src.map((s: any) => [s.module, s.section].filter(Boolean).join(' - ') || s.title).join('; ')}_\n`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** POST /api/privacy/delete-all { what: 'conversations'|'memories'|'journal' } */
privacyRouter.post(
  '/delete-all',
  wrap((req, res) => {
    const { what } = parse(z.object({ what: z.enum(['conversations', 'memories', 'journal']) }), req.body);
    const table = { conversations: 'conversations', memories: 'memories', journal: 'journal_entries' }[what];
    run(`DELETE FROM ${table} WHERE user_id = ?`, req.user!.id);
    audit(req, `privacy.delete_all_${what}`, { type: 'user', id: req.user!.id });
    res.json({ ok: true });
  }),
);

/** POST /api/privacy/delete-account { password } - permanent */
privacyRouter.post(
  '/delete-account',
  wrap(async (req, res) => {
    const { password, confirm } = parse(z.object({ password: z.string(), confirm: z.literal('DELETE') }), req.body);
    const u = one<any>('SELECT password_hash, role FROM users WHERE id = ?', req.user!.id);
    if (u.role === 'superadmin') throw badRequest('Super Admin accounts cannot self-delete. Ask another Super Admin.');
    if (!(await verifyPassword(u.password_hash, password))) throw badRequest('Password is incorrect.');
    const uid = req.user!.id;
    tx(() => {
      // Cascades remove conversations, messages, memories, journal, usage, keys, sessions, tokens.
      run('DELETE FROM conversations WHERE user_id = ?', uid);
      run('DELETE FROM memories WHERE user_id = ?', uid);
      run('DELETE FROM journal_entries WHERE user_id = ?', uid);
      run('DELETE FROM customer_api_keys WHERE user_id = ?', uid);
      run('DELETE FROM usage_ledger WHERE user_id = ?', uid);
      run('DELETE FROM auth_tokens WHERE user_id = ?', uid);
      run('DELETE FROM privacy_requests WHERE user_id = ?', uid);
      // Keep a tombstone row (no personal data) so audit references stay consistent.
      run(
        `UPDATE users SET email = ?, name = '', password_hash = NULL, status = 'deleted', mfa_secret_enc = NULL, mfa_enabled = 0, companion_start = NULL, companion_end = NULL, updated_at = ? WHERE id = ?`,
        `deleted-${uid}@deleted.invalid`, nowIso(), uid,
      );
      destroyAllSessions(uid);
    });
    audit(req, 'user.self_delete', { type: 'user', id: uid });
    destroySession(res);
    res.json({ ok: true });
  }),
);
