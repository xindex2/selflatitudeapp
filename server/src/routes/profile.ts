/**
 * Profile: display name, avatar, and changing the sign-in email.
 * Password changes and two-step verification live in routes/auth.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { one, run, nowIso, getSetting } from '../db/db.js';
import { config } from '../config.js';
import { newId, verifyPassword } from '../lib/crypto.js';
import { badRequest, notFound, parse, wrap, limiter } from '../lib/http.js';
import { requireAuth, isAdmin } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { issueLoginCode, verifyLoginCode } from '../lib/loginCodes.js';
import { DEFAULT_SUPPORT_SETTINGS, type SupportSettings } from '../lib/defaults.js';

export const profileRouter = Router();
export const SUPPORT_SETTING = 'support';

export function supportSettings(): SupportSettings {
  return { ...DEFAULT_SUPPORT_SETTINGS, ...getSetting<Partial<SupportSettings>>(SUPPORT_SETTING, {}) };
}

const avatarDir = path.join(config.uploadDir, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

/** Identify the image by its magic bytes rather than trusting the declared type. */
function imageKind(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** POST /api/profile/avatar - multipart 'avatar'. The browser resizes before upload. */
profileRouter.post(
  '/avatar',
  requireAuth,
  (req, res, next) => upload.single('avatar')(req, res, (err: any) => {
    if (!err) return next();
    next(badRequest(err?.code === 'LIMIT_FILE_SIZE' ? 'That image is too large. Pick one under 2 MB.' : 'Could not read that image.'));
  }),
  wrap((req, res) => {
    if (!req.file) throw badRequest('No image was uploaded.');
    const kind = imageKind(req.file.buffer);
    if (!kind) throw badRequest('That file is not a PNG, JPEG or WebP image.');

    const user = one<any>('SELECT avatar_path FROM users WHERE id = ?', req.user!.id);
    const filename = `${newId('av')}.${kind}`;
    const full = path.join(avatarDir, filename);
    fs.writeFileSync(full, req.file.buffer);
    run('UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?', filename, nowIso(), req.user!.id);
    if (user?.avatar_path) {
      try { fs.unlinkSync(path.join(avatarDir, path.basename(user.avatar_path))); } catch { /* already gone */ }
    }
    audit(req, 'profile.avatar_updated', { type: 'user', id: req.user!.id });
    res.json({ avatarUrl: `/api/profile/avatar/${req.user!.id}?v=${Date.now()}` });
  }),
);

profileRouter.delete(
  '/avatar',
  requireAuth,
  wrap((req, res) => {
    const user = one<any>('SELECT avatar_path FROM users WHERE id = ?', req.user!.id);
    if (user?.avatar_path) {
      try { fs.unlinkSync(path.join(avatarDir, path.basename(user.avatar_path))); } catch { /* already gone */ }
    }
    run('UPDATE users SET avatar_path = NULL, updated_at = ? WHERE id = ?', nowIso(), req.user!.id);
    res.json({ ok: true });
  }),
);

/** GET /api/profile/avatar/:userId - your own picture, or any picture for an administrator. */
profileRouter.get(
  '/avatar/:userId',
  requireAuth,
  wrap((req, res) => {
    const target = req.params.userId;
    if (target !== req.user!.id && !isAdmin(req.user!)) throw notFound('Not found.');
    const u = one<any>('SELECT avatar_path FROM users WHERE id = ?', target);
    if (!u?.avatar_path) throw notFound('No picture set.');
    const file = path.join(avatarDir, path.basename(u.avatar_path));
    if (!fs.existsSync(file)) throw notFound('No picture set.');
    const ext = path.extname(file).slice(1);
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(file).pipe(res);
  }),
);

const emailLimiter = limiter({ windowMs: 60 * 60_000, limit: 6 });

/**
 * POST /api/profile/email - start changing the sign-in email.
 * Confirms the password, then emails a code to the NEW address. The address only
 * changes once that code is entered, so a typo cannot lock anyone out.
 */
profileRouter.post(
  '/email',
  requireAuth,
  emailLimiter,
  wrap(async (req, res) => {
    const { newEmail, password } = parse(
      z.object({ newEmail: z.string().email().max(200), password: z.string().min(1) }),
      req.body,
    );
    const target = newEmail.trim().toLowerCase();
    if (target === req.user!.email.toLowerCase()) throw badRequest('That is already your email address.');
    const row = one<any>('SELECT password_hash FROM users WHERE id = ?', req.user!.id);
    if (!(await verifyPassword(row?.password_hash, password))) throw badRequest('Password is incorrect.');
    if (one('SELECT id FROM users WHERE email = ? AND id != ?', target, req.user!.id)) {
      throw badRequest('Another account already uses that email address.');
    }
    run('UPDATE users SET pending_email = ?, updated_at = ? WHERE id = ?', target, nowIso(), req.user!.id);
    await issueLoginCode(req.user!.id, target, 'verify_email');
    audit(req, 'profile.email_change_requested', { type: 'user', id: req.user!.id });
    res.json({ ok: true, pendingEmail: target });
  }),
);

/** POST /api/profile/email/verify - finish the change with the code sent to the new address. */
profileRouter.post(
  '/email/verify',
  requireAuth,
  emailLimiter,
  wrap((req, res) => {
    const { code } = parse(z.object({ code: z.string().min(4).max(10) }), req.body);
    const u = one<any>('SELECT pending_email FROM users WHERE id = ?', req.user!.id);
    if (!u?.pending_email) throw badRequest('No email change is waiting. Start again.');
    const r = verifyLoginCode(req.user!.id, code, 'verify_email');
    if (r === 'expired') throw badRequest('That code has expired. Start the change again.');
    if (r === 'too_many') throw badRequest('Too many attempts. Start the change again.');
    if (r !== 'ok') throw badRequest('That code is not valid.');
    if (one('SELECT id FROM users WHERE email = ? AND id != ?', u.pending_email, req.user!.id)) {
      throw badRequest('Another account has taken that email address in the meantime.');
    }
    run(
      'UPDATE users SET email = ?, pending_email = NULL, email_verified = 1, updated_at = ? WHERE id = ?',
      u.pending_email, nowIso(), req.user!.id,
    );
    audit(req, 'profile.email_changed', { type: 'user', id: req.user!.id });
    res.json({ ok: true, email: u.pending_email });
  }),
);

/** POST /api/profile/email/cancel */
profileRouter.post(
  '/email/cancel',
  requireAuth,
  wrap((req, res) => {
    run('UPDATE users SET pending_email = NULL WHERE id = ?', req.user!.id);
    res.json({ ok: true });
  }),
);

/** GET /api/profile/support - contact details for the Help page. */
profileRouter.get('/support', wrap((_req, res) => res.json({ support: supportSettings() })));

