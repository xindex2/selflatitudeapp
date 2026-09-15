import { one, run, all, nowIso, tx } from '../db/db.js';
import type { ModelOption, DepthOption } from './defaults.js';

export interface CompanionConfig {
  id: number;
  versionNumber: number;
  status: 'draft' | 'published' | 'archived';
  name: string;
  description: string;
  instructions: string;
  safetyRules: string;
  starters: { title: string; prompt: string }[];
  models: ModelOption[];
  depth: Record<'fast' | 'medium' | 'extended', DepthOption>;
  fileIds: string[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToConfig(r: any): CompanionConfig {
  return {
    id: r.id,
    versionNumber: r.version_number,
    status: r.status,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    safetyRules: r.safety_rules,
    starters: JSON.parse(r.starters_json || '[]'),
    models: JSON.parse(r.models_json || '[]'),
    depth: JSON.parse(r.depth_json || '{}'),
    fileIds: JSON.parse(r.file_ids_json || '[]'),
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getPublished(): CompanionConfig {
  const r = one('SELECT * FROM companion_versions WHERE status = ? ORDER BY version_number DESC LIMIT 1', 'published');
  if (!r) throw new Error('No published companion version');
  return rowToConfig(r);
}

export function getDraft(): CompanionConfig | null {
  const r = one('SELECT * FROM companion_versions WHERE status = ? ORDER BY id DESC LIMIT 1', 'draft');
  return r ? rowToConfig(r) : null;
}

export function getVersion(id: number): CompanionConfig | null {
  const r = one('SELECT * FROM companion_versions WHERE id = ?', id);
  return r ? rowToConfig(r) : null;
}

export function listVersions() {
  return all(
    `SELECT id, version_number, status, name, published_at, published_by, created_at, updated_at
     FROM companion_versions ORDER BY version_number DESC, id DESC`,
  );
}

/** Create a draft copied from the published version (or return the existing draft). */
export function ensureDraft(): CompanionConfig {
  const existing = getDraft();
  if (existing) return existing;
  const pub = getPublished();
  const next = (one<{ m: number }>('SELECT MAX(version_number) AS m FROM companion_versions')!.m ?? 0) + 1;
  const info = run(
    `INSERT INTO companion_versions (version_number, status, name, description, instructions, safety_rules, starters_json, models_json, depth_json, file_ids_json)
     VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    next, pub.name, pub.description, pub.instructions, pub.safetyRules,
    JSON.stringify(pub.starters), JSON.stringify(pub.models), JSON.stringify(pub.depth), JSON.stringify(pub.fileIds),
  );
  return getVersion(Number(info.lastInsertRowid))!;
}

export function updateDraft(patch: Partial<Omit<CompanionConfig, 'id' | 'versionNumber' | 'status'>>): CompanionConfig {
  const d = ensureDraft();
  const merged = { ...d, ...patch };
  run(
    `UPDATE companion_versions SET name=?, description=?, instructions=?, safety_rules=?, starters_json=?, models_json=?, depth_json=?, file_ids_json=?, updated_at=? WHERE id=?`,
    merged.name, merged.description, merged.instructions, merged.safetyRules,
    JSON.stringify(merged.starters), JSON.stringify(merged.models), JSON.stringify(merged.depth), JSON.stringify(merged.fileIds),
    nowIso(), d.id,
  );
  return getVersion(d.id)!;
}

export function publishDraft(publishedBy: string): CompanionConfig {
  return tx(() => {
    const d = getDraft();
    if (!d) throw new Error('No draft to publish');
    run(`UPDATE companion_versions SET status='archived' WHERE status='published'`);
    run(`UPDATE companion_versions SET status='published', published_at=?, published_by=?, updated_at=? WHERE id=?`, nowIso(), publishedBy, nowIso(), d.id);
    return getVersion(d.id)!;
  });
}

export function discardDraft() {
  run(`DELETE FROM companion_versions WHERE status='draft'`);
}

/** Restore: copy an archived version into a new draft so the owner can review and publish it. */
export function restoreVersionAsDraft(id: number): CompanionConfig {
  const v = getVersion(id);
  if (!v) throw new Error('Version not found');
  return tx(() => {
    discardDraft();
    const next = (one<{ m: number }>('SELECT MAX(version_number) AS m FROM companion_versions')!.m ?? 0) + 1;
    const info = run(
      `INSERT INTO companion_versions (version_number, status, name, description, instructions, safety_rules, starters_json, models_json, depth_json, file_ids_json)
       VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      next, v.name, v.description, v.instructions, v.safetyRules,
      JSON.stringify(v.starters), JSON.stringify(v.models), JSON.stringify(v.depth), JSON.stringify(v.fileIds),
    );
    return getVersion(Number(info.lastInsertRowid))!;
  });
}

/** What students are allowed to see/select. */
export function studentModels(cfg: CompanionConfig) {
  return cfg.models
    .filter((m) => m.enabled)
    .map((m) => ({ id: m.id, label: m.label, included: m.included, isDefault: !!m.isDefault }));
}

export function defaultModelId(cfg: CompanionConfig): string {
  const enabled = cfg.models.filter((m) => m.enabled);
  return (enabled.find((m) => m.isDefault) ?? enabled.find((m) => m.included) ?? enabled[0])?.id ?? 'gpt-4.1-mini';
}

export function estimateCost(model: ModelOption | undefined, inputTokens: number, outputTokens: number): number {
  if (!model) return 0;
  return (inputTokens * model.inputPer1M + outputTokens * model.outputPer1M) / 1_000_000;
}
