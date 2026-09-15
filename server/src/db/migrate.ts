import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, one, all, setSetting } from './db.js';
import { DEFAULT_USAGE_SETTINGS, DEFAULT_COMPANION, DEFAULT_PLANS } from '../lib/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Add a column to an existing table if it is missing (SQLite has no IF NOT EXISTS for columns). */
function ensureColumn(table: string, column: string, definition: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // --- columns added after the first release -------------------------------
  ensureColumn('users', 'plan_id', 'TEXT REFERENCES plans(id)');
  ensureColumn('users', 'mfa_method', "TEXT NOT NULL DEFAULT 'none'"); // none | totp | email
  ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'source', "TEXT NOT NULL DEFAULT 'manual'"); // manual | self | jvzoo
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'avatar_path', 'TEXT');       // profile picture, stored under UPLOAD_DIR/avatars
  ensureColumn('users', 'pending_email', 'TEXT');     // set while an email change is awaiting its code
  // What a payment granted, so a refund or chargeback can reverse exactly that purchase.
  ensureColumn('payments', 'months_granted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('payments', 'granted_course', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('payments', 'granted_unlimited', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('payments', 'reversed_at', 'TEXT');
  ensureColumn('payments', 'reversed_by', 'TEXT');    // receipt of the refund/chargeback
  // Existing accounts with a TOTP secret keep working under the new column.
  db.exec(`UPDATE users SET mfa_method = 'totp' WHERE mfa_enabled = 1 AND mfa_method = 'none'`);

  // --- seed data the owner can edit later -----------------------------------
  if (!one('SELECT key FROM settings WHERE key = ?', 'usage')) {
    setSetting('usage', DEFAULT_USAGE_SETTINGS);
  }
  if (!one('SELECT id FROM companion_versions LIMIT 1')) {
    db.prepare(
      `INSERT INTO companion_versions (version_number, status, name, description, instructions, safety_rules,
        starters_json, models_json, depth_json, file_ids_json, published_at)
       VALUES (1, 'published', ?, ?, ?, ?, ?, ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      DEFAULT_COMPANION.name,
      DEFAULT_COMPANION.description,
      DEFAULT_COMPANION.instructions,
      DEFAULT_COMPANION.safetyRules,
      JSON.stringify(DEFAULT_COMPANION.starters),
      JSON.stringify(DEFAULT_COMPANION.models),
      JSON.stringify(DEFAULT_COMPANION.depth),
    );
  }
  if (!one('SELECT id FROM plans LIMIT 1')) {
    const ins = db.prepare(
      `INSERT INTO plans (id, name, description, price_cents, currency, duration_months, grants_course, replies_per_period, cost_ceiling_usd, is_default, active, sort_order)
       VALUES (@id, @name, @description, @priceCents, @currency, @durationMonths, @grantsCourse, @repliesPerPeriod, @costCeilingUsd, @isDefault, 1, @sortOrder)`,
    );
    for (const p of DEFAULT_PLANS) ins.run(p);
  }
}

// Allow `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate();
  console.log('Migration complete:', db.name);
}
