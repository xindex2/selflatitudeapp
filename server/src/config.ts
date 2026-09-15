import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

const isProd = process.env.NODE_ENV === 'production';
/**
 * An https APP_URL means this is a real deployment even if NODE_ENV was forgotten. Treat it
 * as production for anything security-relevant, so a live instance can never silently fall
 * back to the development defaults that are published in this repository.
 */
const looksDeployed = isProd || (process.env.APP_URL ?? '').startsWith('https://');

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'companion.db'),
  uploadDir: process.env.UPLOAD_DIR ?? path.join(root, 'uploads'),

  // 32-byte hex/base64 secret for AES-256-GCM of customer keys + MFA secrets
  looksDeployed,
  encryptionKey: req('ENCRYPTION_KEY', looksDeployed ? undefined : 'dev-only-change-me-dev-only-change-me-000'),
  sessionSecret: req('SESSION_SECRET', looksDeployed ? undefined : 'dev-session-secret'),
  /** Print emails to the console instead of sending them. Never on for a deployed instance. */
  mailToConsole: !looksDeployed && process.env.MAIL_DEV_CONSOLE !== '0',
  /**
   * Extra origins allowed to make state-changing requests, beyond APP_URL. Comma separated,
   * e.g. "https://www.selflatitude.com". Only needed when the app is reachable under more
   * than one hostname.
   */
  extraOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),

  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',

  mail: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'SelfLatitude Companion <no-reply@selflatitude.com>',
  },

  bootstrap: {
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  },

  policyVersions: {
    terms: process.env.TERMS_VERSION ?? '2026-01',
    privacy: process.env.PRIVACY_VERSION ?? '2026-01',
  },
};
