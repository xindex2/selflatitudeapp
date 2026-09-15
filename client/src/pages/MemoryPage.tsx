import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Memory, MemoryCategory } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Icons, Modal, Spinner, Tabs, Toggle, formatDate, useConfirm, useToast } from '../components/ui';
import './memory.css';

const CATEGORIES: { id: MemoryCategory; label: string }[] = [
  { id: 'value', label: 'Value' },
  { id: 'goal', label: 'Goal' },
  { id: 'commitment', label: 'Commitment' },
  { id: 'preference', label: 'Preference' },
  { id: 'theme', label: 'Recurring theme' },
  { id: 'practice', label: 'Practice that helped' },
  { id: 'other', label: 'Other' },
];
const categoryLabel = (c: MemoryCategory) => CATEGORIES.find((x) => x.id === c)?.label ?? c;
const MAX_LEN = 400;

type Filter = 'all' | MemoryCategory;

function errMsg(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/* ------------------------------------------------------------------ Inline editor */
function MemoryEditor({ memory, onSave, onCancel, saveLabel = 'Save' }: { memory: Memory; onSave: (content: string, category: MemoryCategory) => Promise<void>; onCancel: () => void; saveLabel?: string }) {
  const [content, setContent] = useState(memory.content);
  const [category, setCategory] = useState<MemoryCategory>(memory.category);
  const [busy, setBusy] = useState(false);
  const trimmed = content.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_LEN;
  return (
    <div className="memory-edit">
      <label className="label" htmlFor={`cat-${memory.id}`}>Category</label>
      <select id={`cat-${memory.id}`} className="select" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
        {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <label className="label" htmlFor={`content-${memory.id}`}>What to remember</label>
      <textarea id={`content-${memory.id}`} className="textarea" value={content} maxLength={MAX_LEN} onChange={(e) => setContent(e.target.value)} />
      <CharCount value={content} />
      <div className="actions">
        <button className="btn secondary sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className="btn primary sm"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            try { await onSave(trimmed, category); } finally { setBusy(false); }
          }}
        >
          {busy ? <Spinner /> : null} {saveLabel}
        </button>
      </div>
    </div>
  );
}

function CharCount({ value }: { value: string }) {
  const over = value.length > MAX_LEN;
  return <div className={`char-count ${over ? 'over' : ''}`} aria-live="polite">{value.length} / {MAX_LEN}</div>;
}

function SourceLine({ m }: { m: Memory }) {
  if (m.sourceConversationId) {
    return (
      <span>
        From conversation: <Link to={`/chat/${m.sourceConversationId}`}>{m.sourceConversationTitle || 'Untitled conversation'}</Link>
      </span>
    );
  }
  if (m.sourceJournalId) return <span>From a journal entry</span>;
  return <span>Added manually</span>;
}

