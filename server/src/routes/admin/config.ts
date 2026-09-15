import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, nowIso, getSetting, setSetting } from '../../db/db.js';
import { config } from '../../config.js';
import { newId } from '../../lib/crypto.js';
import { badRequest, notFound, parse, wrap } from '../../lib/http.js';
import { requireAdmin } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import {
  getPublished, getDraft, ensureDraft, updateDraft, publishDraft, discardDraft, restoreVersionAsDraft, listVersions, getVersion,
} from '../../lib/companion.js';
import { indexFile, forgetCachedEmbeddings } from '../../lib/retrieval.js';
import { runChat, isReasoningModel } from '../../lib/chat.js';
import { usageSettings } from '../../lib/usage.js';
import { DEFAULT_USAGE_SETTINGS } from '../../lib/defaults.js';
import { platformClient, platformKey, testApiKey, PLATFORM_KEY_SETTING, type PlatformKeySetting } from '../../lib/openai.js';
import { requireSuperAdmin } from '../../middleware/auth.js';
import { encrypt } from '../../lib/crypto.js';

export const adminConfigRouter = Router();
adminConfigRouter.use(requireAdmin);

// ---------------------------------------------------------------------------
// Companion configuration: draft / publish / versions
// ---------------------------------------------------------------------------
adminConfigRouter.get(
  '/companion',
  wrap((_req, res) => {
    res.json({ published: getPublished(), draft: getDraft(), versions: listVersions() });
  }),
);

const modelSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(60),
  included: z.boolean(),
  isDefault: z.boolean().optional(),
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
  enabled: z.boolean(),
});
const depthSchema = z.object({ label: z.string().min(1).max(30), maxOutputTokens: z.number().int().min(50).max(16000), instruction: z.string().max(2000), reasoning: z.enum(['minimal', 'low', 'medium', 'high']).optional() });

adminConfigRouter.put(
  '/companion/draft',
  wrap((req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(1000).optional(),
        instructions: z.string().max(40000).optional(),
        safetyRules: z.string().max(20000).optional(),
        starters: z.array(z.object({ title: z.string().min(1).max(80), prompt: z.string().min(1).max(1000) })).max(12).optional(),
        models: z.array(modelSchema).min(1).max(20).optional(),
        depth: z.object({ fast: depthSchema, medium: depthSchema, extended: depthSchema }).optional(),
        fileIds: z.array(z.string()).optional(),
      }),
      req.body,
    );
    if (body.models && !body.models.some((m) => m.enabled)) throw badRequest('At least one model must be enabled.');
    const draft = updateDraft(body as any);
    res.json({ draft });
  }),
);

adminConfigRouter.post(
  '/companion/draft',
  wrap((_req, res) => {
    res.json({ draft: ensureDraft() });
  }),
);

adminConfigRouter.delete(
  '/companion/draft',
  wrap((req, res) => {
    discardDraft();
    audit(req, 'companion.draft_discarded');
    res.json({ ok: true });
  }),
);

adminConfigRouter.post(
  '/companion/publish',
  wrap((req, res) => {
    if (!getDraft()) throw badRequest('There is no draft to publish.');
    const v = publishDraft(req.user!.email);
    audit(req, 'companion.published', { type: 'companion_version', id: String(v.id) }, { version: v.versionNumber });
    res.json({ published: v, versions: listVersions() });
  }),
);

adminConfigRouter.post(
  '/companion/versions/:id/restore',
  wrap((req, res) => {
    const v = getVersion(Number(req.params.id));
    if (!v) throw notFound('Version not found.');
    const draft = restoreVersionAsDraft(v.id);
    audit(req, 'companion.restored_to_draft', { type: 'companion_version', id: String(v.id) }, { fromVersion: v.versionNumber, draftVersion: draft.versionNumber });
    res.json({ draft });
  }),
);

adminConfigRouter.get(
  '/companion/versions/:id',
  wrap((req, res) => {
    const v = getVersion(Number(req.params.id));
    if (!v) throw notFound('Version not found.');
    res.json({ version: v });
  }),
);

/**
 * POST /api/admin/companion/preview  { messages:[{role,content}], modelId?, depth?, memoryEnabled? }
 * Test-chat against the current draft. Not metered, not saved.
 */
adminConfigRouter.post(
  '/companion/preview',
  wrap(async (req, res) => {
    const draft = getDraft() ?? getPublished();
    const body = parse(
      z.object({
        messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000) })).min(1).max(40),
        modelId: z.string().optional(),
        depth: z.enum(['fast', 'medium', 'extended']).optional(),
      }),
      req.body,
    );
    // Build a throwaway conversation in a temp table-less fashion: we insert a hidden temporary conversation for the admin
    const cid = newId('cnv');
    run(`INSERT INTO conversations (id, user_id, title, model_id, depth, memory_enabled, is_temporary) VALUES (?, ?, 'Owner preview', ?, ?, 0, 1)`, cid, req.user!.id, body.modelId ?? draft.models.find((m) => m.enabled)?.id ?? 'gpt-4.1-mini', body.depth ?? 'medium');
    for (const m of body.messages) run(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`, newId('msg'), cid, m.role, m.content);
    const conversation = one<any>('SELECT * FROM conversations WHERE id = ?', cid);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      await runChat(res, { user: req.user!, conversation, userMessageId: '', previewConfig: draft }, ac.signal);
    } catch (e: any) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message ?? 'Preview failed.' })}\n\n`);
      res.end();
    } finally {
      run('DELETE FROM conversations WHERE id = ?', cid);
    }
  }),
);

