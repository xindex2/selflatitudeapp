import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, nowIso, tx } from '../db/db.js';
import { newId } from '../lib/crypto.js';
import { badRequest, notFound, parse, wrap, HttpError } from '../lib/http.js';
import { requireAuth, requireCompanion } from '../middleware/auth.js';
import { getPublished, defaultModelId, studentModels } from '../lib/companion.js';
import { runChat, summarizeConversation, assertCanSend } from '../lib/chat.js';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

const depthSchema = z.enum(['fast', 'medium', 'extended']);

function ownConversation(userId: string, id: string) {
  const c = one<any>('SELECT * FROM conversations WHERE id = ? AND user_id = ?', id, userId);
  if (!c) throw notFound('Conversation not found.');
  return c;
}

const listShape = (c: any) => ({
  id: c.id,
  title: c.title,
  modelId: c.model_id,
  depth: c.depth,
  memoryEnabled: !!c.memory_enabled,
  isTemporary: !!c.is_temporary,
  archived: !!c.archived,
  lastMessageAt: c.last_message_at,
  createdAt: c.created_at,
  hasSummary: !!c.summary,
});

/** GET /api/conversations?archived=0&q= */
conversationsRouter.get(
  '/',
  wrap((req, res) => {
    const archived = req.query.archived === '1' ? 1 : 0;
    const q = String(req.query.q ?? '').trim();
    let rows: any[];
    if (q) {
      rows = all(
        `SELECT DISTINCT c.* FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.user_id = ? AND c.is_temporary = 0 AND c.archived = ? AND (c.title LIKE ? OR m.content LIKE ?)
         ORDER BY c.last_message_at DESC, c.created_at DESC LIMIT 100`,
        req.user!.id, archived, `%${q}%`, `%${q}%`,
      );
    } else {
      rows = all(
        `SELECT * FROM conversations WHERE user_id = ? AND is_temporary = 0 AND archived = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 200`,
        req.user!.id, archived,
      );
    }
    res.json({ conversations: rows.map(listShape) });
  }),
);

/** POST /api/conversations */
conversationsRouter.post(
  '/',
  requireCompanion,
  wrap((req, res) => {
    const cfg = getPublished();
    const body = parse(
      z.object({
        modelId: z.string().optional(),
        depth: depthSchema.optional(),
        memoryEnabled: z.boolean().optional(),
        isTemporary: z.boolean().optional(),
        title: z.string().max(120).optional(),
      }),
      req.body ?? {},
    );
    const models = studentModels(cfg);
    const modelId = body.modelId && models.some((m) => m.id === body.modelId) ? body.modelId : defaultModelId(cfg);
    const id = newId('cnv');
    const temp = !!body.isTemporary;
    run(
      `INSERT INTO conversations (id, user_id, title, title_auto, model_id, depth, memory_enabled, is_temporary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.user!.id, body.title ?? (temp ? 'Temporary chat' : 'New conversation'), body.title ? 0 : 1,
      modelId, body.depth ?? 'medium',
      temp ? 0 : (body.memoryEnabled ?? !!req.user!.memory_enabled_default) ? 1 : 0,
      temp ? 1 : 0,
    );
    res.json({ conversation: listShape(one('SELECT * FROM conversations WHERE id = ?', id)) });
  }),
);

/** GET /api/conversations/:id */
conversationsRouter.get(
  '/:id',
  wrap((req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    const messages = all<any>(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`, c.id).map(msgShape);
    res.json({ conversation: { ...listShape(c), summary: c.summary }, messages });
  }),
);

export function msgShape(m: any) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    modelId: m.model_id,
    depth: m.depth,
    promptVersion: m.prompt_version,
    sources: m.sources_json ? JSON.parse(m.sources_json) : [],
    attachments: m.attachments_json ? JSON.parse(m.attachments_json).map((a: any) => ({ type: a.type, entryId: a.entryId, title: a.title })) : [],
    paymentSource: m.payment_source,
    error: m.error,
    createdAt: m.created_at,
  };
}

