import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { getSetting } from '../db/db.js';
import { decrypt } from './crypto.js';
import {
  DEFAULT_SMTP_SETTINGS, DEFAULT_EMAIL_TEMPLATES,
  type SmtpSettings, type EmailTemplates,
} from './defaults.js';

export const SMTP_SETTING = 'smtp';
export const TEMPLATES_SETTING = 'email_templates';

export interface ResolvedSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  replyTo: string;
  source: 'settings' | 'env';
}

/** SMTP saved in the admin area wins; the SMTP_* environment variables are the fallback. */
export function resolveSmtp(): ResolvedSmtp | null {
  const s = { ...DEFAULT_SMTP_SETTINGS, ...getSetting<Partial<SmtpSettings>>(SMTP_SETTING, {}) };
  if (s.host) {
    let pass = '';
    try { pass = s.passEnc ? decrypt(s.passEnc) : ''; } catch { pass = ''; }
    return {
      host: s.host,
      port: s.port || 587,
      secure: !!s.secure || s.port === 465,
      user: s.user,
      pass,
      from: s.from || config.mail.from,
      replyTo: s.replyTo,
      source: 'settings',
    };
  }
  if (config.mail.host) {
    return {
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,
      user: config.mail.user,
      pass: config.mail.pass,
      from: config.mail.from,
      replyTo: '',
      source: 'env',
    };
  }
  return null;
}

function transportFor(s: ResolvedSmtp): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
}

/** Verify a configuration without saving it. Returns an error message or null. */
export async function verifySmtp(s: ResolvedSmtp): Promise<string | null> {
  try {
    await transportFor(s).verify();
    return null;
  } catch (e: any) {
    return String(e?.message ?? e).slice(0, 300);
  }
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const s = resolveSmtp();
  if (!s) {
    // Messages carry sign-in codes, reset links and temporary passwords, so they are only
    // ever printed on a local development machine.
    if (!config.mailToConsole) {
      console.error(`Email not sent to ${to.replace(/(.).*(@.*)/, '$1***$2')}: no SMTP configured. Add it under Administration > Email.`);
      return;
    }
    console.log(`\n[mail:dev] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  await transportFor(s).sendMail({
    from: s.from,
    to,
    subject,
    text,
    ...(s.replyTo ? { replyTo: s.replyTo } : {}),
  });
}

export function templates(): EmailTemplates {
  const saved = getSetting<Partial<EmailTemplates>>(TEMPLATES_SETTING, {});
  const out = { ...DEFAULT_EMAIL_TEMPLATES } as EmailTemplates;
  for (const k of Object.keys(out) as (keyof EmailTemplates)[]) {
    out[k] = { ...out[k], ...(saved[k] ?? {}) };
  }
  return out;
}

export function render(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

/** Send one of the editable templates with placeholder substitution. */
export async function sendTemplate(
  to: string,
  key: keyof EmailTemplates,
  vars: Record<string, string | undefined>,
): Promise<void> {
  const t = templates()[key];
  const all = { appName: 'SelfLatitude Companion', loginUrl: `${config.appUrl}/login`, email: to, ...vars };
  await sendMail(to, render(t.subject, all), render(t.body, all));
}
