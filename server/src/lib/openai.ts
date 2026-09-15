import OpenAI from 'openai';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { getSetting } from '../db/db.js';
import { decrypt } from './crypto.js';

export interface PlatformKeySetting { enc: string; last4: string; validatedAt: string; setBy?: string }
export const PLATFORM_KEY_SETTING = 'openai_platform_key';

/**
 * SelfLatitude's OpenAI key. The key saved in the admin area (encrypted in the settings table)
 * takes precedence; the OPENAI_API_KEY environment variable is the fallback.
 */
export function platformKey(): { key: string; source: 'settings' | 'env' } | null {
  const saved = getSetting<PlatformKeySetting | null>(PLATFORM_KEY_SETTING, null);
  if (saved?.enc) {
    try { return { key: decrypt(saved.enc), source: 'settings' }; } catch { /* fall through to env */ }
  }
  if (config.openaiApiKey) return { key: config.openaiApiKey, source: 'env' };
  return null;
}

export const PLATFORM_KEY_MISSING_MESSAGE =
  'The Companion is not connected to OpenAI yet. An administrator needs to add the OpenAI API key under Administration, OpenAI connection.';

/** Platform client funded by SelfLatitude (included usage). */
export function platformClient(): OpenAI {
  const k = platformKey();
  if (!k) {
    console.error('No OpenAI platform key configured (settings or OPENAI_API_KEY)');
    throw new HttpError(503, PLATFORM_KEY_MISSING_MESSAGE, 'companion_unavailable');
  }
  return new OpenAI({ apiKey: k.key });
}

/** Client using a student's own key (never logged, never persisted here). */
export function customerClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

/** Cheap validation call for a customer key. Returns an error message or null. */
export async function testApiKey(apiKey: string): Promise<string | null> {
  try {
    const client = customerClient(apiKey);
    await client.models.list();
    return null;
  } catch (e: any) {
    const status = e?.status;
    if (status === 401) return 'OpenAI rejected this key. Check that you copied the full key.';
    if (status === 429) return 'OpenAI says this key has no available quota or funds.';
    return 'Could not verify this key with OpenAI. Please try again.';
  }
}

export async function embed(texts: string[], client?: OpenAI): Promise<Float32Array[] | null> {
  if (!client && !platformKey()) return null;
  try {
    const c = client ?? platformClient();
    const out: Float32Array[] = [];
    // batch in groups of 64
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
      const r = await c.embeddings.create({ model: config.embeddingModel, input: batch });
      for (const d of r.data) out.push(Float32Array.from(d.embedding));
    }
    return out;
  } catch (e) {
    console.error('embedding failed', (e as Error).message);
    return null;
  }
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function fromBlob(b: Buffer | null): Float32Array | null {
  if (!b || b.byteLength < 4) return null;
  // Copy rather than view: a pooled Buffer's byteOffset is not guaranteed to be 4-byte aligned.
  const out = new Float32Array(Math.floor(b.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Rough token estimate (4 chars/token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
