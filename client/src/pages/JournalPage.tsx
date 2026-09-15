import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, downloadUrl } from '../api/client';
import type { Conversation, JournalEntry } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Icons, Menu, Modal, Spinner, formatDate, useConfirm, useToast } from '../components/ui';
import './journal.css';

/* ------------------------------------------------------------------ Date helpers (local time, YYYY-MM-DD) */
const pad = (n: number) => String(n).padStart(2, '0');
const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYmd = () => toYmd(new Date());
const monthKey = (y: number, m: number) => `${y}-${pad(m + 1)}`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function errMsg(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function countWords(text: string) {
  const t = text.replace(/\u00a0/g, ' ').trim();
  return t ? t.split(/\s+/).length : 0;
}

/* ------------------------------------------------------------------ Route switch */
export default function JournalPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <JournalEditor id={id} /> : <JournalList />;
}

/* ================================================================== LIST VIEW */
function JournalList() {
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [dates, setDates] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const mk = monthKey(year, month);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ entries: JournalEntry[]; dates: string[] }>(`/api/journal?month=${mk}`);
      setEntries(r.entries);
      setDates(new Set(r.dates));
      setError('');
    } catch (err) {
      setError(errMsg(err, 'Could not load your journal.'));
      setEntries([]);
    }
  }, [mk]);

  useEffect(() => { setEntries(null); load(); }, [load]);

  // Bulk deletion from Privacy & data happens on another screen.
  useEffect(() => {
    const onDeleted = () => load();
    window.addEventListener('sl:data-deleted', onDeleted);
    return () => window.removeEventListener('sl:data-deleted', onDeleted);
  }, [load]);

  const visible = useMemo(() => {
    const list = (entries ?? []).filter((e) => !selected || e.entryDate === selected);
    return [...list].sort((a, b) => (a.entryDate === b.entryDate ? b.createdAt.localeCompare(a.createdAt) : b.entryDate.localeCompare(a.entryDate)));
  }, [entries, selected]);

  function changeMonth(delta: number) {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setSelected(null);
  }

  async function newEntry() {
    setCreating(true);
    try {
      const r = await api.post<{ entry: JournalEntry }>('/api/journal', { entryDate: selected ?? todayYmd() });
      nav(`/journal/${r.entry.id}`);
    } catch (err) {
      toast(errMsg(err, 'Could not create an entry.'), 'error');
      setCreating(false);
    }
  }

  async function remove(e: JournalEntry) {
    const ok = await confirm('Delete this entry?', <>"{e.title || 'Untitled entry'}" from {formatDate(e.entryDate)} will be permanently deleted.</>, { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.del(`/api/journal/${e.id}`);
      toast('Entry deleted.');
      load();
    } catch (err) {
      toast(errMsg(err, 'Could not delete this entry.'), 'error');
    }
  }

  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="journal-page">
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Journal</h1>
            <p>Private. Nothing here is shared with the Companion unless you choose to discuss an entry.</p>
          </div>
          <button className="btn primary" onClick={newEntry} disabled={creating}>
            {creating ? <Spinner /> : <Icons.plus size={16} />} New entry
          </button>
        </div>

        {error ? <div className="section"><Alert kind="error">{error}</Alert></div> : null}

        <div className="journal-layout">
          <Calendar
            year={year}
            month={month}
            selected={selected}
            dates={dates}
            onPrev={() => changeMonth(-1)}
            onNext={() => changeMonth(1)}
            onSelect={(d) => setSelected((s) => (s === d ? null : d))}
            onToday={() => { const t = new Date(); setYear(t.getFullYear()); setMonth(t.getMonth()); setSelected(null); }}
          />

          <div>
            <div className="journal-list-head">
              <h2>{selected ? formatDate(selected, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : monthLabel}</h2>
              {selected ? <button className="btn ghost sm" onClick={() => setSelected(null)}><Icons.x size={14} /> Show whole month</button> : null}
            </div>

            {entries === null ? (
              <div className="empty"><Spinner /></div>
            ) : visible.length === 0 ? (
              <div className="empty">
                <h2 className="display">A quiet place to write</h2>
                <p>
                  {selected
                    ? 'No entries on this day yet. Start one to capture what is on your mind.'
                    : 'What stood out today? What did you notice about yourself, and what would you like to carry forward?'}
                </p>
                <button className="btn secondary" onClick={newEntry} disabled={creating} style={{ marginTop: 8 }}>
                  <Icons.plus size={16} /> {selected ? 'Write an entry for this day' : 'Write your first entry'}
                </button>
              </div>
            ) : (
              <div className="journal-list">
                {visible.map((e) => (
                  <div key={e.id} className="entry-card">
                    <button className="main" onClick={() => nav(`/journal/${e.id}`)}>
                      <div className={`title ${e.title ? '' : 'untitled muted'}`}>{e.title || 'Untitled entry'}</div>
                      <div className="meta-line meta">
                        <span>{formatDate(e.entryDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span aria-hidden="true">·</span>
                        <span>{e.wordCount} {e.wordCount === 1 ? 'word' : 'words'}</span>
                      </div>
                    </button>
                    <Menu trigger={<button className="btn ghost icon sm" aria-label="Entry options"><Icons.more size={18} /></button>}>
                      <button onClick={() => downloadUrl(`/api/journal/${e.id}/download`)}>Download</button>
                      <button className="danger" onClick={() => remove(e)}>Delete</button>
                    </Menu>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmEl}
    </div>
  );
}

/* ------------------------------------------------------------------ Calendar */
function Calendar({ year, month, selected, dates, onPrev, onNext, onSelect, onToday }: {
  year: number; month: number; selected: string | null; dates: Set<string>;
  onPrev: () => void; onNext: () => void; onSelect: (ymd: string) => void; onToday: () => void;
}) {
  const today = todayYmd();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday-first offset
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="calendar" role="group" aria-label="Calendar">
      <div className="calendar-nav">
        <button className="btn ghost icon sm" onClick={onPrev} aria-label="Previous month"><Icons.chevronLeft size={18} /></button>
        <span className="month" aria-live="polite">{label}</span>
        <button className="btn ghost icon sm" onClick={onNext} aria-label="Next month"><Icons.chevronRight size={18} /></button>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map((w) => <div key={w} className="calendar-weekday" aria-hidden="true">{w.slice(0, 2)}</div>)}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} className="calendar-day blank" aria-hidden="true" />;
          const ymd = `${year}-${pad(month + 1)}-${pad(day)}`;
          const has = dates.has(ymd);
          const isSel = selected === ymd;
          const isToday = ymd === today;
          const aria = [formatDate(ymd, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), has ? 'has entries' : '', isToday ? 'today' : ''].filter(Boolean).join(', ');
          return (
            <button
              key={ymd}
              type="button"
              className={`calendar-day ${isSel ? 'selected' : ''} ${isToday ? 'today' : ''}`}
              aria-label={aria}
              aria-pressed={isSel}
              onClick={() => onSelect(ymd)}
            >
              {day}
              {has ? <span className="dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="calendar-footer">
        <span className="meta">Dots mark days with entries</span>
        <button className="btn ghost sm" onClick={onToday}>Today</button>
      </div>
    </div>
  );
}

/* ================================================================== EDITOR VIEW */
type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';
type Cmd = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList';

const FORMAT_BUTTONS: { cmd: Cmd | 'h2' | 'quote'; label: string; title: string; className?: string }[] = [
  { cmd: 'bold', label: 'B', title: 'Bold' },
  { cmd: 'italic', label: 'I', title: 'Italic', className: 'italic' },
  { cmd: 'underline', label: 'U', title: 'Underline', className: 'underline' },
  { cmd: 'h2', label: 'H2', title: 'Heading' },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { cmd: 'quote', label: '❝', title: 'Quote' },
];

function JournalEditor({ id }: { id: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [confirm, confirmEl] = useConfirm();

  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [entryDate, setEntryDate] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [words, setWords] = useState(0);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [discussOpen, setDiscussOpen] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);
  const latest = useRef({ title: '', html: '' });

  /* Load once and seed the uncontrolled editor */
  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setLoadError('');
    api.get<{ entry: JournalEntry }>(`/api/journal/${id}`)
      .then((r) => {
        if (cancelled) return;
        let recovered: { title: string; html: string } | null = null;
        try {
          const raw = window.sessionStorage.getItem(`sl:journal-draft:${id}`);
          if (raw) recovered = JSON.parse(raw);
        } catch { /* storage may be unavailable */ }

        const merged = recovered ?? { title: r.entry.title ?? '', html: r.entry.contentHtml ?? '' };
        setEntry({ ...r.entry, title: merged.title, contentHtml: merged.html });
        setTitle(merged.title);
        setEntryDate(r.entry.entryDate);
        latest.current = merged;
        setWords(r.entry.wordCount ?? 0);
        if (recovered) {
          dirty.current = true;
          setSaveState('unsaved');
        }
      })
      .catch((err) => !cancelled && setLoadError(errMsg(err, 'Could not open this entry.')));
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (entry && bodyRef.current) {
      bodyRef.current.innerHTML = entry.contentHtml ?? '';
      setWords(countWords(bodyRef.current.innerText));
    }
    // Only when the entry first arrives; contentEditable stays uncontrolled afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);

  /* Saving */
  const flush = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current) return;
    dirty.current = false;
    const payload = { title: latest.current.title, contentHtml: latest.current.html };
    setSaveState('saving');
    await api.patch<{ entry: JournalEntry }>(`/api/journal/${id}`, payload)
      .then((r) => { if (!dirty.current) { setSaveState('saved'); setSavedAt(new Date()); } setWords(r.entry.wordCount ?? countWords(bodyRef.current?.innerText ?? '')); })
      .catch(() => { dirty.current = true; setSaveState('error'); });
  }, [id]);

  const markDirty = useCallback(() => {
    latest.current = { title: latest.current.title, html: bodyRef.current?.innerHTML ?? latest.current.html };
    dirty.current = true;
    setSaveState('unsaved');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { flush(); }, 800);
  }, [flush]);

  function onTitleChange(v: string) {
    setTitle(v);
    latest.current = { ...latest.current, title: v };
    markDirty();
  }

  function onBodyInput() {
    setWords(countWords(bodyRef.current?.innerText ?? ''));
    markDirty();
  }

  /* Save on unmount + warn before unload */
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        // Best effort: keepalive fetch so the save survives navigation
        try {
          fetch(`/api/journal/${id}`, { method: 'PATCH', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: latest.current.title, contentHtml: latest.current.html }) });
        } catch { /* ignore */ }
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (timer.current) window.clearTimeout(timer.current);
      if (dirty.current) {
        const pending = { ...latest.current };
        dirty.current = false;
        // Keep a copy locally until the server confirms, so a failure is recoverable.
        try { window.sessionStorage.setItem(`sl:journal-draft:${id}`, JSON.stringify(pending)); } catch { /* storage may be unavailable */ }
        api.patch(`/api/journal/${id}`, { title: pending.title, contentHtml: pending.html })
          .then(() => { try { window.sessionStorage.removeItem(`sl:journal-draft:${id}`); } catch { /* ignore */ } })
          .catch(() => { /* the copy above is picked up next time this entry opens */ });
      }
    };
  }, [id]);

  /* Toolbar state on selection change */
  useEffect(() => {
    const update = () => {
      const sel = document.getSelection();
      if (!sel || !bodyRef.current || !sel.anchorNode || !bodyRef.current.contains(sel.anchorNode)) return;
      const block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      setActive({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
        h2: block === 'h2',
        quote: block === 'blockquote',
      });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  function exec(cmd: Cmd | 'h2' | 'quote') {
    bodyRef.current?.focus();
    if (cmd === 'h2') document.execCommand('formatBlock', false, active.h2 ? 'p' : 'h2');
    else if (cmd === 'quote') document.execCommand('formatBlock', false, active.quote ? 'p' : 'blockquote');
    else document.execCommand(cmd, false);
    onBodyInput();
  }

  async function changeDate(v: string) {
    if (!v) return;
    const prev = entryDate;
    setEntryDate(v);
    try {
      await api.patch(`/api/journal/${id}`, { entryDate: v });
    } catch (err) {
      setEntryDate(prev);
      toast(errMsg(err, 'Could not change the date.'), 'error');
    }
  }

  async function remove() {
    const ok = await confirm('Delete this entry?', 'This entry will be permanently deleted.', { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      dirty.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      await api.del(`/api/journal/${id}`);
      toast('Entry deleted.');
      nav('/journal', { replace: true });
    } catch (err) {
      toast(errMsg(err, 'Could not delete this entry.'), 'error');
    }
  }

  async function back() {
    await flush();
    nav('/journal');
  }

  if (loadError) {
    return (
      <div className="journal-editor">
        <div className="page narrow">
          <Alert kind="error">{loadError}</Alert>
          <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => nav('/journal')}><Icons.chevronLeft size={16} /> Back to journal</button>
        </div>
      </div>
    );
  }

  const attach = { id, title: title || 'Untitled entry' };

  return (
    <div className="journal-editor">
      <div className="editor-topbar">
        <div className="editor-topbar-row">
          <button className="btn ghost icon sm" onClick={back} aria-label="Back to journal"><Icons.chevronLeft size={20} /></button>
          <input type="date" className="input date-input" value={entryDate} onChange={(e) => changeDate(e.target.value)} aria-label="Entry date" disabled={!entry} />
          <SaveStatus state={saveState} />
          <span className="grow" />
          <Menu trigger={<button className="btn secondary icon sm" aria-label="Entry options"><Icons.more size={18} /></button>}>
            <button onClick={() => downloadUrl(`/api/journal/${id}/download`)}>Download</button>
            <button onClick={async () => { await flush(); setDiscussOpen(true); }}>Discuss with Companion</button>
            <button className="danger" onClick={remove}>Delete</button>
          </Menu>
        </div>
        <div className="format-bar" role="toolbar" aria-label="Formatting">
          {FORMAT_BUTTONS.map((b, i) => (
            <span key={b.cmd} style={{ display: 'contents' }}>
              {i === 3 || i === 6 ? <span className="sep" aria-hidden="true" /> : null}
              <button
                type="button"
                className={`fmt-btn ${b.className ?? ''}`}
                title={b.title}
                aria-label={b.title}
                aria-pressed={!!active[b.cmd]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec(b.cmd)}
                disabled={!entry}
              >
                {b.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="editor-scroll">
        <div className="writing-page">
          {!entry ? (
            <div className="empty"><Spinner /></div>
          ) : null}
          <input
            className="writing-title"
            placeholder="Title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={() => flush()}
            aria-label="Title"
            hidden={!entry}
          />
          <div
            ref={bodyRef}
            className="writing-body"
            contentEditable={!!entry}
            suppressContentEditableWarning
            data-placeholder="Start writing…"
            role="textbox"
            aria-multiline="true"
            aria-label="Entry body"
            onInput={onBodyInput}
            onBlur={() => flush()}
            hidden={!entry}
          />
          {entry ? (
            <div className="writing-footer meta">
              <span>{words} {words === 1 ? 'word' : 'words'}</span>
              <span>{savedAt ? `Last saved ${savedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
            </div>
          ) : null}
        </div>
      </div>

      {discussOpen ? (
        <DiscussModal
          onClose={() => setDiscussOpen(false)}
          shareAllowed={!!user?.journalShareAllowed}
          onNew={() => nav('/', { state: { attachEntry: attach } })}
          onPick={(cid) => nav(`/chat/${cid}`, { state: { attachEntry: attach } })}
        />
      ) : null}
      {confirmEl}
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const map: Record<SaveState, { icon: ReactNode; text: string }> = {
    saved: { icon: <Icons.check size={14} />, text: 'Saved' },
    saving: { icon: <Spinner />, text: 'Saving…' },
    unsaved: { icon: <Icons.clock size={14} />, text: 'Unsaved changes' },
    error: { icon: <Icons.warning size={14} />, text: 'Could not save' },
  };
  const s = map[state];
  return (
    <span className={`save-status ${state}`} role="status" aria-live="polite">
      {s.icon}
      <span className="label">{s.text}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ Discuss with Companion */
function DiscussModal({ onClose, shareAllowed, onNew, onPick }: { onClose: () => void; shareAllowed: boolean; onNew: () => void; onPick: (id: string) => void }) {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!shareAllowed) return;
    api.get<{ conversations: Conversation[] }>('/api/conversations')
      .then((r) => setConvs(r.conversations))
      .catch((err) => { setError(errMsg(err, 'Could not load conversations.')); setConvs([]); });
  }, [shareAllowed]);

  if (!shareAllowed) {
    return (
      <Modal open onClose={onClose} title="Discuss with Companion" actions={<button className="btn secondary" onClick={onClose}>Close</button>}>
        <Alert kind="warning">
          Sharing journal entries with the Companion is turned off in your Privacy settings. You can turn it on in{' '}
          <Link to="/privacy" onClick={onClose}>Privacy settings</Link>.
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Discuss with Companion" actions={<button className="btn secondary" onClick={onClose}>Cancel</button>}>
      <p className="small muted">
        This will attach the entry to a conversation. The Companion only sees it for that request. Any memory it suggests still needs your approval.
      </p>
      <div className="stack">
        <button className="btn primary" onClick={onNew} style={{ width: '100%' }}><Icons.plus size={16} /> New conversation</button>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Or add to an existing conversation</div>
          {error ? <Alert kind="error">{error}</Alert> : null}
          {convs === null ? (
            <div className="row" style={{ justifyContent: 'center', padding: 12 }}><Spinner /></div>
          ) : convs.length === 0 ? (
            <p className="meta">No conversations yet.</p>
          ) : (
            <div className="conv-pick">
              {convs.map((c) => (
                <button key={c.id} onClick={() => onPick(c.id)}>
                  <span className="t">{c.title || 'Untitled conversation'}</span>
                  <span className="meta">{formatDate(c.lastMessageAt ?? c.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
