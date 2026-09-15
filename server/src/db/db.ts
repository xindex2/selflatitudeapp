import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export type Row = Record<string, any>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function one<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
export const tx = <T>(fn: () => T): T => db.transaction(fn)();
/** Takes the write lock up front (BEGIN IMMEDIATE) so concurrent readers cannot race a check-then-write. */
export const txImmediate = <T>(fn: () => T): T => db.transaction(fn).immediate();

/** settings table helpers */
export function getSetting<T>(key: string, fallback: T): T {
  const row = one<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}
export function setSetting(key: string, value: unknown) {
  run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    nowIso(),
  );
}
