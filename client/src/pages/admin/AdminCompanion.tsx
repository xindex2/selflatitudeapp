import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamPost } from '../../api/client';
import type { CompanionConfig, CourseFile, Depth, DepthOption, ModelOption, Source } from '../../api/types';
import { Alert, Field, Icons, Modal, Spinner, Tabs, formatDate, formatDateTime, useConfirm, useToast } from '../../components/ui';
import { errMsg } from './adminShared';
import './admin.css';

/* ------------------------------------------------------------------ Types */
type Editable = Pick<CompanionConfig, 'name' | 'description' | 'instructions' | 'safetyRules' | 'starters' | 'models' | 'depth' | 'fileIds'>;
type Tab = 'basics' | 'instructions' | 'starters' | 'models' | 'files' | 'preview' | 'versions';
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface VersionRow {
  id: number;
  version_number: number;
  status: 'draft' | 'published' | 'archived';
  name: string;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}
interface CompanionResponse { published: CompanionConfig; draft: CompanionConfig | null; versions: VersionRow[] }

const TABS: { id: Tab; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'starters', label: 'Starters' },
  { id: 'models', label: 'Models & depth' },
  { id: 'files', label: 'Course files' },
  { id: 'preview', label: 'Preview' },
  { id: 'versions', label: 'Versions' },
];
const DEPTHS: Depth[] = ['fast', 'medium', 'extended'];
const MAX_STARTERS = 12;
const AUTOSAVE_MS = 1500;

const pickEditable = (c: CompanionConfig): Editable => ({
  name: c.name ?? '',
  description: c.description ?? '',
  instructions: c.instructions ?? '',
  safetyRules: c.safetyRules ?? '',
  starters: (c.starters ?? []).map((s) => ({ title: s.title ?? '', prompt: s.prompt ?? '' })),
  models: (c.models ?? []).map((m) => ({ ...m, isDefault: !!m.isDefault })),
  depth: c.depth,
  fileIds: [...(c.fileIds ?? [])],
});