// ---------------------------------------------------------------------------
// OpenAI platform connection (SelfLatitude's own key). Owner can see status;
// only a Super Admin (MFA) can change it. The key is encrypted and never returned.
// ---------------------------------------------------------------------------
adminConfigRouter.get(
  '/openai/key',
  wrap((_req, res) => {
    const saved = getSetting<PlatformKeySetting | null>(PLATFORM_KEY_SETTING, null);
    const k = platformKey();
    res.json({
      configured: !!k,
      source: k?.source ?? null,
      last4: saved?.last4 ?? (k?.source === 'env' ? k.key.slice(-4) : null),
      validatedAt: saved?.validatedAt ?? null,
      setBy: saved?.setBy ?? null,
    });
  }),
);

adminConfigRouter.put(
  '/openai/key',
  requireSuperAdmin,
  wrap(async (req, res) => {
    const { apiKey } = parse(z.object({ apiKey: z.string().min(20).max(300) }), req.body);
    const key = apiKey.trim();
    if (!/^sk-/.test(key)) throw badRequest('That does not look like an OpenAI API key (they start with "sk-").');
    const err = await testApiKey(key);
    if (err) throw badRequest(err, 'key_invalid');
    setSetting(PLATFORM_KEY_SETTING, { enc: encrypt(key), last4: key.slice(-4), validatedAt: nowIso(), setBy: req.user!.email } satisfies PlatformKeySetting);
    audit(req, 'settings.openai_key_set', undefined, { last4: key.slice(-4) });
    res.json({ configured: true, source: 'settings', last4: key.slice(-4), validatedAt: nowIso(), setBy: req.user!.email });
  }),
);

adminConfigRouter.post(
  '/openai/key/test',
  wrap(async (_req, res) => {
    const k = platformKey();
    if (!k) throw badRequest('No OpenAI key is configured.');
    const err = await testApiKey(k.key);
    res.json({ ok: !err, error: err });
  }),
);

adminConfigRouter.delete(
  '/openai/key',
  requireSuperAdmin,
  wrap((req, res) => {
    run('DELETE FROM settings WHERE key = ?', PLATFORM_KEY_SETTING);
    audit(req, 'settings.openai_key_removed');
    res.json({ configured: !!platformKey(), source: platformKey()?.source ?? null });
  }),
);

/**
 * GET /api/admin/openai/models - live list of chat-capable models from the OpenAI API
 * (uses SelfLatitude's platform key). Lets the owner pick the newest models without a deploy.
 */
adminConfigRouter.get(
  '/openai/models',
  wrap(async (_req, res) => {
    const client = platformClient();
    const list = await client.models.list();
    const exclude = /embedding|tts|whisper|transcribe|audio|realtime|dall-e|image|moderation|search|davinci|babbage|instruct|computer-use|codex|deep-research|sora/i;
    const models = list.data
      .filter((m) => /^(gpt-|o[1-9]|chatgpt)/.test(m.id) && !exclude.test(m.id))
      .map((m) => ({ id: m.id, created: m.created, reasoning: isReasoningModel(m.id) }))
      .sort((a, b) => b.created - a.created);
    res.json({ models });
  }),
);

// ---------------------------------------------------------------------------
// Course files
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => {
      // Derive the extension ourselves; never let a filename decide what lands on disk.
      const ext = (path.extname(file.originalname).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? [''])[0];
      cb(null, `${newId('file')}${ext}`);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pdf|txt|md|markdown|docx|html?)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only PDF, DOCX, TXT, Markdown, and HTML files are supported.')); cb(null, true);
  },
});

const fileShape = (f: any) => ({
  id: f.id, title: f.title, moduleLabel: f.module_label, originalName: f.original_name, mimeType: f.mime_type, sizeBytes: f.size_bytes,
  sortOrder: f.sort_order, status: f.status, chunkCount: f.chunk_count, error: f.error, createdAt: f.created_at, updatedAt: f.updated_at,
});

adminConfigRouter.get(
  '/files',
  wrap((_req, res) => {
    res.json({ files: all(`SELECT * FROM course_files WHERE status != 'removed' ORDER BY sort_order, created_at`).map(fileShape) });
  }),
);

