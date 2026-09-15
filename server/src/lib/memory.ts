import { all, one, run, nowIso } from '../db/db.js';
import { embed, toBlob, fromBlob, cosine } from './openai.js';
import { newId } from './crypto.js';

export interface MemoryRow {
  id: string;
  user_id: string;
  category: string;
  content: string;
  status: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_journal_id: string | null;
  created_at: string;
  updated_at: string;
}

export const MEMORY_CATEGORIES = ['value', 'goal', 'commitment', 'preference', 'theme', 'practice', 'other'] as const;

export async function createMemory(
  userId: string,
  data: { category: string; content: string; status: 'pending' | 'approved'; sourceConversationId?: string | null; sourceMessageId?: string | null; sourceJournalId?: string | null },
): Promise<MemoryRow> {
  const id = newId('mem');
  const vec = (await embed([data.content]))?.[0] ?? null;
  run(
    `INSERT INTO memories (id, user_id, category, content, status, source_conversation_id, source_message_id, source_journal_id, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, userId, data.category, data.content.trim(), data.status,
    data.sourceConversationId ?? null, data.sourceMessageId ?? null, data.sourceJournalId ?? null,
    vec ? toBlob(vec) : null,
  );
  return one<MemoryRow>('SELECT * FROM memories WHERE id = ?', id)!;
}

export async function updateMemoryContent(id: string, content: string, category?: string) {
  const vec = (await embed([content]))?.[0] ?? null;
  run(
    `UPDATE memories SET content=?, category=COALESCE(?, category), embedding=?, updated_at=? WHERE id=?`,
    content.trim(), category ?? null, vec ? toBlob(vec) : null, nowIso(), id,
  );
}

/** Return only the approved memories relevant to the current message (not the whole history). */
export async function relevantMemories(userId: string, query: string, limit: number): Promise<MemoryRow[]> {
  const rows = all<MemoryRow & { embedding: Buffer | null }>(
    `SELECT * FROM memories WHERE user_id = ? AND status = 'approved' ORDER BY updated_at DESC`,
    userId,
  );
  if (!rows.length) return [];
  const qv = (await embed([query]))?.[0];
  if (!qv) {
    // No embeddings available: fall back to simple keyword overlap, then recency
    const terms = new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 3));
    return rows
      .map((r) => ({ r, s: [...terms].filter((t) => r.content.toLowerCase().includes(t)).length }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.r);
  }
  return rows
    .map((r) => ({ r, s: r.embedding ? cosine(qv, fromBlob(r.embedding)!) : 0 }))
    .filter((x) => x.s > 0.25)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
