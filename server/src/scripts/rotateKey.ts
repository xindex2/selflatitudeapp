/**
 * Re-seal every stored secret under a new ENCRYPTION_KEY.
 *
 *   OLD_ENCRYPTION_KEY='<current>' ENCRYPTION_KEY='<new>' npm run rotate-key -w server
 *
 * Run it with the app stopped, and take a backup first. Without OLD_ENCRYPTION_KEY the script
 * re-seals values that are still in the original format under the current key, which is what
 * you want after upgrading from a version that used the weaker key derivation.
 *
 * Rotating SESSION_SECRET needs no script: changing it invalidates every session and every
 * outstanding password-reset or one-time link, which is the intended effect.
 */
import crypto from 'node:crypto';
import { db, all, run, getSetting, setSetting } from '../db/db.js';
import { config } from '../config.js';
import { encrypt, decrypt, needsResealing } from '../lib/crypto.js';

const oldSecret = process.env.OLD_ENCRYPTION_KEY ?? '';

/** Open a value sealed under the previous key. Mirrors lib/crypto so both formats are read. */
function decryptWithOldKey(payload: string): string {
  const parts = payload.split(':');
  const master = crypto.scryptSync(oldSecret, 'selflatitude-companion:v2', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  const v2Key = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'selflatitude:data', 32));
  const legacyKey = crypto.createHash('sha256').update(oldSecret).digest();

  const [key, ivB, tagB, encB] =
    parts.length === 4 && parts[0] === 'v2'
      ? [v2Key, parts[1], parts[2], parts[3]]
      : parts.length === 3
        ? [legacyKey, parts[0], parts[1], parts[2]]
        : [null, '', '', ''];
  if (!key) throw new Error('Unrecognised encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', key as Buffer, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(encB, 'base64')), d.final()]).toString('utf8');
}

const open = (payload: string) => (oldSecret ? decryptWithOldKey(payload) : decrypt(payload));

function reseal(label: string, payload: string | null | undefined): string | null {
  if (!payload) return null;
  if (!oldSecret && !needsResealing(payload)) return null; // already current
  try {
    return encrypt(open(payload));
  } catch (e) {
    console.error(`  ! ${label}: could not open this value (${(e as Error).message}). Left untouched.`);
    return null;
  }
}

function main() {
  console.log(oldSecret ? 'Rotating to the new ENCRYPTION_KEY...' : 'Re-sealing values still using the old format...');
  let changed = 0;

  // Students' own OpenAI keys
  for (const row of all<any>('SELECT user_id, key_enc FROM customer_api_keys')) {
    const next = reseal(`customer key for ${row.user_id}`, row.key_enc);
    if (next) { run('UPDATE customer_api_keys SET key_enc = ? WHERE user_id = ?', next, row.user_id); changed++; }
  }

  // Authenticator secrets
  for (const row of all<any>('SELECT id, mfa_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL')) {
    const next = reseal(`authenticator secret for ${row.id}`, row.mfa_secret_enc);
    if (next) { run('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', next, row.id); changed++; }
  }

  // SelfLatitude's OpenAI platform key
  const platform = getSetting<{ enc?: string } | null>('openai_platform_key', null);
  if (platform?.enc) {
    const next = reseal('OpenAI platform key', platform.enc);
    if (next) { setSetting('openai_platform_key', { ...platform, enc: next }); changed++; }
  }

  // SMTP password
  const smtp = getSetting<{ passEnc?: string } | null>('smtp', null);
  if (smtp?.passEnc) {
    const next = reseal('SMTP password', smtp.passEnc);
    if (next) { setSetting('smtp', { ...smtp, passEnc: next }); changed++; }
  }

  // JVZoo secret key
  const jvzoo = getSetting<{ secretEnc?: string } | null>('jvzoo', null);
  if (jvzoo?.secretEnc) {
    const next = reseal('JVZoo secret', jvzoo.secretEnc);
    if (next) { setSetting('jvzoo', { ...jvzoo, secretEnc: next }); changed++; }
  }

  console.log(`Done. ${changed} secret(s) re-sealed in ${config.dbPath}.`);
  if (oldSecret) {
    console.log('Update ENCRYPTION_KEY in your .env to the new value before starting the app again.');
  }
  db.close();
}

main();