/** PATCH /api/conversations/:id - rename, archive, change model/depth/memory */
conversationsRouter.patch(
  '/:id',
  wrap((req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    const body = parse(
      z.object({
        title: z.string().min(1).max(120).optional(),
        archived: z.boolean().optional(),
        modelId: z.string().optional(),
        depth: depthSchema.optional(),
        memoryEnabled: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.modelId) {
      const models = studentModels(getPublished());
      if (!models.some((m) => m.id === body.modelId)) throw badRequest('That model is not available.');
    }
    run(
      `UPDATE conversations SET
         title = COALESCE(?, title), title_auto = CASE WHEN ? IS NULL THEN title_auto ELSE 0 END,
         archived = COALESCE(?, archived), model_id = COALESCE(?, model_id), depth = COALESCE(?, depth),
         memory_enabled = CASE WHEN is_temporary = 1 THEN 0 ELSE COALESCE(?, memory_enabled) END,
         updated_at = ?
       WHERE id = ?`,
      body.title ?? null, body.title ?? null,
      body.archived == null ? null : body.archived ? 1 : 0,
      body.modelId ?? null, body.depth ?? null,
      body.memoryEnabled == null ? null : body.memoryEnabled ? 1 : 0,
      nowIso(), c.id,
    );
    res.json({ conversation: listShape(one('SELECT * FROM conversations WHERE id = ?', c.id)) });
  }),
);

/** DELETE /api/conversations/:id */
conversationsRouter.delete(
  '/:id',
  wrap((req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    run('DELETE FROM conversations WHERE id = ?', c.id);
    res.json({ ok: true });
  }),
);

/**
 * Remove a reply that is about to be regenerated, along with any memory it proposed, and
 * release the usage it consumed so regenerating does not charge the student twice.
 */
export function supersedeAssistantMessage(messageId: string) {
  tx(() => {
    run('DELETE FROM memories WHERE source_message_id = ? AND status = ?', messageId, 'pending');
    run(`UPDATE usage_ledger SET status = 'released', completed_at = ? WHERE message_id = ? AND status = 'completed'`, nowIso(), messageId);
    run('DELETE FROM messages WHERE id = ?', messageId);
  });
}

/** In-flight abort controllers keyed by conversation id so the student can press Stop. */
const inflight = new Map<string, AbortController>();

const attachmentSchema = z.object({ type: z.literal('journal'), entryId: z.string() });

/**
 * POST /api/conversations/:id/messages  { content, attachments? }
 * Streams Server-Sent Events: meta, delta, title, done
 */
conversationsRouter.post(
  '/:id/messages',
  requireCompanion,
  wrap(async (req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    const body = parse(
      z.object({ content: z.string().min(1).max(20000), attachments: z.array(attachmentSchema).max(3).optional() }),
      req.body,
    );
    if (inflight.has(c.id)) throw badRequest('A reply is already being generated for this conversation.', 'busy');
    assertCanSend(req.user!, c.model_id); // reject before saving the message (JSON error, not SSE)

    // Resolve journal attachments (explicit student action only)
    const attachments: { type: 'journal'; entryId: string; title: string; text: string }[] = [];
    for (const a of body.attachments ?? []) {
      if (!req.user!.journal_share_allowed) throw badRequest('Journal sharing with the Companion is turned off in your privacy settings.');
      const e = one<any>('SELECT id, title, content_text FROM journal_entries WHERE id = ? AND user_id = ?', a.entryId, req.user!.id);
      if (!e) throw notFound('Journal entry not found.');
      attachments.push({ type: 'journal', entryId: e.id, title: e.title || 'Untitled entry', text: e.content_text.slice(0, 12000) });
    }

    const userMessageId = newId('msg');
    run(
      `INSERT INTO messages (id, conversation_id, role, content, status, attachments_json) VALUES (?, ?, 'user', ?, 'complete', ?)`,
      userMessageId, c.id, body.content, attachments.length ? JSON.stringify(attachments) : null,
    );
    run('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), c.id);

    await stream(req, res, c, userMessageId, attachments);
  }),
);

/** POST /api/conversations/:id/regenerate - re-run the last assistant reply (does not double count) */
conversationsRouter.post(
  '/:id/regenerate',
  requireCompanion,
  wrap(async (req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    if (inflight.has(c.id)) throw badRequest('A reply is already being generated for this conversation.', 'busy');
    // Check before destroying anything, so a refused request never loses the existing reply.
    assertCanSend(req.user!, c.model_id);
    const last = one<any>(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, c.id);
    if (!last) throw badRequest('Nothing to regenerate yet.');
    if (last.role === 'assistant') supersedeAssistantMessage(last.id);
    const lastUser = one<any>(`SELECT * FROM messages WHERE conversation_id = ? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1`, c.id);
    if (!lastUser) throw badRequest('Nothing to regenerate yet.');
    const attachments = lastUser.attachments_json ? JSON.parse(lastUser.attachments_json) : [];
    await stream(req, res, c, lastUser.id, attachments, true);
  }),
);

/** POST /api/conversations/:id/stop */
conversationsRouter.post(
  '/:id/stop',
  wrap((req, res) => {
    ownConversation(req.user!.id, req.params.id);
    inflight.get(req.params.id)?.abort();
    res.json({ ok: true });
  }),
);

/** POST /api/conversations/:id/summary - concise summary to continue elsewhere */
conversationsRouter.post(
  '/:id/summary',
  requireCompanion,
  wrap(async (req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    const summary = await summarizeConversation(req.user!, c.id);
    res.json({ summary });
  }),
);

/** POST /api/conversations/:id/continue - start a new conversation seeded with the summary */
conversationsRouter.post(
  '/:id/continue',
  requireCompanion,
  wrap(async (req, res) => {
    const c = ownConversation(req.user!.id, req.params.id);
    const summary = c.summary || (await summarizeConversation(req.user!, c.id));
    const id = newId('cnv');
    run(
      `INSERT INTO conversations (id, user_id, title, title_auto, model_id, depth, memory_enabled, is_temporary, summary)
       VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?)`,
      id, req.user!.id, `${c.title} (continued)`, c.model_id, c.depth, c.memory_enabled, summary,
    );
    res.json({ conversation: listShape(one('SELECT * FROM conversations WHERE id = ?', id)) });
  }),
);

async function stream(req: any, res: any, c: any, userMessageId: string, attachments: any[], regenerate = false) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const ac = new AbortController();
  inflight.set(c.id, ac);
  req.on('close', () => ac.abort());
  try {
    await runChat(res, { user: req.user, conversation: c, userMessageId, attachments, regenerate }, ac.signal);
  } catch (e: any) {
    // Errors before streaming started (e.g. usage exhausted) are sent as an SSE error event
    // Only explicit HttpErrors carry a message meant for the student; anything else is
    // an internal fault and must not leak its text.
    const known = e instanceof HttpError;
    if (!known) console.error('chat stream failed', e);
    const status = known ? e.status : 500;
    const payload = known
      ? { error: e.message, code: e.code, status, ...(e.extra ?? {}) }
      : { error: 'The Companion could not complete this reply. Please try again.', code: 'server_error', status };
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    }
  } finally {
    inflight.delete(c.id);
  }
}