function validateModels(models: ModelOption[]): string | null {
  const enabled = models.filter((m) => m.enabled);
  if (enabled.length === 0) return 'Enable at least one model.';
  const defaults = enabled.filter((m) => m.isDefault);
  if (defaults.length !== 1) return 'Choose exactly one default model among the enabled models.';
  if (models.some((m) => !m.id.trim())) return 'Every model needs a model ID.';
  const ids = models.map((m) => m.id.trim());
  if (new Set(ids).size !== ids.length) return 'Model IDs must be unique.';
  return null;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ Page */
export default function AdminCompanion() {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [published, setPublished] = useState<CompanionConfig | null>(null);
  const [draft, setDraft] = useState<CompanionConfig | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [editable, setEditable] = useState<Editable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('basics');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const editableRef = useRef<Editable | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<CompanionResponse>('/api/admin/companion');
      setPublished(r.published);
      setDraft(r.draft);
      setVersions(r.versions ?? []);
      const e = pickEditable(r.draft ?? r.published);
      setEditable(e);
      editableRef.current = e;
      dirtyRef.current = false;
      setSaveState('idle');
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e, 'Could not load the Companion configuration.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Unsaved-changes guard
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || saveState === 'saving') { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    // A save already in flight: wait for it, then save again with the newest edits
    // rather than dropping them.
    if (savingRef.current) {
      const inFlight = savingRef.current;
      return inFlight.then((ok) => (dirtyRef.current ? saveDraft() : ok));
    }
    const body = editableRef.current;
    if (!body) return false;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setSaveState('saving');
    const p = (async () => {
      try {
        dirtyRef.current = false;
        const r = await api.put<{ draft: CompanionConfig }>('/api/admin/companion/draft', body);
        setDraft(r.draft);
        setVersions((vs) => (vs.some((v) => v.id === r.draft.id) ? vs : vs)); // refreshed on next load
        setSaveError(null);
        setSaveState(dirtyRef.current ? 'dirty' : 'saved');
        return true;
      } catch (e) {
        dirtyRef.current = true;
        setSaveError(errMsg(e, 'Could not save the draft.'));
        setSaveState('error');
        return false;
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = p;
    return p;
  }, []);

  const update = useCallback((patch: Partial<Editable> | ((prev: Editable) => Partial<Editable>)) => {
    setEditable((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
      editableRef.current = next;
      return next;
    });
    dirtyRef.current = true;
    setSaveState('dirty');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = null; saveDraft(); }, AUTOSAVE_MS);
  }, [saveDraft]);

  // Leaving the page (in-app navigation included) must not discard a pending autosave.
  useEffect(() => () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const body = editableRef.current;
    if (dirtyRef.current && body) {
      dirtyRef.current = false;
      api.put('/api/admin/companion/draft', body).catch(() => { /* the draft keeps its last saved state */ });
    }
  }, []);

  const modelError = useMemo(() => (editable ? validateModels(editable.models) : null), [editable]);

  const publish = async () => {
    setPublishing(true);
    try {
      if (dirtyRef.current || saveState === 'dirty' || saveState === 'error') {
        if (!(await saveDraft())) return;
      }
      const r = await api.post<{ published: CompanionConfig; versions: VersionRow[] }>('/api/admin/companion/publish');
      setPublished(r.published);
      setVersions(r.versions);
      setDraft(null);
      const e = pickEditable(r.published);
      setEditable(e);
      editableRef.current = e;
      dirtyRef.current = false;
      setSaveState('idle');
      setPublishOpen(false);
      toast(`Published v${r.published.versionNumber}.`, 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not publish.'), 'error');
    } finally {
      setPublishing(false);
    }
  };

  const discardDraft = async () => {
    if (!(await confirm('Discard the draft?', 'All unpublished changes are lost. The published version keeps serving students.', { danger: true, confirmLabel: 'Discard draft' }))) return;
    try {
      if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      await api.del('/api/admin/companion/draft');
      await load();
      toast('Draft discarded.', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not discard the draft.'), 'error');
    }
  };

  const restoreVersion = async (v: VersionRow) => {
    if (!(await confirm(`Restore v${v.version_number} as draft?`, draft ? 'The current draft is replaced by a copy of this version. Nothing is published until you publish.' : 'A new draft is created from this version. Nothing is published until you publish.', { confirmLabel: 'Restore as draft' }))) return;
    try {
      if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      await api.post(`/api/admin/companion/versions/${v.id}/restore`);
      await load();
      setTab('basics');
      toast(`v${v.version_number} restored as draft.`, 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not restore this version.'), 'error');
    }
  };

  if (loadError) {
    return (
      <div className="page admin-page">
        <div className="page-header"><div><h1>Companion configuration</h1></div></div>
        <Alert kind="error">{loadError}</Alert>
      </div>
    );
  }
  if (!published || !editable) return <div className="page admin-page"><Spinner /></div>;

  const saveLabel = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved draft' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'error' ? 'Save failed' : '';

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Companion configuration</h1>
          <p>
            Published: v{published.versionNumber}{published.publishedAt ? ` on ${formatDateTime(published.publishedAt)}` : ''}
          </p>
          {draft ? (
            <p style={{ marginTop: 6 }}><span className="chip warning">Unpublished draft v{draft.versionNumber}</span></p>
          ) : (
            <p className="meta" style={{ marginTop: 6 }}>No draft. Editing any field creates one.</p>
          )}
        </div>
        <div className="companion-status">
          <div className="row">
            <span className={`save-status ${saveState === 'dirty' ? 'dirty' : saveState === 'error' ? 'error' : ''}`} aria-live="polite">{saveLabel}</span>
            <button className="btn primary" disabled={saveState === 'saving' || (saveState !== 'dirty' && saveState !== 'error')} onClick={() => saveDraft()}>
              {saveState === 'saving' ? <Spinner /> : null} Save draft
            </button>
          </div>
          {draft ? (
            <div className="row">
              <button className="btn secondary sm" onClick={discardDraft}>Discard draft</button>
              <button className="btn secondary sm" disabled={!!modelError || publishing} onClick={() => setPublishOpen(true)}>Publish</button>
            </div>
          ) : null}
        </div>
      </div>

      {saveError ? <div className="section"><Alert kind="error">{saveError}</Alert></div> : null}

      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="tab-body">
        {tab === 'basics' ? <BasicsTab e={editable} update={update} /> : null}
        {tab === 'instructions' ? <InstructionsTab e={editable} update={update} /> : null}
        {tab === 'starters' ? <StartersTab e={editable} update={update} /> : null}
        {tab === 'models' ? <ModelsTab e={editable} update={update} error={modelError} /> : null}
        {tab === 'files' ? <FilesTab e={editable} update={update} /> : null}
        {tab === 'preview' ? <PreviewTab e={editable} draftExists={!!draft} saveDraft={saveDraft} /> : null}
        {tab === 'versions' ? <VersionsTab versions={versions} onRestore={restoreVersion} /> : null}
      </div>

      {confirmEl}
      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title={`Publish draft v${draft?.versionNumber ?? ''}?`}
        actions={
          <>
            <button className="btn secondary" onClick={() => setPublishOpen(false)} disabled={publishing}>Cancel</button>
            <button className="btn primary" onClick={publish} disabled={publishing}>{publishing ? <Spinner /> : null} Publish</button>
          </>
        }
      >
        <p className="small">Students will start receiving the new version immediately, including inside existing conversations.</p>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ Basics */
function BasicsTab({ e, update }: { e: Editable; update: (p: Partial<Editable>) => void }) {
  return (
    <div className="card stack">
      <Field label="Name" hint="Shown to students as the Companion's name.">
        <input className="input" value={e.name} maxLength={80} onChange={(ev) => update({ name: ev.target.value })} />
      </Field>
      <Field label="Description" hint="A short description shown on the welcome screen.">
        <textarea className="textarea" value={e.description} maxLength={600} onChange={(ev) => update({ description: ev.target.value })} />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ Instructions */
function InstructionsTab({ e, update }: { e: Editable; update: (p: Partial<Editable>) => void }) {
  return (
    <>
      <div className="card">
        <Field label="Instructions" hint="The system prompt. Describe the Companion's role, tone, how it uses course material, and what it should avoid.">
          <textarea className="textarea code" value={e.instructions} onChange={(ev) => update({ instructions: ev.target.value })} spellCheck={false} />
        </Field>
        <div className="char-count">{e.instructions.length.toLocaleString()} characters</div>
      </div>
      <div className="card">
        <Field label="Safety rules" hint="Always applied. Keep the fixed non-clinical safety wording here.">
          <textarea className="textarea safety" value={e.safetyRules} onChange={(ev) => update({ safetyRules: ev.target.value })} spellCheck={false} />
        </Field>
        <div className="char-count">{e.safetyRules.length.toLocaleString()} characters</div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Starters */
function StartersTab({ e, update }: { e: Editable; update: (p: Partial<Editable>) => void }) {
  const set = (i: number, patch: Partial<{ title: string; prompt: string }>) =>
    update({ starters: e.starters.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= e.starters.length) return;
    const arr = [...e.starters];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    update({ starters: arr });
  };
  const remove = (i: number) => update({ starters: e.starters.filter((_, j) => j !== i) });
  const add = () => e.starters.length < MAX_STARTERS && update({ starters: [...e.starters, { title: '', prompt: '' }] });

  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 2 }}>Conversation starters</h2>
          <div className="meta">Shown on the new-chat screen. {e.starters.length} of {MAX_STARTERS}.</div>
        </div>
        <button className="btn secondary sm" onClick={add} disabled={e.starters.length >= MAX_STARTERS}><Icons.plus size={16} /> Add starter</button>
      </div>
      {e.starters.length === 0 ? <p className="muted">No starters yet.</p> : null}
      {e.starters.map((s, i) => (
        <div className="starter-row" key={i}>
          <Field label={`Title ${i + 1}`}>
            <input className="input" value={s.title} maxLength={80} onChange={(ev) => set(i, { title: ev.target.value })} placeholder="Short label" />
          </Field>
          <Field label="Prompt">
            <textarea className="textarea" value={s.prompt} maxLength={1000} onChange={(ev) => set(i, { prompt: ev.target.value })} placeholder="The message sent when the student picks this starter" />
          </Field>
          <div className="controls" style={{ paddingTop: 26 }}>
            <button className="btn secondary icon sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icons.chevronDown size={16} className="rot180" /></button>
            <button className="btn secondary icon sm" aria-label="Move down" disabled={i === e.starters.length - 1} onClick={() => move(i, 1)}><Icons.chevronDown size={16} /></button>
            <button className="btn danger-outline icon sm" aria-label="Remove starter" onClick={() => remove(i)}><Icons.trash size={16} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* Starting-point prices (USD per 1M tokens) for models added from the live list; owner can edit. */
const KNOWN_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'o3': { input: 2, output: 8 },
};

/* ------------------------------------------------------------------ Models & depth */
function ModelsTab({ e, update, error }: { e: Editable; update: (p: Partial<Editable>) => void; error: string | null }) {
  const setModel = (i: number, patch: Partial<ModelOption>) => update({ models: e.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setDefault = (i: number) => update({ models: e.models.map((m, j) => ({ ...m, isDefault: j === i })) });
  const removeModel = (i: number) => update({ models: e.models.filter((_, j) => j !== i) });
  const addModel = () => update({ models: [...e.models, { id: '', label: '', included: true, isDefault: e.models.length === 0, inputPer1M: 0, outputPer1M: 0, enabled: true }] });
  const numVal = (n: number) => (Number.isFinite(n) ? String(n) : '');
  const setDepth = (d: Depth, patch: Partial<DepthOption>) => update({ depth: { ...e.depth, [d]: { ...e.depth[d], ...patch } } });

  // Live model list from the OpenAI API (owner picks the newest models without a deploy)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [live, setLive] = useState<{ id: string; created: number; reasoning: boolean }[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveFilter, setLiveFilter] = useState('');
  const openPicker = async () => {
    setPickerOpen(true);
    if (live) return;
    try {
      const r = await api.get<{ models: { id: string; created: number; reasoning: boolean }[] }>('/api/admin/openai/models');
      setLive(r.models);
      setLiveError(null);
    } catch (err) {
      setLiveError(errMsg(err, 'Could not load models from OpenAI. Check that OPENAI_API_KEY is configured.'));
    }
  };
  const addFromLive = (id: string) => {
    if (e.models.some((m) => m.id === id)) return;
    const guess = KNOWN_PRICES[id] ?? Object.entries(KNOWN_PRICES).find(([k]) => id.startsWith(k))?.[1] ?? { input: 0, output: 0 };
    update({ models: [...e.models, { id, label: id, included: false, isDefault: e.models.length === 0, inputPer1M: guess.input, outputPer1M: guess.output, enabled: true }] });
  };
  const liveShown = (live ?? []).filter((m) => m.id.includes(liveFilter.trim().toLowerCase()));

  return (
    <>
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Add a model from OpenAI" wide>
        <p className="meta">This is the live list of chat-capable models available to SelfLatitude's OpenAI account, newest first. Added models start disabled for included usage; set prices and labels afterwards.</p>
        {liveError ? <Alert kind="error">{liveError}</Alert> : null}
        {!live && !liveError ? <Spinner /> : null}
        {live ? (
          <>
            <input className="input" placeholder="Filter (e.g. gpt-5)" value={liveFilter} onChange={(ev) => setLiveFilter(ev.target.value)} style={{ margin: '8px 0' }} />
            <div className="live-models">
              {liveShown.map((m) => {
                const added = e.models.some((x) => x.id === m.id);
                return (
                  <div key={m.id} className="live-model-row">
                    <div className="grow">
                      <span className="mono">{m.id}</span>
                      <div className="meta">Released {formatDate(new Date(m.created * 1000).toISOString())}{m.reasoning ? ' · reasoning model' : ''}</div>
                    </div>
                    <button className="btn secondary sm" disabled={added} onClick={() => addFromLive(m.id)}>{added ? 'Added' : 'Add'}</button>
                  </div>
                );
              })}
              {liveShown.length === 0 ? <div className="muted small">No models match.</div> : null}
            </div>
          </>
        ) : null}
      </Modal>
      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>Models</h2>
            <div className="meta">Models students can choose. Prices are used to measure cost against the ceiling.</div>
          </div>
          <div className="row">
            <button className="btn secondary sm" onClick={openPicker}><Icons.sparkle size={16} /> Add from OpenAI</button>
            <button className="btn secondary sm" onClick={addModel}><Icons.plus size={16} /> Add manually</button>
          </div>
        </div>
        {error ? <div style={{ marginBottom: 12 }}><Alert kind="warning">{error}</Alert></div> : null}
        <div className="table-wrap">
          <table className="table models-table">
            <thead>
              <tr>
                <th>Model ID</th>
                <th>Label</th>
                <th>Enabled</th>
                <th>Included usage</th>
                <th>Default</th>
                <th>Input $/1M</th>
                <th>Output $/1M</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {e.models.map((m, i) => (
                <tr key={i}>
                  <td><input className="input mono" value={m.id} onChange={(ev) => setModel(i, { id: ev.target.value })} placeholder="gpt-5-mini" aria-label="Model ID" /></td>
                  <td><input className="input" value={m.label} onChange={(ev) => setModel(i, { label: ev.target.value })} placeholder="Display name" aria-label="Label" /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={m.enabled} onChange={(ev) => setModel(i, { enabled: ev.target.checked })} aria-label="Enabled" /></td>
                  <td>
                    <label className="checkbox small" style={{ alignItems: 'center' }}>
                      <input type="checkbox" checked={m.included} onChange={(ev) => setModel(i, { included: ev.target.checked })} />
                      <span className="meta">Available with included usage</span>
                    </label>
                  </td>
                  <td style={{ textAlign: 'center' }}><input type="radio" name="default-model" checked={!!m.isDefault} disabled={!m.enabled} onChange={() => setDefault(i)} aria-label="Default model" /></td>
                  <td><input className="input" type="number" min={0} step={0.01} value={numVal(m.inputPer1M)} onChange={(ev) => setModel(i, { inputPer1M: Number(ev.target.value) })} aria-label="Input price per 1M tokens" /></td>
                  <td><input className="input" type="number" min={0} step={0.01} value={numVal(m.outputPer1M)} onChange={(ev) => setModel(i, { outputPer1M: Number(ev.target.value) })} aria-label="Output price per 1M tokens" /></td>
                  <td><button className="btn danger-outline icon sm" aria-label="Remove model" onClick={() => removeModel(i)}><Icons.trash size={16} /></button></td>
                </tr>
              ))}
              {e.models.length === 0 ? <tr><td colSpan={8} className="muted" style={{ textAlign: 'center' }}>No models. Add at least one.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className="meta" style={{ margin: '10px 0 0' }}>Unchecking "Included usage" means the model requires the student's own API key.</p>
      </div>

      <div className="card">
        <h2>Depth</h2>
        <div className="meta" style={{ marginBottom: 12 }}>Students pick a depth per conversation. Each depth sets a label, an output limit, and an instruction appended to the prompt.</div>
        <div className="depth-grid">
          {DEPTHS.map((d) => {
            const opt = e.depth?.[d] ?? { label: '', maxOutputTokens: 0, instruction: '' };
            return (
              <div className="card subtle depth-card" key={d}>
                <h3 style={{ marginBottom: 8, textTransform: 'capitalize' }}>{d}</h3>
                <Field label="Label"><input className="input" value={opt.label} onChange={(ev) => setDepth(d, { label: ev.target.value })} /></Field>
                <Field label="Max output tokens"><input className="input" type="number" min={1} step={1} value={numVal(opt.maxOutputTokens)} onChange={(ev) => setDepth(d, { maxOutputTokens: Number(ev.target.value) })} /></Field>
                <Field label="Reasoning effort" hint="Used by GPT-5 and o-series models only.">
                  <select className="select" value={opt.reasoning ?? 'low'} onChange={(ev) => setDepth(d, { reasoning: ev.target.value as DepthOption['reasoning'] })}>
                    <option value="minimal">Minimal (fastest)</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High (slowest, deepest)</option>
                  </select>
                </Field>
                <Field label="Instruction"><textarea className="textarea" value={opt.instruction} onChange={(ev) => setDepth(d, { instruction: ev.target.value })} /></Field>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Course files */
function FilesTab({ e, update }: { e: Editable; update: (p: Partial<Editable> | ((prev: Editable) => Partial<Editable>)) => void }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [files, setFiles] = useState<CourseFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadModule, setUploadModule] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { title: string; moduleLabel: string }>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ files: CourseFile[] }>('/api/admin/files');
      setFiles(r.files.filter((f) => f.status !== 'removed').sort((a, b) => a.sortOrder - b.sortOrder));
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'Could not load course files.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Poll while anything is being indexed
  const pending = !!files?.some((f) => f.status === 'uploaded' || f.status === 'indexing');
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [pending, load]);

  const upload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('title', uploadTitle.trim() || uploadFile.name);
      form.append('moduleLabel', uploadModule.trim());
      const r = await api.upload<{ file: CourseFile }>('/api/admin/files', form);
      // The server adds the file to the draft; mirror that locally so the next save keeps it.
      update((prev) => ({ fileIds: prev.fileIds.includes(r.file.id) ? prev.fileIds : [...prev.fileIds, r.file.id] }));
      setUploadFile(null); setUploadTitle(''); setUploadModule('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast('Uploaded. Indexing in the background.', 'success');
      await load();
    } catch (err) {
      toast(errMsg(err, 'Upload failed.'), 'error');
    } finally {
      setUploading(false);
    }
  };

  const patchFile = async (id: string, body: Partial<Pick<CourseFile, 'title' | 'moduleLabel' | 'sortOrder'>>) => {
    setBusyId(id);
    try {
      const r = await api.patch<{ file: CourseFile }>(`/api/admin/files/${id}`, body);
      setFiles((fs) => fs?.map((f) => (f.id === id ? r.file : f)).sort((a, b) => a.sortOrder - b.sortOrder) ?? fs);
    } catch (err) {
      toast(errMsg(err, 'Could not update the file.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const commitEdit = (f: CourseFile) => {
    const ed = edits[f.id];
    if (!ed) return;
    const body: Partial<CourseFile> = {};
    if (ed.title !== f.title) body.title = ed.title;
    if (ed.moduleLabel !== f.moduleLabel) body.moduleLabel = ed.moduleLabel;
    setEdits((x) => { const { [f.id]: _, ...rest } = x; return rest; });
    if (Object.keys(body).length) patchFile(f.id, body);
  };

  const move = async (i: number, dir: -1 | 1) => {
    if (!files) return;
    const j = i + dir;
    if (j < 0 || j >= files.length) return;
    const a = files[i], b = files[j];
    const aOrder = a.sortOrder, bOrder = b.sortOrder;
    const newA = aOrder === bOrder ? aOrder + dir : bOrder;
    const newB = aOrder === bOrder ? bOrder : aOrder;
    const arr = [...files];
    [arr[i], arr[j]] = [{ ...b, sortOrder: newB }, { ...a, sortOrder: newA }];
    setFiles(arr);
    setBusyId(a.id);
    try {
      await api.patch(`/api/admin/files/${a.id}`, { sortOrder: newA });
      await api.patch(`/api/admin/files/${b.id}`, { sortOrder: newB });
    } catch (err) {
      toast(errMsg(err, 'Could not reorder.'), 'error');
      load();
    } finally {
      setBusyId(null);
    }
  };

  const reindex = async (f: CourseFile) => {
    setBusyId(f.id);
    try {
      const r = await api.post<{ file: CourseFile }>(`/api/admin/files/${f.id}/reindex`);
      setFiles((fs) => fs?.map((x) => (x.id === f.id ? r.file : x)) ?? fs);
      toast('Reindexing started.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Could not reindex.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const replace = async (f: CourseFile, ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    setBusyId(f.id);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.upload<{ file: CourseFile }>(`/api/admin/files/${f.id}/replace`, form);
      setFiles((fs) => fs?.map((x) => (x.id === f.id ? r.file : x)) ?? fs);
      toast('File replaced. Reindexing.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Could not replace the file.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (f: CourseFile) => {
    if (!(await confirm('Remove this course file?', `"${f.title}" is removed from the index and from every version that references it.`, { danger: true, confirmLabel: 'Remove' }))) return;
    setBusyId(f.id);
    try {
      await api.del(`/api/admin/files/${f.id}`);
      setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? fs);
      update((prev) => ({ fileIds: prev.fileIds.filter((id) => id !== f.id) }));
      toast('File removed.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Could not remove the file.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleInDraft = (id: string, on: boolean) =>
    update((prev) => ({ fileIds: on ? (prev.fileIds.includes(id) ? prev.fileIds : [...prev.fileIds, id]) : prev.fileIds.filter((x) => x !== id) }));

  const statusChip = (f: CourseFile) => {
    switch (f.status) {
      case 'indexed': return <span className="chip success">Indexed · {f.chunkCount} passage{f.chunkCount === 1 ? '' : 's'}</span>;
      case 'indexing': return <span className="chip info">Indexing…</span>;
      case 'failed': return <span className="chip error" title={f.error ?? ''}>Failed{f.error ? ` · ${f.error}` : ''}</span>;
      default: return <span className="chip">Uploaded</span>;
    }
  };

  return (
    <>
      <div className="card">
        <h2>Upload a course file</h2>
        <div className="meta" style={{ marginBottom: 12 }}>PDF, Word, text, Markdown, or HTML. Files are split into passages and indexed for retrieval. New uploads are added to the draft automatically.</div>
        <div className="upload-area">
          <Field label="File">
            <input ref={fileInputRef} className="file-input" type="file" accept=".pdf,.docx,.txt,.md,.html" onChange={(ev) => setUploadFile(ev.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Title"><input className="input" value={uploadTitle} onChange={(ev) => setUploadTitle(ev.target.value)} placeholder={uploadFile?.name ?? 'Defaults to file name'} /></Field>
          <Field label="Module label"><input className="input" value={uploadModule} onChange={(ev) => setUploadModule(ev.target.value)} placeholder="e.g. Module 2" /></Field>
          <button className="btn primary" disabled={!uploadFile || uploading} onClick={upload}>{uploading ? <Spinner /> : null} Upload</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {error ? <div style={{ padding: 16 }}><Alert kind="error">{error}</Alert></div> : null}
        {!files && !error ? <div style={{ padding: 16 }}><Spinner /></div> : null}
        {files ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Title</th>
                  <th>Module</th>
                  <th>File</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>In draft</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f, i) => {
                  const ed = edits[f.id] ?? { title: f.title, moduleLabel: f.moduleLabel };
                  const busy = busyId === f.id;
                  return (
                    <tr key={f.id}>
                      <td className="actions-cell">
                        <button className="btn secondary icon sm" aria-label="Move up" disabled={i === 0 || !!busyId} onClick={() => move(i, -1)}><Icons.chevronDown size={14} className="rot180" /></button>
                        <button className="btn secondary icon sm" aria-label="Move down" disabled={i === files.length - 1 || !!busyId} onClick={() => move(i, 1)}><Icons.chevronDown size={14} /></button>
                      </td>
                      <td><input className="input inline-input" value={ed.title} onChange={(ev) => setEdits((x) => ({ ...x, [f.id]: { ...ed, title: ev.target.value } }))} onBlur={() => commitEdit(f)} aria-label="Title" /></td>
                      <td><input className="input inline-input" value={ed.moduleLabel} onChange={(ev) => setEdits((x) => ({ ...x, [f.id]: { ...ed, moduleLabel: ev.target.value } }))} onBlur={() => commitEdit(f)} aria-label="Module label" /></td>
                      <td className="small" title={f.originalName}>{f.originalName}</td>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{formatBytes(f.sizeBytes)}</td>
                      <td>{statusChip(f)}</td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={e.fileIds.includes(f.id)} onChange={(ev) => toggleInDraft(f.id, ev.target.checked)} aria-label="Include in draft" style={{ width: 18, height: 18, accentColor: 'var(--sl-action-primary)' }} /></td>
                      <td className="actions-cell">
                        <button className="btn secondary sm" disabled={busy || f.status === 'indexing'} onClick={() => reindex(f)}>{busy ? <Spinner /> : null} Reindex</button>
                        <button className="btn secondary sm" disabled={busy} onClick={() => replaceRefs.current[f.id]?.click()}>Replace</button>
                        <input ref={(el) => { replaceRefs.current[f.id] = el; }} type="file" accept=".pdf,.docx,.txt,.md,.html" className="visually-hidden" tabIndex={-1} onChange={(ev) => replace(f, ev)} aria-hidden="true" />
                        <button className="btn danger-outline sm" disabled={busy} onClick={() => remove(f)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
                {files.length === 0 ? <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 32 }}>No course files yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {confirmEl}
    </>
  );
}

/* ------------------------------------------------------------------ Preview */
interface PreviewMessage { role: 'user' | 'assistant'; content: string; sources?: Source[]; error?: string | null; streaming?: boolean }

function PreviewTab({ e, draftExists, saveDraft }: { e: Editable; draftExists: boolean; saveDraft: () => Promise<boolean> }) {
  const enabledModels = e.models.filter((m) => m.enabled && m.id.trim());
  const defaultModel = enabledModels.find((m) => m.isDefault)?.id ?? enabledModels[0]?.id ?? '';
  const [modelId, setModelId] = useState(defaultModel);
  const [depth, setDepth] = useState<Depth>('medium');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!enabledModels.some((m) => m.id === modelId)) setModelId(defaultModel); }, [defaultModel, enabledModels, modelId]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    // Preview runs against the draft; make sure the latest edits are saved first.
    await saveDraft();
    const history = [...messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })), { role: 'user' as const, content: text }];
    setMessages((ms) => [...ms, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patchLast = (p: Partial<PreviewMessage> | ((m: PreviewMessage) => Partial<PreviewMessage>)) =>
      setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)));
    try {
      await streamPost('/api/admin/companion/preview', { messages: history, modelId: modelId || undefined, depth }, {
        signal: ctrl.signal,
        onEvent: (event, data) => {
          if (event === 'delta') patchLast((m) => ({ content: m.content + (data?.text ?? '') }));
          else if (event === 'done') patchLast((m) => ({ streaming: false, content: data?.content || m.content, sources: data?.sources ?? [], error: data?.status === 'failed' ? data?.error || 'The reply failed.' : null }));
          else if (event === 'error') patchLast({ streaming: false, error: data?.error || 'The request was rejected.' });
        },
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) patchLast({ streaming: false, error: errMsg(err, 'Preview failed.') });
    } finally {
      patchLast({ streaming: false });
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="stack">
      <Alert kind="info">Preview uses the current draft and is not saved or metered.{!draftExists ? ' No draft exists yet, so the preview reflects the published version until you edit something.' : ''}</Alert>
      <div className="preview">
        <div className="preview-controls">
          <select className="select" value={modelId} onChange={(ev) => setModelId(ev.target.value)} aria-label="Model">
            {enabledModels.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
            {enabledModels.length === 0 ? <option value="">No enabled models</option> : null}
          </select>
          <div className="segmented" role="group" aria-label="Depth">
            {DEPTHS.map((d) => (
              <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)}>{e.depth?.[d]?.label || d}</button>
            ))}
          </div>
          <div className="grow" />
          <button className="btn ghost sm" onClick={() => { abortRef.current?.abort(); setMessages([]); }} disabled={messages.length === 0}>Clear</button>
        </div>
        <div className="messages" ref={listRef}>
          {messages.length === 0 ? <p className="muted" style={{ margin: 'auto' }}>Send a message to test the draft.</p> : null}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'user' ? m.content : (
                <>
                  {m.content ? <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div> : m.streaming ? <Spinner /> : null}
                  {m.error ? <div className="error">{m.error}</div> : null}
                  {m.sources && m.sources.length ? (
                    <div className="meta sources">Sources: {m.sources.map((s, j) => <span key={j}>{j ? ' · ' : ''}{[s.module, s.title, s.section].filter(Boolean).join(' › ')}</span>)}</div>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea
            className="textarea grow"
            value={input}
            placeholder="Message the draft Companion"
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } }}
            rows={1}
            aria-label="Message"
          />
          {busy ? (
            <button className="btn secondary" onClick={() => abortRef.current?.abort()}><Icons.stop size={16} /> Stop</button>
          ) : (
            <button className="btn primary" onClick={send} disabled={!input.trim() || !modelId}><Icons.send size={16} /> Send</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Versions */
function VersionsTab({ versions, onRestore }: { versions: VersionRow[]; onRestore: (v: VersionRow) => void }) {
  const [view, setView] = useState<CompanionConfig | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const toast = useToast();

  const open = async (v: VersionRow) => {
    setLoadingId(v.id);
    try {
      const r = await api.get<{ version: CompanionConfig }>(`/api/admin/companion/versions/${v.id}`);
      setView(r.version);
    } catch (err) {
      toast(errMsg(err, 'Could not load this version.'), 'error');
    } finally {
      setLoadingId(null);
    }
  };

  const chip = (s: VersionRow['status']) => <span className={`chip ${s === 'published' ? 'success' : s === 'draft' ? 'warning' : ''}`}>{s === 'published' ? 'Published' : s === 'draft' ? 'Draft' : 'Archived'}</span>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Version</th><th>Status</th><th>Name</th><th>Published</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version_number}</td>
                <td>{chip(v.status)}</td>
                <td>{v.name}</td>
                <td className="small">{v.published_at ? <>{formatDateTime(v.published_at)}{v.published_by ? <span className="muted"> by {v.published_by}</span> : null}</> : <span className="muted">—</span>}</td>
                <td className="small">{formatDate(v.created_at)}</td>
                <td className="actions-cell">
                  <button className="btn secondary sm" disabled={loadingId === v.id} onClick={() => open(v)}>{loadingId === v.id ? <Spinner /> : null} View</button>
                  {v.status !== 'draft' ? <button className="btn secondary sm" onClick={() => onRestore(v)}>Restore as draft</button> : null}
                </td>
              </tr>
            ))}
            {versions.length === 0 ? <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No versions.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <Modal open={!!view} onClose={() => setView(null)} title={view ? `v${view.versionNumber} · ${view.name}` : ''} wide actions={<button className="btn primary" onClick={() => setView(null)}>Close</button>}>
        {view ? (
          <div className="stack version-view">
            <div className="meta">{view.status}{view.publishedAt ? ` · published ${formatDateTime(view.publishedAt)}` : ''} · {view.models.filter((m) => m.enabled).length} enabled model(s) · {view.fileIds.length} file(s)</div>
            <div><div className="label">Description</div><p className="small" style={{ margin: 0 }}>{view.description || <span className="muted">—</span>}</p></div>
            <div><div className="label">Instructions</div><pre>{view.instructions || '—'}</pre></div>
            <div><div className="label">Safety rules</div><pre>{view.safetyRules || '—'}</pre></div>
            <div>
              <div className="label">Starters</div>
              {view.starters.length ? <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>{view.starters.map((s, i) => <li key={i}><strong>{s.title}</strong>{s.prompt ? <span className="muted"> — {s.prompt}</span> : null}</li>)}</ul> : <span className="muted small">None</span>}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
