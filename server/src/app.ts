import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { bootstrapAdmin } from './db/seed.js';
import { attachUser } from './middleware/auth.js';
import { assertStrongSecrets } from './lib/crypto.js';
import { errorHandler, limiter } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { companionRouter } from './routes/companion.js';
import { conversationsRouter } from './routes/conversations.js';
import { memoriesRouter } from './routes/memories.js';
import { journalRouter } from './routes/journal.js';
import { usageRouter } from './routes/usage.js';
import { privacyRouter } from './routes/privacy.js';
import { adminConfigRouter } from './routes/admin/config.js';
import { adminUsersRouter } from './routes/admin/users.js';
import { adminMiscRouter } from './routes/admin/misc.js';
import { adminPlansRouter } from './routes/admin/plans.js';
import { adminSettingsRouter } from './routes/admin/settings.js';
import { webhooksRouter } from './routes/webhooks.js';
import { profileRouter } from './routes/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which origins may make state-changing requests. In development the client dev server can
 * be on any localhost port, so those are all accepted; a deployed instance accepts only its
 * own address plus anything listed in ALLOWED_ORIGINS.
 */
export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const add = (value: string) => {
    try { allowed.add(new URL(value).host); } catch { /* ignore a malformed entry */ }
  };
  add(config.appUrl);
  config.extraOrigins.forEach(add);
  if (allowed.has(url.host)) return true;

  // Development: the Vite dev server moves ports, so accept the local machine on any port.
  if (!config.looksDeployed && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) return true;
  return false;
}

export async function createApp() {
assertStrongSecrets();
migrate();
await bootstrapAdmin();

const app = express();
app.set('trust proxy', 1); // behind nginx
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: config.isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
  }),
);
app.use(express.json({ limit: '2mb' }));
// JVZoo posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
/**
 * Cookie sessions are already SameSite=lax, which blocks cross-site form posts. This is the
 * belt to that braces: a state-changing request carrying an Origin from somewhere else is
 * refused outright. The payment webhook is exempt; it has no cookie and is signature-verified.
 */
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/webhooks/')) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // same-origin form posts and server-to-server calls send none
  if (!isAllowedOrigin(origin)) {
    console.warn(`Blocked a ${req.method} from origin ${origin}. If this is your own site, add it to ALLOWED_ORIGINS or fix APP_URL.`);
    return res.status(403).json({ error: 'Request blocked.', code: 'bad_origin' });
  }
  next();
});

app.use(attachUser);

// Never log private content. Only method + path + status in production.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!config.isProd || res.statusCode >= 500) {
      console.log(`${req.method} ${req.path.replace(/\/[A-Za-z0-9_-]{16,}/g, '/:id')} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

app.use('/api', limiter({ windowMs: 60_000, limit: 240 }));

app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
// Payment notifications: no session, verified by signature. Mounted before the API rate limiter above applies.
app.use('/api/webhooks', webhooksRouter);
app.use('/api/auth', authRouter);
app.use('/api/companion', companionRouter);
app.use('/api/profile', profileRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/memories', memoriesRouter);
app.use('/api/journal', journalRouter);
app.use('/api/usage', usageRouter);
app.use('/api/privacy', privacyRouter);
app.use('/api/admin', adminConfigRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/admin/plans', adminPlansRouter);
app.use('/api/admin/settings', adminSettingsRouter);
app.use('/api/admin', adminMiscRouter);

// Serve the built client in production (nginx may also do this directly).
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));
app.use(errorHandler);
return app;
}
