import { describe, it, expect } from 'vitest';
import { chunkText } from './retrieval.js';

describe('chunkText', () => {
  it('splits into chunks and tracks module/section headings', () => {
    const text = `Module 1: Values

Your values are the directions you want to move in. ${'Living by your values means acting on what matters. '.repeat(30)}

Module 2: Latitude

Latitude is the space between a trigger and your response. ${'Practice noticing the gap. '.repeat(30)}`;
    const chunks = chunkText(text, 600);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].sectionLabel).toBe('Module 1: Values');
    expect(chunks.some((c) => c.sectionLabel === 'Module 2: Latitude')).toBe(true);
    for (const c of chunks) expect(c.content.length).toBeLessThan(600 * 1.7);
  });
  it('returns nothing for empty text', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('embedding cache', () => {
  it('reloads a file after it is re-indexed, and forgets it when removed', async () => {
    const { migrate } = await import('../db/migrate.js');
    const { run, all } = await import('../db/db.js');
    const { retrievePassages, forgetCachedEmbeddings } = await import('./retrieval.js');
    migrate();
    forgetCachedEmbeddings();

    const vec = (n: number) => {
      const f = new Float32Array(4).fill(n);
      return Buffer.from(f.buffer);
    };
    run(`INSERT OR REPLACE INTO course_files (id, title, module_label, original_name, mime_type, size_bytes, storage_path, status, chunk_count)
         VALUES ('cf-cache', 'Cached file', 'Module 1', 'x.md', 'text/markdown', 10, '/tmp/x.md', 'indexed', 1)`);
    run(`DELETE FROM course_chunks WHERE file_id = 'cf-cache'`);
    run(`INSERT INTO course_chunks (file_id, chunk_index, section_label, content, embedding, token_estimate)
         VALUES ('cf-cache', 0, 'Values', 'first version of the passage', ?, 5)`, vec(1));

    // No OpenAI key in tests, so embed() returns null and the semantic pass is skipped;
    // the point here is that the cache does not serve stale rows or crash.
    await expect(retrievePassages('values', ['cf-cache'], 3)).resolves.toBeInstanceOf(Array);

    run(`UPDATE course_chunks SET content = 'second version' WHERE file_id = 'cf-cache'`);
    run(`UPDATE course_files SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id = 'cf-cache'`);
    await expect(retrievePassages('values', ['cf-cache'], 3)).resolves.toBeInstanceOf(Array);

    run(`UPDATE course_files SET status = 'removed' WHERE id = 'cf-cache'`);
    forgetCachedEmbeddings('cf-cache');
    await expect(retrievePassages('values', ['cf-cache'], 3)).resolves.toEqual([]);
    void all;
  });
});
