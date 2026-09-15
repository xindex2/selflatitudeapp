import { getSetting, one, run, nowIso } from '../db/db.js';
import { newId, keyedHash, safeEqual, generateNumericCode } from './crypto.js';
import { sendTemplate } from './mail.js';
import { DEFAULT_AUTH_SETTINGS, type AuthSettings } from './defaults.js';

export const AUTH_SETTING = 'auth';
export function authSettings(): AuthSettings {
  return { ...DEFAULT_AUTH_SETTINGS, ...getSetting<Partial<AuthSettings>>(AUTH_SETTING, {}) };
}

const MAX_ATTEMPTS = 5;

/** Create a 6-digit code, email it, and store only its hash. */
export async function issueLoginCode(userId: string, email: string, purpose: 'mfa' | 'verify_email' = 'mfa'): Promise<void> {
  const minutes = authSettings().emailCodeMinutes;
  const code = generateNumericCode(6);
  run('DELETE FROM login_codes WHERE user_id = ? AND purpose = ?', userId, purpose);
  run(
    `INSERT INTO login_codes (id, user_id, code_hash, purpose, expires_at) VALUES (?, ?, ?, ?, ?)`,
    // Keyed, and bound to this user and purpose, so a database copy cannot reveal the code.
    newId('lc'), userId, keyedHash(code, `${userId}|${purpose}`), purpose, new Date(Date.now() + minutes * 60_000).toISOString(),
  );
  await sendTemplate(email, purpose === 'verify_email' ? 'emailChange' : 'loginCode', { code, minutes: String(minutes) });
}

export type CodeResult = 'ok' | 'invalid' | 'expired' | 'too_many';

/** Check a code. Codes are single-use and limited to five attempts. */
export function verifyLoginCode(userId: string, code: string, purpose: 'mfa' | 'verify_email' = 'mfa'): CodeResult {
  const row = one<any>(
    'SELECT * FROM login_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
    userId, purpose,
  );
  if (!row || row.used_at) return 'invalid';
  if (row.expires_at < nowIso()) return 'expired';
  if (row.attempts >= MAX_ATTEMPTS) return 'too_many';
  if (!safeEqual(row.code_hash, keyedHash(code.trim(), `${userId}|${purpose}`))) {
    run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return 'invalid';
  }
  run('UPDATE login_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
  return 'ok';
}

/** True when this account must pass a second step before it is fully signed in. */
export function mfaRequiredFor(u: { role: string; mfa_method?: string; mfa_enabled?: number }): boolean {
  const s = authSettings();
  if (u.mfa_method === 'totp' || u.mfa_method === 'email') return true;
  if (u.mfa_enabled) return true;
  if (s.requireEmailCodeForAll) return true;
  return false;
}

/** The second-step method to use: what the user configured, else an emailed code. */
export function mfaMethodFor(u: { mfa_method?: string; mfa_enabled?: number }): 'totp' | 'email' {
  if (u.mfa_method === 'totp' || (u.mfa_enabled && u.mfa_method !== 'email')) return 'totp';
  return 'email';
}
