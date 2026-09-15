-- SelfLatitude Companion - SQLite schema
-- Applied by src/db/migrate.ts (idempotent: every statement uses IF NOT EXISTS)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Users, sessions, auth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                TEXT NOT NULL DEFAULT '',
  password_hash       TEXT,
  role                TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','owner','superadmin')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  -- course entitlement is lifetime; companion access has dates
  course_access       INTEGER NOT NULL DEFAULT 1,
  companion_start     TEXT,            -- ISO date when companion access began (anchor for monthly period)
  companion_end       TEXT,            -- ISO date when companion access expires (renewal extends)
  -- usage overrides (NULL = use global settings)
  reply_limit_override INTEGER,
  cost_limit_override  REAL,
  -- preferences / consent
  memory_enabled_default INTEGER NOT NULL DEFAULT 1,
  journal_share_allowed  INTEGER NOT NULL DEFAULT 1,
  onboarding_completed   INTEGER NOT NULL DEFAULT 0,
  terms_version        TEXT,
  privacy_version      TEXT,
  consent_at           TEXT,
  -- MFA (required for superadmin)
  mfa_secret_enc       TEXT,
  mfa_enabled          INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,           -- random token hash
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- password reset, one-time login, email verification
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,           -- sha256 of raw token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('password_reset','one_time_login','email_change')),
  payload     TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

-- ---------------------------------------------------------------------------
-- Companion configuration (draft -> publish -> versions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companion_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_number  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  instructions    TEXT NOT NULL DEFAULT '',
  safety_rules    TEXT NOT NULL DEFAULT '',
  starters_json   TEXT NOT NULL DEFAULT '[]',     -- [{title, prompt}]
  models_json     TEXT NOT NULL DEFAULT '[]',     -- [{id, label, included, default, inputPer1M, outputPer1M}]
  depth_json      TEXT NOT NULL DEFAULT '{}',     -- {fast:{maxTokens,instruction}, medium:{...}, extended:{...}}
  file_ids_json   TEXT NOT NULL DEFAULT '[]',     -- course_files included in this version
  published_at    TEXT,
  published_by    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_companion_versions_status ON companion_versions(status);

CREATE TABLE IF NOT EXISTS course_files (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  module_label  TEXT NOT NULL DEFAULT '',   -- e.g. "Module 3: Values"
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_path  TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','indexing','indexed','failed','removed')),
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS course_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       TEXT NOT NULL REFERENCES course_files(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  section_label TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  embedding     BLOB,                       -- Float32Array bytes; NULL when embeddings unavailable
  token_estimate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_course_chunks_file ON course_chunks(file_id);

CREATE VIRTUAL TABLE IF NOT EXISTS course_chunks_fts USING fts5(
  content, section_label, chunk_id UNINDEXED, file_id UNINDEXED
);

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT 'New conversation',
  title_auto     INTEGER NOT NULL DEFAULT 1,
  model_id       TEXT NOT NULL,
  depth          TEXT NOT NULL DEFAULT 'medium' CHECK (depth IN ('fast','medium','extended')),
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  is_temporary   INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,                       -- concise rolling summary for long chats
  summary_upto_message_id TEXT,
  last_message_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, archived, last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','stopped','failed')),
  model_id        TEXT,
  depth           TEXT,
  prompt_version  INTEGER,
  sources_json    TEXT,                     -- [{fileId, title, module, section}]
  attachments_json TEXT,                    -- [{type:'journal', entryId, title}]
  payment_source  TEXT,                     -- 'included' | 'customer_key'
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Structured memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category               TEXT NOT NULL DEFAULT 'theme'
                         CHECK (category IN ('value','goal','commitment','preference','theme','practice','other')),
  content                TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','disabled')),
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      TEXT,
  source_journal_id      TEXT,
  embedding              BLOB,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, status);

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  entry_date  TEXT NOT NULL,               -- YYYY-MM-DD
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  word_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_user_date ON journal_entries(user_id, entry_date);

-- ---------------------------------------------------------------------------
-- Usage ledger and customer API keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_ledger (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start    TEXT NOT NULL,            -- YYYY-MM-DD
  period_end      TEXT NOT NULL,            -- YYYY-MM-DD (exclusive)
  conversation_id TEXT,
  message_id      TEXT,
  model_id        TEXT NOT NULL,
  payment_source  TEXT NOT NULL CHECK (payment_source IN ('included','customer_key')),
  status          TEXT NOT NULL CHECK (status IN ('reserved','completed','failed','released')),
  reserved_cost   REAL NOT NULL DEFAULT 0,
  actual_cost     REAL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_ledger(user_id, period_start, status, payment_source);

CREATE TABLE IF NOT EXISTS customer_api_keys (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_enc        TEXT NOT NULL,             -- AES-256-GCM, base64 iv:tag:ciphertext
  last4          TEXT NOT NULL,
  validated_at   TEXT,
  valid          INTEGER NOT NULL DEFAULT 0,
  -- use_until = period_end of the period in which the user opted in; NULL = not active
  use_until      TEXT,
  keep_using     INTEGER NOT NULL DEFAULT 0, -- if 1, keep using own key after reset
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Settings, privacy, audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('access','correction','portability','deletion','consent','other')),
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  due_at      TEXT NOT NULL,
  admin_note  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details_json TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Plans (what SelfLatitude sells) and payments received from JVZoo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  price_cents        INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'USD',
  -- how much Companion access a purchase of this plan grants
  duration_months    INTEGER NOT NULL DEFAULT 12,    -- 0 = unlimited / lifetime companion
  grants_course      INTEGER NOT NULL DEFAULT 1,     -- lifetime course entitlement
  -- usage allowance (NULL = fall back to the global usage settings)
  replies_per_period INTEGER,
  cost_ceiling_usd   REAL,
  is_default         INTEGER NOT NULL DEFAULT 0,     -- used when a sale has no product mapping
  active             INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL DEFAULT 'jvzoo',   -- jvzoo | manual
  receipt          TEXT NOT NULL,                    -- ctransreceipt (idempotency key)
  transaction_type TEXT NOT NULL,                    -- SALE | BILL | RFND | CGBK | CANCEL-REBILL | ...
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  plan_id          TEXT REFERENCES plans(id) ON DELETE SET NULL,
  product_code     TEXT,                             -- cproditem
  product_title    TEXT,
  customer_email   TEXT,
  customer_name    TEXT,
  amount_cents     INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  affiliate        TEXT,
  payload_json     TEXT,                             -- raw IPN fields (no card data is sent by JVZoo)
  result           TEXT NOT NULL DEFAULT 'processed',-- processed | ignored | error
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source, receipt, transaction_type)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- Short-lived numeric codes emailed for sign-in verification (two-step by email)
CREATE TABLE IF NOT EXISTS login_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'mfa',   -- mfa | verify_email
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id, purpose);