adminConfigRouter.post(
  '/files',
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? next(badRequest(err.message)) : next())),
  wrap(async (req, res) => {
    const f = req.file;
    if (!f) throw badRequest('No file uploaded.');
    const body = parse(z.object({ title: z.string().max(200).optional(), moduleLabel: z.string().max(120).optional() }), req.body ?? {});
    const id = newId('cf');
    const maxOrder = one<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM course_files')!.m;
    run(
      `INSERT INTO course_files (id, title, module_label, original_name, mime_type, size_bytes, storage_path, sort_order, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, body.title || f.originalname.replace(/\.[^.]+$/, ''), body.moduleLabel ?? '', f.originalname, f.mimetype, f.size, f.path, maxOrder + 1, req.user!.id,
    );
    audit(req, 'course_file.uploaded', { type: 'course_file', id }, { name: f.originalname, size: f.size });
    // Add to draft automatically so it is included when published
    const draft = ensureDraft();
    if (!draft.fileIds.includes(id)) updateDraft({ fileIds: [...draft.fileIds, id] });
    // index in background
    indexFile(id).catch((e) => console.error('index failed', e));
    res.json({ file: fileShape(one('SELECT * FROM course_files WHERE id = ?', id)) });
  }),
);

adminConfigRouter.patch(
  '/files/:id',
  wrap((req, res) => {
    const f = one<any>('SELECT * FROM course_files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File not found.');
    const body = parse(z.object({ title: z.string().min(1).max(200).optional(), moduleLabel: z.string().max(120).optional(), sortOrder: z.number().int().optional() }), req.body);
    run(
      `UPDATE course_files SET title = COALESCE(?, title), module_label = COALESCE(?, module_label), sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`,
      body.title ?? null, body.moduleLabel ?? null, body.sortOrder ?? null, nowIso(), f.id,
    );
    res.json({ file: fileShape(one('SELECT * FROM course_files WHERE id = ?', f.id)) });
  }),
);

adminConfigRouter.post(
  '/files/:id/reindex',
  wrap(async (req, res) => {
    const f = one<any>('SELECT * FROM course_files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File not found.');
    await indexFile(f.id);
    res.json({ file: fileShape(one('SELECT * FROM course_files WHERE id = ?', f.id)) });
  }),
);

/** Replace the underlying file but keep id/labels */
adminConfigRouter.post(
  '/files/:id/replace',
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? next(badRequest(err.message)) : next())),
  wrap(async (req, res) => {
    const f = one<any>('SELECT * FROM course_files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File not found.');
    if (!req.file) throw badRequest('No file uploaded.');
    try { fs.unlinkSync(f.storage_path); } catch { /* ignore */ }
    run(`UPDATE course_files SET original_name = ?, mime_type = ?, size_bytes = ?, storage_path = ?, status = 'uploaded', updated_at = ? WHERE id = ?`,
      req.file.originalname, req.file.mimetype, req.file.size, req.file.path, nowIso(), f.id);
    audit(req, 'course_file.replaced', { type: 'course_file', id: f.id }, { name: req.file.originalname });
    indexFile(f.id).catch((e) => console.error('index failed', e));
    res.json({ file: fileShape(one('SELECT * FROM course_files WHERE id = ?', f.id)) });
  }),
);

adminConfigRouter.delete(
  '/files/:id',
  wrap((req, res) => {
    const f = one<any>('SELECT * FROM course_files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File not found.');
    run(`DELETE FROM course_chunks_fts WHERE file_id = ?`, f.id);
    run(`DELETE FROM course_chunks WHERE file_id = ?`, f.id);
    run(`UPDATE course_files SET status = 'removed', updated_at = ? WHERE id = ?`, nowIso(), f.id);
    forgetCachedEmbeddings(f.id);
    try { fs.unlinkSync(f.storage_path); } catch { /* ignore */ }
    // remove from draft (published version keeps id but retrieval ignores non-indexed files)
    const draft = getDraft();
    if (draft) updateDraft({ fileIds: draft.fileIds.filter((x) => x !== f.id) });
    audit(req, 'course_file.removed', { type: 'course_file', id: f.id });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Usage settings (global limits + warnings)
// ---------------------------------------------------------------------------
adminConfigRouter.get(
  '/settings/usage',
  wrap((_req, res) => res.json({ usage: usageSettings(), defaults: DEFAULT_USAGE_SETTINGS })),
);

adminConfigRouter.put(
  '/settings/usage',
  wrap((req, res) => {
    const body = parse(
      z.object({
        repliesPerPeriod: z.number().int().min(0).max(100000),
        costCeilingUsd: z.number().min(0).max(10000),
        warnAtReplies: z.array(z.number().int().min(0)).length(3),
        warnAtCostFraction: z.number().min(0).max(1),
        reserveEstimateUsd: z.number().min(0).max(5),
        maxContextMessages: z.number().int().min(2).max(200),
        retrievalPassages: z.number().int().min(0).max(20),
        memoryPassages: z.number().int().min(0).max(30),
        privacyRequestDays: z.number().int().min(1).max(90),
      }),
      req.body,
    );
    setSetting('usage', body);
    audit(req, 'settings.usage_updated', undefined, body);
    res.json({ usage: usageSettings() });
  }),
);

void getSetting;
