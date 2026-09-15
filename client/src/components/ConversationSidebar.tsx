import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, downloadUrl } from '../api/client';
import type { Conversation } from '../api/types';
import { Icons, Menu, useConfirm, useToast } from './ui';

/** Fire this after creating/renaming/deleting a conversation so the sidebar re-fetches. */
export function notifyConversationsChanged() {
  window.dispatchEvent(new CustomEvent('sl:conversations-changed'));
}

type GroupKey = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';
const GROUP_ORDER: GroupKey[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

function groupFor(iso: string): GroupKey {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  const t = d.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - day) return 'Yesterday';
  if (t >= startOfToday - 7 * day) return 'Previous 7 days';
  return 'Older';
}

export default function ConversationSidebar() {
  const nav = useNavigate();
  const loc = useLocation();
  const { id: currentId } = useParams<{ id: string }>();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [creatingTemp, setCreatingTemp] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('archived', archived ? '1' : '0');
      if (debounced) params.set('q', debounced);
      const r = await api.get<{ conversations: Conversation[] }>(`/api/conversations?${params.toString()}`);
      setItems(r.conversations);
    } catch (e) {
      toast((e as Error).message || 'Could not load conversations', 'error');
    } finally {
      setLoading(false);
    }
  }, [archived, debounced, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onChange = () => load();
    window.addEventListener('sl:conversations-changed', onChange);
    return () => window.removeEventListener('sl:conversations-changed', onChange);
  }, [load]);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const groups = useMemo(() => {
    const map = new Map<GroupKey, Conversation[]>();
    const sorted = [...items].sort((a, b) => {
      const ta = new Date(a.lastMessageAt ?? a.createdAt).getTime();
      const tb = new Date(b.lastMessageAt ?? b.createdAt).getTime();
      return tb - ta;
    });
    for (const c of sorted) {
      const g = groupFor(c.lastMessageAt ?? c.createdAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }));
  }, [items]);

  const activeId = currentId ?? (loc.pathname.startsWith('/chat/') ? loc.pathname.slice('/chat/'.length) : undefined);

  async function startTemporary() {
    if (creatingTemp) return;
    setCreatingTemp(true);
    try {
      const r = await api.post<{ conversation: Conversation }>('/api/conversations', { isTemporary: true });
      nav(`/chat/${r.conversation.id}`);
    } catch (e) {
      toast((e as Error).message || 'Could not start a temporary chat', 'error');
    } finally {
      setCreatingTemp(false);
    }
  }

  async function commitRename() {
    if (!renaming) return;
    const title = renaming.title.trim();
    const target = renaming;
    setRenaming(null);
    if (!title) return;
    const prev = items;
    setItems((list) => list.map((c) => (c.id === target.id ? { ...c, title } : c)));
    try {
      await api.patch(`/api/conversations/${target.id}`, { title });
      notifyConversationsChanged();
    } catch (e) {
      setItems(prev);
      toast((e as Error).message || 'Could not rename', 'error');
    }
  }

  async function toggleArchive(c: Conversation) {
    try {
      await api.patch(`/api/conversations/${c.id}`, { archived: !c.archived });
      toast(c.archived ? 'Conversation restored' : 'Conversation archived', 'success');
      notifyConversationsChanged();
    } catch (e) {
      toast((e as Error).message || 'Could not update', 'error');
    }
  }

  async function remove(c: Conversation) {
    const ok = await confirm('Delete conversation?', <>“{c.title || 'Untitled chat'}” will be permanently deleted. This cannot be undone.</>, { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.del(`/api/conversations/${c.id}`);
      toast('Conversation deleted', 'success');
      if (c.id === activeId) nav('/');
      notifyConversationsChanged();
    } catch (e) {
      toast((e as Error).message || 'Could not delete', 'error');
    }
  }

  return (
    <div className="conv-list" aria-label="Conversations">
      <div className="conv-list-header">
        <button type="button" className="btn secondary sm grow" onClick={() => nav('/')}>
          <Icons.plus size={16} /> New chat
        </button>
        <button type="button" className="btn ghost sm" onClick={startTemporary} disabled={creatingTemp} title="Not saved to history, memory off">
          <Icons.clock size={16} /> Temporary
        </button>
      </div>

      <div className="conv-search">
        <Icons.search size={16} />
        <input
          className="input"
          type="search"
          placeholder="Search chats"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="meta" style={{ padding: '12px' }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div className="meta" style={{ padding: '12px' }}>
          {debounced ? 'No chats match your search.' : archived ? 'No archived chats.' : 'No conversations yet.'}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label}>
            <div className="conv-group-label">{g.label}</div>
            {g.items.map((c) => {
              const active = c.id === activeId;
              const isRenaming = renaming?.id === c.id;
              return (
                <div key={c.id} className={`conv-item ${active ? 'active' : ''}`}>
                  {isRenaming ? (
                    <input
                      ref={renameRef}
                      className="input grow"
                      aria-label="Conversation title"
                      value={renaming!.title}
                      onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <Link to={`/chat/${c.id}`} aria-current={active ? 'page' : undefined} title={c.title || 'Untitled chat'}>
                      {c.title || 'Untitled chat'}
                    </Link>
                  )}
                  {!isRenaming ? (
                    <div className="conv-actions">
                      <Menu trigger={<button type="button" className="btn icon ghost sm" aria-label={`Actions for ${c.title || 'Untitled chat'}`}><Icons.more size={16} /></button>}>
                        <button type="button" onClick={() => setRenaming({ id: c.id, title: c.title })}>Rename</button>
                        <button type="button" onClick={() => toggleArchive(c)}>{c.archived ? 'Unarchive' : 'Archive'}</button>
                        <button type="button" onClick={() => downloadUrl(`/api/privacy/export/conversation/${c.id}.md`)}>Download (.md)</button>
                        <button type="button" className="danger" onClick={() => remove(c)}>Delete</button>
                      </Menu>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}

      <div style={{ marginTop: 'auto', padding: '8px 4px' }}>
        <button type="button" className="btn ghost sm" onClick={() => { setArchived((a) => !a); setLoading(true); }}>
          <Icons.archive size={16} /> {archived ? 'Show active' : 'Show archived'}
        </button>
      </div>
      {confirmEl}
    </div>
  );
}
