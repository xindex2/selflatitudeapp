/**
 * Course library: extract text from uploaded files, chunk, embed, and retrieve.
 * Hybrid retrieval = FTS5 keyword match + cosine similarity on embeddings (when available).
 */
import fs from 'node:fs';
import { all, run, one, tx, nowIso } from '../db/db.js';
import { embed, toBlob, fromBlob, cosine, estimateTokens } from './openai.js';

export async function extractText(storagePath: string, mime: string, originalName: string): Promise<string> {
  const lower = originalName.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    const mod: any = await import('pdf-parse');
    const pdfParse = mod.default ?? mod;
    const data = await pdfParse(fs.readFileSync(storagePath));
    return data.text ?? '';
  }
  if (lower.endsWith('.docx')) {
    // Minimal DOCX support: unzip document.xml and strip tags (no extra dependency).
    const { default: zlib } = await import('node:zlib');
    const buf = fs.readFileSync(storagePath);
    const xml = readZipEntry(buf, 'word/document.xml', zlib);
    if (!xml) return '';
    return xml
      .replace(/<w:p[ >]/g, '\n<w:p ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  // txt / md / html fallback
  const raw = fs.readFileSync(storagePath, 'utf8');
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return raw.replace(/<[^>]+>/g, ' ');
  return raw;
}

/** Tiny ZIP reader for a single stored/deflated entry. */
function readZipEntry(buf: Buffer, name: string, zlib: typeof import('node:zlib')): string | null {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export interface Chunk { sectionLabel: string; content: string }

/** Split text into ~1200-char chunks with overlap, tracking heading-like lines as section labels. */
export function chunkText(text: string, target = 1200, overlap = 150): Chunk[] {
  const cleaned = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const paras = cleaned.split(/\n\s*\n/);
  const chunks: Chunk[] = [];
  let buf = '';
  let section = '';
  const flush = () => {
    if (buf.trim().length > 40) chunks.push({ sectionLabel: section, content: buf.trim() });
    buf = buf.length > overlap ? buf.slice(-overlap) : '';
  };
  for (const p of paras) {
    const line = p.trim();
    if (!line) continue;
    const isHeading = line.length < 90 && !/[.!?]$/.test(line) && (/^(module|section|lesson|chapter|part|week|day)\b/i.test(line) || /^[A-Z0-9][^\n]{2,80}$/.test(line) && line.split(' ').length <= 10);
    if (isHeading) section = line.replace(/^#+\s*/, '');
    if ((buf + '\n\n' + line).length > target && buf) flush();
    buf = buf ? buf + '\n\n' + line : line;
    // very long paragraph - hard split
    while (buf.length > target * 1.6) {
      const cut = buf.lastIndexOf(' ', target);
      const head = buf.slice(0, cut > 0 ? cut : target);
      chunks.push({ sectionLabel: section, content: head.trim() });
      buf = buf.slice(head.length).trim();
    }
  }
  if (buf.trim()) chunks.push({ sectionLabel: section, content: buf.trim() });
  return chunks;
}

export async function indexFile(fileId: string): Promise<void> {
  const f = one<any>('SELECT * FROM course_files WHERE id = ?', fileId);
  if (!f) return;
  run(`UPDATE course_files SET status='indexing', error=NULL, updated_at=? WHERE id=?`, nowIso(), fileId);
  try {
    const text = await extractText(f.storage_path, f.mime_type, f.original_name);
    const chunks = chunkText(text);
    if (!chunks.length) throw new Error('No readable text found in this file.');
    const vectors = await embed(chunks.map((c) => `${f.module_label} ${c.sectionLabel}\n${c.content}`));
    tx(() => {
      run('DELETE FROM course_chunks_fts WHERE file_id = ?', fileId);
      run('DELETE FROM course_chunks WHERE file_id = ?', fileId);
      const ins = `INSERT INTO course_chunks (file_id, chunk_index, section_label, content, embedding, token_estimate) VALUES (?, ?, ?, ?, ?, ?)`;
      chunks.forEach((c, i) => {
        const info = run(ins, fileId, i, c.sectionLabel, c.content, vectors ? toBlob(vectors[i]) : null, estimateTokens(c.content));
        run('INSERT INTO course_chunks_fts (content, section_label, chunk_id, file_id) VALUES (?, ?, ?, ?)', c.content, c.sectionLabel, Number(info.lastInsertRowid), fileId);
      });
      run(`UPDATE course_files SET status='indexed', chunk_count=?, updated_at=? WHERE id=?`, chunks.length, nowIso(), fileId);
    });
    forgetCachedEmbeddings(fileId);
  } catch (e: any) {
    run(`UPDATE course_files SET status='failed', error=?, updated_at=? WHERE id=?`, String(e?.message ?? e).slice(0, 500), nowIso(), fileId);
    forgetCachedEmbeddings(fileId);
  }
}

/**
 * Embeddings change only when a file is re-indexed, but scoring a message needs all of them.
 * Reading every blob from SQLite on each message makes the cost of a reply grow with the size
 * of the course library, so they are held in memory and refreshed when a file changes.
 */
interface CachedChunk { id: number; fileId: string; section: string; content: string; vector: Float32Array }
const embeddingCache = new Map<string, { stamp: string; chunks: CachedChunk[] }>();

function cachedChunksFor(fileIds: string[]): CachedChunk[] {
  const out: CachedChunk[] = [];
  for (const fileId of fileIds) {
    const meta = one<{ updated_at: string; status: string; chunk_count: number }>(
      'SELECT updated_at, status, chunk_count FROM course_files WHERE id = ?', fileId,
    );
    if (!meta || meta.status !== 'indexed') { embeddingCache.delete(fileId); continue; }
    const stamp = `${meta.updated_at}|${meta.chunk_count}`;
    let entry = embeddingCache.get(fileId);
    if (!entry || entry.stamp !== stamp) {
      const rows = all<any>(
        `SELECT c.id, c.file_id, c.section_label, c.content, c.embedding
         FROM course_chunks c WHERE c.file_id = ? AND c.embedding IS NOT NULL`,
        fileId,
      );
      entry = {
        stamp,
        chunks: rows
          .map((r) => ({ id: r.id, fileId: r.file_id, section: r.section_label, content: r.content, vector: fromBlob(r.embedding)! }))
          .filter((c) => c.vector),
      };
      embeddingCache.set(fileId, entry);
    }
    out.push(...entry.chunks);
  }
  return out;
}

/** Drop cached embeddings for a file, so the next search reloads them. */
export function forgetCachedEmbeddings(fileId?: string) {
  if (fileId) embeddingCache.delete(fileId);
  else embeddingCache.clear();
}

export interface Passage {
  fileId: string;
  title: string;
  module: string;
  section: string;
  content: string;
  score: number;
}

function ftsQuery(q: string): string {
  const terms = q.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  const stop = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'what', 'how', 'can', 'you', 'about', 'from', 'have', 'are', 'was', 'but', 'not', 'your', 'when', 'why', 'does', 'will', 'into', 'more', 'some', 'them', 'they', 'then', 'than']);
  const kept = terms.filter((t) => !stop.has(t)).slice(0, 12);
  return kept.map((t) => `"${t}"`).join(' OR ');
}

export async function retrievePassages(query: string, fileIds: string[], limit: number): Promise<Passage[]> {
  if (!fileIds.length || !query.trim()) return [];
  const placeholders = fileIds.map(() => '?').join(',');
  const scored = new Map<number, { row: any; score: number }>();

  // 1) keyword
  const fq = ftsQuery(query);
  if (fq) {
    try {
      const rows = all<any>(
        `SELECT c.id, c.file_id, c.section_label, c.content, c.embedding, f.title, f.module_label, bm25(course_chunks_fts) AS rank
         FROM course_chunks_fts JOIN course_chunks c ON c.id = course_chunks_fts.chunk_id
         JOIN course_files f ON f.id = c.file_id
         WHERE course_chunks_fts MATCH ? AND c.file_id IN (${placeholders}) AND f.status='indexed'
         ORDER BY rank LIMIT 20`,
        fq, ...fileIds,
      );
      rows.forEach((r, i) => scored.set(r.id, { row: r, score: 0.5 * (1 - i / Math.max(rows.length, 1)) }));
    } catch { /* malformed FTS query - ignore */ }
  }

  // 2) semantic
  const qv = (await embed([query]))?.[0];
  if (qv) {
    const titles = new Map<string, { title: string; module_label: string }>();
    for (const f of all<any>(`SELECT id, title, module_label FROM course_files WHERE id IN (${placeholders})`, ...fileIds)) {
      titles.set(f.id, f);
    }
    for (const c of cachedChunksFor(fileIds)) {
      const sim = cosine(qv, c.vector);
      if (sim < 0.2) continue;
      const meta = titles.get(c.fileId);
      const row = { id: c.id, file_id: c.fileId, section_label: c.section, content: c.content, title: meta?.title ?? '', module_label: meta?.module_label ?? '' };
      const prev = scored.get(c.id);
      scored.set(c.id, { row: prev?.row ?? row, score: (prev?.score ?? 0) + sim });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      fileId: row.file_id,
      title: row.title,
      module: row.module_label,
      section: row.section_label,
      content: row.content,
      score,
    }));
}