/* ------------------------------------------------------------------ Page */
export default function MemoryPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [defaultEnabled, setDefaultEnabled] = useState<boolean>(user?.memoryEnabledDefault ?? false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ memories: Memory[]; memoryEnabledDefault: boolean }>('/api/memories');
      setMemories(r.memories);
      setDefaultEnabled(r.memoryEnabledDefault);
      setError('');
    } catch (err) {
      setError(errMsg(err, 'Could not load your memories.'));
      setMemories([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Bulk deletion from Privacy & data happens on another screen.
  useEffect(() => {
    const onDeleted = () => load();
    window.addEventListener('sl:data-deleted', onDeleted);
    return () => window.removeEventListener('sl:data-deleted', onDeleted);
  }, [load]);

  const pending = useMemo(() => (memories ?? []).filter((m) => m.status === 'pending'), [memories]);
  const saved = useMemo(() => (memories ?? []).filter((m) => m.status === 'approved' || m.status === 'disabled'), [memories]);
  const visible = useMemo(() => (filter === 'all' ? saved : saved.filter((m) => m.category === filter)), [saved, filter]);
  const tabs = useMemo(() => {
    const present = new Set(saved.map((m) => m.category));
    return [{ id: 'all' as Filter, label: 'All' }, ...CATEGORIES.filter((c) => present.has(c.id)).map((c) => ({ id: c.id as Filter, label: c.label }))];
  }, [saved]);

  function replaceMemory(updated: Memory) {
    setMemories((list) => (list ?? []).map((m) => (m.id === updated.id ? updated : m)));
  }
  function removeMemory(id: string) {
    setMemories((list) => (list ?? []).filter((m) => m.id !== id));
  }

  async function patch(id: string, body: Partial<Pick<Memory, 'content' | 'category'>> & { status?: 'approved' | 'rejected' | 'disabled' }) {
    const r = await api.patch<{ memory: Memory }>(`/api/memories/${id}`, body);
    return r.memory;
  }

  async function setDefault(enabled: boolean) {
    const prev = defaultEnabled;
    setDefaultEnabled(enabled);
    try {
      await api.patch('/api/memories/settings/default', { enabled });
      await refresh();
      toast(enabled ? 'New conversations will use memory by default.' : 'New conversations will start without memory.', 'success');
    } catch (err) {
      setDefaultEnabled(prev);
      toast(errMsg(err, 'Could not update the setting.'), 'error');
    }
  }

  async function approve(m: Memory) {
    try { replaceMemory(await patch(m.id, { status: 'approved' })); toast('Memory approved.', 'success'); }
    catch (err) { toast(errMsg(err, 'Could not approve this memory.'), 'error'); }
  }
  async function reject(m: Memory) {
    try { await patch(m.id, { status: 'rejected' }); removeMemory(m.id); }
    catch (err) { toast(errMsg(err, 'Could not dismiss this memory.'), 'error'); }
  }
  async function toggleDisabled(m: Memory) {
    const status = m.status === 'disabled' ? 'approved' : 'disabled';
    try { replaceMemory(await patch(m.id, { status })); }
    catch (err) { toast(errMsg(err, 'Could not update this memory.'), 'error'); }
  }
  async function remove(m: Memory) {
    const ok = await confirm('Delete this memory?', <>"{m.content}" will be removed. The Companion will no longer use it in new conversations.</>, { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try { await api.del(`/api/memories/${m.id}`); removeMemory(m.id); toast('Memory deleted.'); }
    catch (err) { toast(errMsg(err, 'Could not delete this memory.'), 'error'); }
  }
  async function clearAll() {
    const ok = await confirm('Clear all memories?', 'Every saved and pending memory will be deleted. This cannot be undone.', { danger: true, confirmLabel: 'Clear all' });
    if (!ok) return;
    try { await api.del('/api/memories'); setMemories([]); toast('All memories cleared.'); }
    catch (err) { toast(errMsg(err, 'Could not clear memories.'), 'error'); }
  }
  async function saveEdit(m: Memory, content: string, category: MemoryCategory, approveToo: boolean) {
    try {
      replaceMemory(await patch(m.id, { content, category, ...(approveToo ? { status: 'approved' as const } : {}) }));
      setEditingId(null);
      toast(approveToo ? 'Memory saved and approved.' : 'Memory updated.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Could not save this memory.'), 'error');
    }
  }

  const loading = memories === null;

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Memory</h1>
          <p>What the Companion remembers across chats. Nothing is saved here without your approval.</p>
        </div>
        <button className="btn primary" onClick={() => setAddOpen(true)}>
          <Icons.plus size={16} /> Add a memory
        </button>
      </div>

      {error ? <div className="section"><Alert kind="error">{error}</Alert></div> : null}

      <div className="section">
        <div className="card">
          <Toggle checked={defaultEnabled} onChange={setDefault} label="Use cross-chat memory by default in new conversations" />
          <p className="meta" style={{ margin: '8px 0 0' }}>You can still turn memory on or off for each conversation.</p>
        </div>
      </div>

      {loading ? (
        <div className="empty"><Spinner /></div>
      ) : (
        <>
          {pending.length > 0 ? (
            <div className="section">
              <div className="memory-section-title">
                <h2>Waiting for your approval</h2>
                <span className="chip warning"><Icons.clock size={13} /> Pending</span>
              </div>
              <div className="memory-list">
                {pending.map((m) => (
                  <div key={m.id} className="card memory-card pending">
                    <div className="body">
                      <div className="chips">
                        <span className="chip category">{categoryLabel(m.category)}</span>
                        <span className="chip warning">Pending</span>
                      </div>
                      {editingId === m.id ? (
                        <MemoryEditor memory={m} saveLabel="Save and approve" onCancel={() => setEditingId(null)} onSave={(c, cat) => saveEdit(m, c, cat, true)} />
                      ) : (
                        <>
                          <p className="content">{m.content}</p>
                          <div className="meta source">
                            {m.sourceConversationId ? (
                              <span>From: <Link to={`/chat/${m.sourceConversationId}`}>{m.sourceConversationTitle || 'Untitled conversation'}</Link></span>
                            ) : (
                              <SourceLine m={m} />
                            )}
                            <span aria-hidden="true">·</span>
                            <span>{formatDate(m.createdAt)}</span>
                          </div>
                        </>
                      )}
                    </div>
                    {editingId === m.id ? null : (
                      <div className="controls">
                        <button className="btn primary sm" onClick={() => approve(m)}><Icons.check size={14} /> Approve</button>
                        <button className="btn secondary sm" onClick={() => setEditingId(m.id)}><Icons.edit size={14} /> Edit</button>
                        <button className="btn ghost sm" onClick={() => reject(m)}>Not now</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="section">
            {saved.length === 0 ? (
              <div className="empty">
                <h2 className="display">Nothing remembered yet</h2>
                <p>
                  When the Companion notices something worth keeping, such as a value, a goal, or a practice that helped, it will ask you first.
                  You can also add a memory yourself.
                </p>
              </div>
            ) : (
              <>
                <div className="memory-toolbar">
                  <h2>Saved memories</h2>
                  <span className="meta">{saved.length} {saved.length === 1 ? 'memory' : 'memories'}</span>
                </div>
                {tabs.length > 1 ? <Tabs tabs={tabs} value={filter} onChange={setFilter} /> : null}
                <div className="memory-list" style={{ marginTop: 12 }}>
                  {visible.length === 0 ? <p className="muted small">No memories in this category.</p> : null}
                  {visible.map((m) => {
                    const disabled = m.status === 'disabled';
                    return (
                      <div key={m.id} className={`card memory-card ${disabled ? 'disabled-state' : ''}`}>
                        <div className="body">
                          <div className="chips">
                            <span className="chip category">{categoryLabel(m.category)}</span>
                            {disabled ? (
                              <span className="chip neutral"><Icons.eyeOff size={13} /> Disabled</span>
                            ) : (
                              <span className="chip success"><Icons.check size={13} /> Active</span>
                            )}
                          </div>
                          {editingId === m.id ? (
                            <MemoryEditor memory={m} onCancel={() => setEditingId(null)} onSave={(c, cat) => saveEdit(m, c, cat, false)} />
                          ) : (
                            <>
                              <p className="content">{m.content}</p>
                              <div className="meta source">
                                <SourceLine m={m} />
                                <span aria-hidden="true">·</span>
                                <span>{formatDate(m.createdAt)}</span>
                              </div>
                            </>
                          )}
                        </div>
                        {editingId === m.id ? null : (
                          <div className="controls">
                            <button className="btn secondary sm" onClick={() => setEditingId(m.id)}><Icons.edit size={14} /> Edit</button>
                            <button className="btn secondary sm" onClick={() => toggleDisabled(m)}>
                              {disabled ? <><Icons.eye size={14} /> Enable</> : <><Icons.eyeOff size={14} /> Disable</>}
                            </button>
                            <button className="btn secondary sm" onClick={() => remove(m)}><Icons.trash size={14} /> Delete</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {(memories?.length ?? 0) > 0 ? (
            <div className="memory-footer">
              <button className="btn danger-outline" onClick={clearAll}><Icons.trash size={16} /> Clear all memories</button>
            </div>
          ) : null}
        </>
      )}

      <AddMemoryModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(m) => { setMemories((list) => [...(list ?? []), m]); setAddOpen(false); toast('Memory added.', 'success'); }}
      />
      {confirmEl}
    </div>
  );
}

/* ------------------------------------------------------------------ Add modal */
function AddMemoryModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (m: Memory) => void }) {
  const [category, setCategory] = useState<MemoryCategory>('value');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setCategory('value'); setContent(''); setError(''); }
  }, [open]);

  const trimmed = content.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_LEN;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ memory: Memory }>('/api/memories', { category, content: trimmed });
      onAdded(r.memory);
    } catch (err) {
      setError(errMsg(err, 'Could not add this memory.'));
    } finally {
      setBusy(false);
    }
  }

  const actions: ReactNode = (
    <>
      <button className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="btn primary" onClick={submit} disabled={!valid || busy}>{busy ? <Spinner /> : null} Add memory</button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Add a memory" actions={actions}>
      <p className="muted small">Something you want the Companion to keep in mind across conversations. Memories you add are active right away.</p>
      <div className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="field">
          <label htmlFor="add-category">Category</label>
          <select id="add-category" className="select" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="add-content">What to remember</label>
          <textarea id="add-content" className="textarea" value={content} maxLength={MAX_LEN} placeholder="For example: I want to build a steady morning writing habit." onChange={(e) => setContent(e.target.value)} />
          <CharCount value={content} />
        </div>
      </div>
    </Modal>
  );
}
