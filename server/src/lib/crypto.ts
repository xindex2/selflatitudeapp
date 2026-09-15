import crypto from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../config.js';

/**
 * Secret handling for the Companion.
 *
 * Everything sensitive at rest (students' OpenAI keys, the SelfLatitude platform key, SMTP
 * password, JVZoo secret, TOTP secrets) is sealed with AES-256-GCM under a key derived from
 * ENCRYPTION_KEY. Short-lived sign-in codes are keyed-hashed rather than plainly hashed, so a
 * database copy alone does not reveal them.
 */

const SCRYPT_SALT = 'selflatitude-companion:v2';        // fixed: the passphrase is the only input
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

/**
 * Stretch the configured passphrase into a 32-byte key. scrypt makes a weak passphrase
 * expensive to guess from a stolen database; the older SHA-256 derivation did not.
 */
function deriveKey(secret: string, purpose: string): Buffer {
  const master = crypto.scryptSync(secret, SCRYPT_SALT, 32, SCRYPT_OPTIONS);
  // Separate keys per purpose so sealed data and code hashes never share a key.
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `selflatitude:${purpose}`, 32));
}

const dataKey = deriveKey(config.encryptionKey, 'data');
const codeKey = deriveKey(config.encryptionKey, 'codes');
const sessionKey = deriveKey(config.sessionSecret, 'sessions');
/** How values were sealed before scrypt was introduced. Kept so existing rows still open. */
const legacyKey = crypto.createHash('sha256').update(config.encryptionKey).digest();

const V2 = 'v2';

/** Seal a secret for storage. Output: `v2:<iv>:<tag>:<ciphertext>`, all base64. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12); // GCM standard; random per message, never reused
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [V2, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Open a sealed secret. Understands both the current format and the original one. */
export function decrypt(payload: string): string {
  if (typeof payload !== 'string' || !payload) throw new Error('Nothing to decrypt');
  const parts = payload.split(':');
  const [key, ivB, tagB, encB] =
    parts.length === 4 && parts[0] === V2
      ? [dataKey, parts[1], parts[2], parts[3]]
      : parts.length === 3
        ? [legacyKey, parts[0], parts[1], parts[2]]
        : [null, '', '', ''];
  if (!key) throw new Error('Unrecognised encrypted value');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key as Buffer, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

/** True when a stored value still uses the original format and should be re-sealed. */
export function needsResealing(payload: string): boolean {
  return typeof payload === 'string' && payload.split(':').length === 3;
}

export function newId(prefix = ''): string {
  const id = crypto.randomBytes(12).toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

/** A high-entropy opaque token (256 bits by default). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Plain hash. Only for values that already have full entropy, such as random tokens. */
export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Keyed hash for low-entropy secrets such as 6-digit sign-in codes. A plain hash of a
 * six-digit number can be reversed by trying all million values; this cannot be checked
 * without the server key.
 */
export function keyedHash(value: string, scope = ''): string {
  return crypto.createHmac('sha256', codeKey).update(`${scope}|${value}`).digest('hex');
}

/**
 * Look-up id for a session or single-use link token. Keyed with SESSION_SECRET so a stolen
 * database cannot be turned into working cookies, and so rotating that secret signs everyone out.
 */
export function sessionHash(token: string): string {
  return crypto.createHmac('sha256', sessionKey).update(token).digest('hex');
}

/** Constant-time comparison of two hex digests or tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function hashPassword(pw: string): Promise<string> {
  // argon2id at the library defaults (64 MB, 3 passes), which meet current OWASP guidance.
  return argon2.hash(pw, { type: argon2.argon2id });
}
export async function verifyPassword(hash: string | null | undefined, pw: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

/** Random string from an alphabet, without the modulo bias of `randomBytes[i] % length`. */
export function randomFromAlphabet(length: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

export function generateTempPassword(): string {
  // 14 characters from an alphabet without look-alikes (no I/l/1, O/0)
  return randomFromAlphabet(14, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789');
}

/** A numeric code of the given length, uniformly distributed. */
export function generateNumericCode(digits = 6): string {
  return randomFromAlphabet(digits, '0123456789');
}

/**
 * Refuse to start in production with a guessable ENCRYPTION_KEY: everything sealed with it
 * would be recoverable from a database copy alone.
 */
export function assertStrongSecrets(): void {
  if (!config.looksDeployed) return;
  const problems: string[] = [];
  const check = (name: string, value: string) => {
    if (value.length < 32) problems.push(`${name} must be at least 32 characters`);
    if (/^(dev|test|change|secret|password|placeholder)/i.test(value)) problems.push(`${name} looks like a placeholder`);
    if (new Set(value).size < 12) problems.push(`${name} does not have enough variety to be random`);
  };
  check('ENCRYPTION_KEY', config.encryptionKey);
  check('SESSION_SECRET', config.sessionSecret);
  if (config.encryptionKey === config.sessionSecret) problems.push('ENCRYPTION_KEY and SESSION_SECRET must be different');
  if (problems.length) {
    throw new Error(
      `Refusing to start: ${problems.join('; ')}. Generate each with: openssl rand -base64 48`,
    );
  }
}
