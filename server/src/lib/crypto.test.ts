import { describe, it, expect } from 'vitest';
import {
  encrypt, decrypt, hashPassword, verifyPassword, sha256, generateTempPassword,
  keyedHash, sessionHash, safeEqual, generateNumericCode, needsResealing, randomFromAlphabet,
} from './crypto.js';

describe('crypto', () => {
  it('round-trips API keys with AES-256-GCM and never stores plaintext', () => {
    const key = 'sk-test-1234567890abcdef';
    const enc = encrypt(key);
    expect(enc).not.toContain(key);
    expect(enc.split(':')).toHaveLength(4);
    expect(enc.startsWith('v2:')).toBe(true);
    expect(decrypt(enc)).toBe(key);
    // a fresh IV every time, so the same secret never produces the same ciphertext
    expect(encrypt(key)).not.toBe(enc);
  });

  it('still opens secrets sealed in the original format, and flags them for re-sealing', async () => {
    const nodeCrypto = await import('node:crypto');
    const { config } = await import('../config.js');
    const legacyKey = nodeCrypto.createHash('sha256').update(config.encryptionKey).digest();
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const body = Buffer.concat([c.update('sk-old-format-key', 'utf8'), c.final()]);
    const legacy = [iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');

    expect(decrypt(legacy)).toBe('sk-old-format-key');
    expect(needsResealing(legacy)).toBe(true);
    expect(needsResealing(encrypt('x'))).toBe(false);
  });

  it('refuses values it cannot recognise instead of returning rubbish', () => {
    expect(() => decrypt('not-encrypted')).toThrow();
    expect(() => decrypt('')).toThrow();
    expect(() => decrypt('v2:only:three')).toThrow();
  });

  it('keys the hash of short codes so a database copy cannot reveal them', () => {
    const code = '123456';
    const stored = keyedHash(code, 'usr_1|mfa');
    // not a plain hash of the code: guessing all million values offline does not work
    expect(stored).not.toBe(sha256(code));
    expect(keyedHash(code, 'usr_1|mfa')).toBe(stored);
    // bound to the user and purpose, so a code cannot be replayed elsewhere
    expect(keyedHash(code, 'usr_2|mfa')).not.toBe(stored);
    expect(keyedHash(code, 'usr_1|verify_email')).not.toBe(stored);
  });

  it('keys session lookups separately from sealed data', () => {
    const token = 'abc123';
    expect(sessionHash(token)).not.toBe(sha256(token));
    expect(sessionHash(token)).not.toBe(keyedHash(token));
    expect(sessionHash(token)).toBe(sessionHash(token));
  });

  it('compares digests in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
  it('rejects tampered ciphertext', () => {
    const enc = encrypt('secret');
    const [iv, tag, ct] = enc.split(':');
    const tampered = [iv, tag, Buffer.from('xx' + ct, 'base64').toString('base64')].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });
  it('hashes passwords with argon2id', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword(null, 'x')).toBe(false);
  });
  it('sha256 is stable', () => {
    expect(sha256('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
  it('temporary passwords are 14 chars from an unambiguous alphabet', () => {
    const p = generateTempPassword();
    expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{14}$/);
    // and they differ every time
    expect(generateTempPassword()).not.toBe(p);
  });

  it('generates codes and passwords without modulo bias', () => {
    expect(generateNumericCode(6)).toMatch(/^[0-9]{6}$/);
    // A byte-modulo generator over this 3-letter alphabet would favour 'a' by ~50%.
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6000; i++) counts[randomFromAlphabet(1, 'abc')] += 1;
    for (const n of Object.values(counts)) {
      expect(n).toBeGreaterThan(1700);
      expect(n).toBeLessThan(2300);
    }
  });
});
