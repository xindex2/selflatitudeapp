/**
 * Re-extract and re-index every course file.
 *
 *   npm run index-course -w server            # only files that are not indexed yet
 *   npm run index-course -w server -- --all   # every file, including ones already indexed
 *
 * Uploading a file through the admin area indexes it automatically; this is for rebuilding
 * after a restore, or after changing the embedding model.
 */
import { all, db } from '../db/db.js';
import { indexFile } from '../lib/retrieval.js';
import { platformKey } from '../lib/openai.js';

const rebuildAll = process.argv.includes('--all');

async function main() {
  if (!platformKey()) {
    console.warn('No OpenAI key configured: files will be indexed for keyword search only, without embeddings.');
  }
  const files = all<{ id: string; title: string; status: string }>(
    rebuildAll
      ? `SELECT id, title, status FROM course_files WHERE status != 'removed' ORDER BY sort_order`
      : `SELECT id, title, status FROM course_files WHERE status IN ('uploaded','failed') ORDER BY sort_order`,
  );
  if (!files.length) {
    console.log(rebuildAll ? 'No course files to index.' : 'Every course file is already indexed. Use --all to rebuild.');
    db.close();
    return;
  }
  console.log(`Indexing ${files.length} file(s)...`);
  for (const f of files) {
    process.stdout.write(`  ${f.title} ... `);
    await indexFile(f.id);
    const after = all<{ status: string; chunk_count: number; error: string | null }>(
      'SELECT status, chunk_count, error FROM course_files WHERE id = ?', f.id,
    )[0];
    console.log(after.status === 'indexed' ? `${after.chunk_count} passages` : `FAILED: ${after.error}`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
