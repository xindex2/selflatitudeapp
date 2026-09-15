import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError, downloadUrl, streamPost } from '../api/client';
import type { CompanionInfo, Conversation, Depth, JournalEntry, MemoryCategory, Message, Source, UsageStatus } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Icons, Menu, Modal, Spinner, Toggle, formatDate, useConfirm, useToast } from '../components/ui';
import { notifyConversationsChanged } from '../components/ConversationSidebar';
import './chat.css';

/* ------------------------------------------------------------------ types */
interface Attachment { entryId: string; title: string }
interface Suggestion { id: string; category: MemoryCategory; content: string }
interface LocalSettings { modelId: string; depth: Depth; memoryEnabled: boolean }
type Banner =
  | { kind: 'exhausted'; resetDate?: string }
  | { kind: 'needs_key'; message: string }
  | { kind: 'error'; message: string };

const DEPTHS: Depth[] = ['fast', 'medium', 'extended'];
const DEPTH_FALLBACK: Record<Depth, string> = { fast: 'Fast', medium: 'Medium', extended: 'Extended' };
const MEMORY_LABEL = 'Remember structured history across chats';

function blankMessage(role: Message['role'], content: string, status: Message['status'], id: string): Message {
  return { id, role, content, status, modelId: null, depth: null, promptVersion: null, sources: [], attachments: [], paymentSource: null, error: null, createdAt: new Date().toISOString() };
}

function errMessage(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/* ------------------------------------------------------------------ page */
export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const loc = useLocation();
  const { user, usage, setUsage } = useAuth();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [companion, setCompanion] = useState<CompanionInfo | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [local, setLocal] = useState<LocalSettings>({ modelId: '', depth: 'medium', memoryEnabled: user?.memoryEnabledDefault ?? true });
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({});
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [summary, setSummary] = useState<{ open: boolean; text: string; loading: boolean; starting: boolean }>({ open: false, text: '', loading: false, starting: false });

  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const skipLoadRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = conversation?.id ?? null;

  /* ---- companion info (once) */
  useEffect(() => {
    api.get<CompanionInfo>('/api/companion')
      .then((c) => {
        setCompanion(c);
        setLocal((l) => ({ ...l, modelId: l.modelId || c.defaultModelId }));
      })
      .catch((e) => setBanner({ kind: 'error', message: errMessage(e, 'The Companion is unavailable right now.') }));
  }, []);

  useEffect(() => {
    if (user) setLocal((l) => ({ ...l, memoryEnabled: user.memoryEnabledDefault }));
  }, [user?.memoryEnabledDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- load conversation on route change */
  useEffect(() => {
    if (id && skipLoadRef.current === id) return; // just created locally; state is already populated
    skipLoadRef.current = null;
    abortRef.current?.abort();
    setStreaming(false);
    setBanner(null);
    setEditingTitle(null);
    setSuggestions({});
    if (!id) {
      setConversation(null);
      setMessages([]);
      setAttachments([]);
      setLoadingConv(false);
      return;
    }
    let cancelled = false;
    setLoadingConv(true);
    api.get<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`)
      .then((r) => {
        if (cancelled) return;
        setConversation(r.conversation);
        setMessages(r.messages);
        stickRef.current = true;
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          toast('That conversation no longer exists.', 'error');
          nav('/', { replace: true });
        } else {
          setBanner({ kind: 'error', message: errMessage(e, 'Could not load this conversation.') });
        }
      })
      .finally(() => !cancelled && setLoadingConv(false));
    return () => { cancelled = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- arriving from the Journal with an entry to discuss */
  useEffect(() => {
    const entry = (loc.state as { attachEntry?: { id: string; title: string } } | null)?.attachEntry;
    if (!entry?.id) return;
    setAttachments((prev) => (prev.some((a) => a.entryId === entry.id) ? prev : [...prev, { entryId: entry.id, title: entry.title || 'Journal entry' }]));
    nav(loc.pathname, { replace: true, state: null });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [loc.state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editingTitle !== null) titleInputRef.current?.select();
  }, [editingTitle !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- scrolling */
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [messages, suggestions, loadingConv, scrollToBottom]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /* ---- composer auto-grow */
  useEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    const max = 8 * 24 + 22;
    t.style.height = 'auto';
    const needed = t.scrollHeight + 2; // + top/bottom border (box-sizing: border-box)
    t.style.height = `${Math.min(needed, max)}px`;
    t.style.overflowY = needed > max ? 'auto' : 'hidden';
  }, [draft]);

  /* ---- settings (conversation or local) */
  const isTemp = conversation?.isTemporary ?? false;
  const settings: LocalSettings = conversation
    ? { modelId: conversation.modelId, depth: conversation.depth, memoryEnabled: conversation.memoryEnabled }
    : local;

  async function updateSetting(patch: Partial<LocalSettings>) {
    if (!conversation) {
      setLocal((l) => ({ ...l, ...patch }));
      return;
    }
    const prev = conversation;
    setConversation({ ...conversation, ...patch });
    try {
      const r = await api.patch<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, patch);
      setConversation((c) => (c && c.id === r.conversation.id ? { ...c, ...r.conversation } : c));
    } catch (e) {
      setConversation(prev);
      toast(errMessage(e, 'Could not update the setting'), 'error');
    }
  }

  async function saveTitle() {
    const t = editingTitle?.trim();
    setEditingTitle(null);
    if (!t || !conversation || t === conversation.title) return;
    const prev = conversation;
    setConversation({ ...conversation, title: t });
    try {
      await api.patch(`/api/conversations/${conversation.id}`, { title: t });
      notifyConversationsChanged();
    } catch (e) {
      setConversation(prev);
      toast(errMessage(e, 'Could not rename'), 'error');
    }
  }

  /* ---- streaming */
  const handleRejected = useCallback((d: { error?: string; code?: string; resetDate?: string } | null) => {
    {
    }
    const code = d?.code;
    if (code === 'usage_exhausted') setBanner({ kind: 'exhausted', resetDate: d?.resetDate });
    else if (code === 'model_requires_key') setBanner({ kind: 'needs_key', message: d?.error || 'This model needs your own OpenAI API key.' });
    else setBanner({ kind: 'error', message: d?.error || 'Something went wrong. Please try again.' });
  }, []);

  async function runStream(
    url: string,
    body: unknown,
    // Present when this call optimistically added a user bubble that must be rolled back
    // if the request is refused before the server stores anything.
    rollback?: { text: string; atts: Attachment[]; userMessageId: string },
    // Runs once the server has accepted the request (first SSE event). Used by regenerate
    // so the previous reply is only removed when a replacement is really coming.
    onAccepted?: () => void,
  ) {
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    setBanner(null);
    stickRef.current = true;

    let assistantId = `tmp-a-${Date.now()}`;
    let acc = '';
    let finished = false;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      onAccepted?.();
    };
    setMessages((m) => [...m, blankMessage('assistant', '', 'streaming', assistantId)]);
    const patch = (fn: (m: Message) => Message) => {
      const target = assistantId;
      setMessages((list) => list.map((x) => (x.id === target ? fn(x) : x)));
    };
    const removePlaceholder = () => {
      const target = assistantId;
      setMessages((list) => list.filter((x) => x.id !== target));
    };
    /** Undo the optimistic user bubble and hand the text back to the composer. */
    const rollbackSend = () => {
      if (!rollback) return;
      const uid = rollback.userMessageId;
      setMessages((list) => list.filter((x) => x.id !== uid));
      setDraft(rollback.text);
      setAttachments(rollback.atts);
    };

    try {
      await streamPost(url, body, {
        signal: ac.signal,
        onEvent: (event, data) => {
          if (event !== 'error') accept();
          switch (event) {
            case 'meta': {
              if (data?.messageId) {
                const newId = String(data.messageId);
                patch((x) => ({ ...x, id: newId, paymentSource: data.paymentSource ?? null, modelId: data.model ?? null, depth: data.depth ?? null, promptVersion: data.promptVersion ?? null }));
                assistantId = newId;
              }
              break;
            }
            case 'delta': {
              acc += typeof data?.text === 'string' ? data.text : '';
              const t = acc;
              patch((x) => ({ ...x, content: t }));
              break;
            }
            case 'title': {
              if (data?.title) {
                setConversation((c) => (c ? { ...c, title: data.title } : c));
                notifyConversationsChanged();
              }
              break;
            }
            case 'done': {
              finished = true;
              const finalId = data?.messageId ? String(data.messageId) : assistantId;
              const content = typeof data?.content === 'string' && data.content ? data.content : acc;
              patch((x) => ({ ...x, id: finalId, content, status: data?.status ?? 'complete', sources: Array.isArray(data?.sources) ? (data.sources as Source[]) : [], error: data?.error ?? null }));
              assistantId = finalId;
              if (Array.isArray(data?.memorySuggestions) && data.memorySuggestions.length) {
                setSuggestions((s) => ({ ...s, [finalId]: data.memorySuggestions as Suggestion[] }));
              }
              if (data?.usage) setUsage(data.usage as UsageStatus);
              break;
            }
            case 'error': {
              // Sent mid-stream: the student's message is already saved, so it stays put
              // and the composer is not refilled (that would duplicate it on resend).
              finished = true;
              removePlaceholder();
              handleRejected(data);
              break;
            }
          }
        },
      });
      if (!finished) {
        patch((x) => (x.content ? { ...x, status: 'stopped' } : { ...x, status: 'failed', error: 'The reply ended unexpectedly.' }));
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        patch((x) => ({ ...x, status: 'stopped' }));
      } else if (e instanceof ApiError) {
        // Refused before the server stored anything: undo the optimistic bubble.
        removePlaceholder();
        rollbackSend();
        handleRejected({ error: e.message, code: e.code, resetDate: e.extra.resetDate as string | undefined });
      } else {
        patch((x) => ({ ...x, status: 'failed', error: errMessage(e, 'Connection lost.') }));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      notifyConversationsChanged();
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    const atts = attachments;
    setDraft('');
    setAttachments([]);

    let conv = conversation;
    if (!conv) {
      try {
        const r = await api.post<{ conversation: Conversation }>('/api/conversations', {
          modelId: local.modelId || undefined,
          depth: local.depth,
          memoryEnabled: local.memoryEnabled,
        });
        conv = r.conversation;
        skipLoadRef.current = conv.id;
        setConversation(conv);
        setMessages([]);
        nav(`/chat/${conv.id}`, { replace: true });
        notifyConversationsChanged();
      } catch (e) {
        setDraft(text);
        setAttachments(atts);
        if (e instanceof ApiError && (e.code === 'usage_exhausted' || e.code === 'model_requires_key')) {
          handleRejected({ error: e.message, code: e.code, resetDate: e.extra.resetDate as string | undefined });
        } else {
          setBanner({ kind: 'error', message: errMessage(e, 'Could not start a conversation.') });
        }
        return;
      }
    }

    const optimisticId = `tmp-u-${Date.now()}`;
    const userMsg = blankMessage('user', text, 'complete', optimisticId);
    userMsg.attachments = atts.map((a) => ({ type: 'journal', entryId: a.entryId, title: a.title }));
    setMessages((m) => [...m, userMsg]);
    await runStream(`/api/conversations/${conv.id}/messages`, {
      content: text,
      attachments: atts.map((a) => ({ type: 'journal', entryId: a.entryId })),
    }, { text, atts, userMessageId: optimisticId });
  }

  async function regenerate() {
    if (!conversation || streaming) return;
    // The reply is only removed once the stream actually starts: the server can still
    // refuse (busy, no usage left, Companion unavailable) and then it must stay on screen.
    let removed: { message: Message; index: number } | null = null;
    const dropLastAssistant = () => {
      setMessages((m) => {
        let idx = -1;
        for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'assistant') { idx = i; break; }
        if (idx < 0) return m;
        removed = { message: m[idx], index: idx };
        return m.filter((_, i) => i !== idx);
      });
    };
    await runStream(`/api/conversations/${conversation.id}/regenerate`, {}, undefined, dropLastAssistant);
    void removed;
  }

  async function stop() {
    const cid = convIdRef.current;
    try {
      if (cid) await api.post(`/api/conversations/${cid}/stop`);
    } catch {
      /* the abort below still stops the client side */
    }
    abortRef.current?.abort();
    // The server finished saving after we stopped listening: reload the stored reply and
    // the usage counter so both match what was actually kept.
    if (!cid) return;
    setTimeout(async () => {
      try {
        const [conv, usageRes] = await Promise.all([
          api.get<{ messages: Message[] }>(`/api/conversations/${cid}`),
          api.get<{ usage: UsageStatus }>('/api/usage'),
        ]);
        if (convIdRef.current === cid) setMessages(conv.messages);
        setUsage(usageRes.usage);
      } catch {
        /* leave what is on screen */
      }
    }, 400);
  }

  /* ---- top bar actions */
  async function toggleArchive() {
    if (!conversation) return;
    try {
      await api.patch(`/api/conversations/${conversation.id}`, { archived: !conversation.archived });
      toast(conversation.archived ? 'Conversation restored' : 'Conversation archived', 'success');
      notifyConversationsChanged();
      if (!conversation.archived) nav('/');
      else setConversation({ ...conversation, archived: false });
    } catch (e) {
      toast(errMessage(e, 'Could not update'), 'error');
    }
  }

  async function remove() {
    if (!conversation) return;
    const ok = await confirm('Delete conversation?', <>“{conversation.title || 'Untitled chat'}” will be permanently deleted. This cannot be undone.</>, { danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.del(`/api/conversations/${conversation.id}`);
      toast('Conversation deleted', 'success');
      notifyConversationsChanged();
      nav('/');
    } catch (e) {
      toast(errMessage(e, 'Could not delete'), 'error');
    }
  }

  async function openSummary() {
    if (!conversation) return;
    setSummary({ open: true, text: '', loading: true, starting: false });
    try {
      const r = await api.post<{ summary: string }>(`/api/conversations/${conversation.id}/summary`);
      setSummary((s) => ({ ...s, text: r.summary, loading: false }));
    } catch (e) {
      setSummary({ open: false, text: '', loading: false, starting: false });
      toast(errMessage(e, 'Could not create a summary'), 'error');
    }
  }

  async function continueFromSummary() {
    if (!conversation) return;
    setSummary((s) => ({ ...s, starting: true }));
    try {
      const r = await api.post<{ conversation: Conversation }>(`/api/conversations/${conversation.id}/continue`);
      setSummary({ open: false, text: '', loading: false, starting: false });
      notifyConversationsChanged();
      nav(`/chat/${r.conversation.id}`);
    } catch (e) {
      setSummary((s) => ({ ...s, starting: false }));
      toast(errMessage(e, 'Could not start a new chat'), 'error');
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Could not copy', 'error');
    }
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const applyStarter = (prompt: string) => {
    setDraft(prompt);
    setTimeout(() => {
      const t = textareaRef.current;
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    }, 0);
  };

  /* ---- derived */
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id;
    return null;
  }, [messages]);

  const modelOptions = useMemo(() => {
    const list = companion?.models ?? [];
    if (settings.modelId && !list.some((m) => m.id === settings.modelId)) {
      return [...list, { id: settings.modelId, label: settings.modelId, included: true, isDefault: false }];
    }
    return list;
  }, [companion, settings.modelId]);

  const title = conversation ? conversation.title || 'Untitled chat' : 'New chat';
  const showEmpty = !id && !loadingConv && messages.length === 0;

  /* ---- render */
  return (
    <div className="chat">
      <header className="chat-topbar">
        <div className="chat-topbar-row">
          {editingTitle !== null ? (
            <input
              ref={titleInputRef}
              className="input chat-title-input"
              aria-label="Conversation title"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
                if (e.key === 'Escape') setEditingTitle(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="chat-title-btn"
              disabled={!conversation}
              title={conversation ? 'Click to rename' : undefined}
              aria-label={conversation ? `Conversation title: ${title}. Click to rename` : title}
              onClick={() => conversation && setEditingTitle(conversation.title)}
            >
              {title}
            </button>
          )}
          {conversation ? (
            <Menu trigger={<button type="button" className="btn icon ghost sm" aria-label="Conversation actions"><Icons.more /></button>}>
              {!isTemp ? <button type="button" onClick={openSummary}>Continue in a new chat</button> : null}
              <button type="button" onClick={() => setEditingTitle(conversation.title)}>Rename</button>
              {!isTemp ? <button type="button" onClick={toggleArchive}>{conversation.archived ? 'Unarchive' : 'Archive'}</button> : null}
              <button type="button" onClick={() => downloadUrl(`/api/privacy/export/conversation/${conversation.id}.md`)}>Download (.md)</button>
              <button type="button" className="danger" onClick={remove}>Delete</button>
            </Menu>
          ) : null}
        </div>

        <div className="chat-controls" role="group" aria-label="Reply settings">
          <label className="visually-hidden" htmlFor="chat-model">Model</label>
          <select
            id="chat-model"
            className="select"
            value={settings.modelId}
            disabled={!companion || streaming}
            onChange={(e) => updateSetting({ modelId: e.target.value })}
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.label}{m.included ? '' : ' · needs your key'}</option>
            ))}
          </select>

          <div className="segmented" role="group" aria-label="Response depth">
            {DEPTHS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={settings.depth === d}
                disabled={streaming}
                onClick={() => updateSetting({ depth: d })}
              >
                {companion?.depths?.[d] ?? DEPTH_FALLBACK[d]}
              </button>
            ))}
          </div>

          <span title={isTemp ? 'Temporary chats never use or create memory' : undefined}>
            <Toggle
              checked={isTemp ? false : settings.memoryEnabled}
              disabled={isTemp || streaming}
              onChange={(v) => updateSetting({ memoryEnabled: v })}
              label={MEMORY_LABEL}
            />
          </span>
          {isTemp ? <span className="chat-hint">Temporary chats never use or create memory</span> : null}
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          <div className="chat-banners">
            {isTemp ? <Alert kind="info">Temporary chat - not saved to history, memory off.</Alert> : null}
            <UsageBanner usage={usage} />
          </div>

          {loadingConv ? (
            <div className="row" style={{ justifyContent: 'center', padding: 24 }}><Spinner /></div>
          ) : null}

          {showEmpty && companion ? (
            <section className="chat-empty" aria-label="Start a conversation">
              <h1 className="display">{companion.name}</h1>
              {companion.description ? <p>{companion.description}</p> : null}
              {companion.starters.length ? (
                <div className="starters">
                  {companion.starters.map((s, i) => (
                    <button key={i} type="button" className="card warm starter" onClick={() => applyStarter(s.prompt)}>
                      <strong>{s.title}</strong>
                      <span>{s.prompt}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {messages.map((m) => (
            <MessageItem
              key={m.id}
              m={m}
              isLastAssistant={m.id === lastAssistantId}
              streaming={streaming}
              onCopy={() => copyText(m.content)}
              onRegenerate={regenerate}
              suggestions={suggestions[m.id]}
              onSuggestionSettled={(sid) => setSuggestions((s) => ({ ...s, [m.id]: (s[m.id] ?? []).filter((x) => x.id !== sid) }))}
            />
          ))}

          {banner ? (
            <div className="chat-banners">
              {banner.kind === 'exhausted' ? (
                <Alert kind="warning">
                  Your included usage for this month is used up. It resets on {banner.resetDate ? formatDate(banner.resetDate) : formatDate(usage?.periodEnd)}. You can wait, or connect your own OpenAI API key in <Link to="/settings#usage">Settings</Link>.
                </Alert>
              ) : banner.kind === 'needs_key' ? (
                <Alert kind="warning">
                  {banner.message} Connect your own OpenAI API key in <Link to="/settings#usage">Settings</Link>, or pick an included model above.
                </Alert>
              ) : (
                <Alert kind="error">{banner.message}</Alert>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer-inner">
          {attachments.length ? (
            <div className="composer-attachments" aria-label="Attached journal entries">
              {attachments.map((a) => (
                <span key={a.entryId} className="chip">
                  <Icons.paperclip size={13} /> {a.title}
                  <button type="button" aria-label={`Remove ${a.title}`} onClick={() => setAttachments((l) => l.filter((x) => x.entryId !== a.entryId))}><Icons.x size={12} /></button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="composer">
            <button type="button" className="btn icon secondary" aria-label="Attach a journal entry" title="Attach a journal entry" onClick={() => setAttachOpen(true)} disabled={streaming}>
              <Icons.paperclip />
            </button>
            <textarea
              ref={textareaRef}
              className="textarea"
              rows={1}
              placeholder={companion ? `Message ${companion.name}` : 'Message'}
              aria-label="Message"
              value={draft}
              disabled={streaming}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
            />
            {streaming ? (
              <button type="button" className="btn icon secondary" aria-label="Stop generating" title="Stop" onClick={stop}><Icons.stop /></button>
            ) : (
              <button type="button" className="btn icon primary" aria-label="Send message" title="Send" onClick={send} disabled={!draft.trim()}><Icons.send /></button>
            )}
          </div>
          <div className="composer-help">Enter to send · Shift+Enter for a new line</div>
        </div>
      </div>

      <AttachJournalModal
        open={attachOpen}
        allowed={user?.journalShareAllowed ?? false}
        onClose={() => setAttachOpen(false)}
        onPick={(e) => {
          setAttachments((l) => (l.some((x) => x.entryId === e.id) ? l : [...l, { entryId: e.id, title: e.title || formatDate(e.entryDate) }]));
          setAttachOpen(false);
          textareaRef.current?.focus();
        }}
      />

      <Modal
        open={summary.open}
        onClose={() => setSummary({ open: false, text: '', loading: false, starting: false })}
        title="Continue in a new chat"
        actions={
          <>
            <button type="button" className="btn secondary" onClick={() => setSummary({ open: false, text: '', loading: false, starting: false })}>Close</button>
            <button type="button" className="btn primary" disabled={summary.loading || summary.starting || !summary.text} onClick={continueFromSummary}>
              {summary.starting ? 'Starting…' : 'Start new chat from summary'}
            </button>
          </>
        }
      >
        {summary.loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 16 }}><Spinner /></div>
        ) : (
          <>
            <p className="meta">The new chat starts with this summary so the Companion has the context without the full history.</p>
            <div className="card subtle summary-body small">{summary.text}</div>
          </>
        )}
      </Modal>

      {confirmEl}
    </div>
  );
}

/* ------------------------------------------------------------------ usage banner */
function UsageBanner({ usage }: { usage: UsageStatus | null }) {
  if (!usage || usage.paymentSource !== 'included' || usage.warning === 'none') return null;
  const reset = formatDate(usage.periodEnd);
  const n = usage.repliesRemaining;
  if (usage.warning === 'low') {
    return <Alert kind="info">You have {n} {n === 1 ? 'reply' : 'replies'} left this month (resets {reset}).</Alert>;
  }
  if (usage.warning === 'cost') {
    return (
      <Alert kind="warning">
        Your included usage is approaching this month's cost ceiling (resets {reset}). You can keep going for now, or connect your own OpenAI API key in <Link to="/settings#usage">Settings</Link>.
      </Alert>
    );
  }
  return (
    <Alert kind="warning">
      Only {n} {n === 1 ? 'reply' : 'replies'} left this month (resets {reset}). To keep chatting after that, connect your own OpenAI API key in <Link to="/settings#usage">Settings</Link>.
    </Alert>
  );
}

/* ------------------------------------------------------------------ message */
function sourcesLine(sources: Source[]) {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of sources) {
    const label = [s.module, s.section].filter(Boolean).join(' - ') || s.title;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    parts.push(label);
  }
  return parts.join('; ');
}

function MessageItem({ m, isLastAssistant, streaming, onCopy, onRegenerate, suggestions, onSuggestionSettled }: {
  m: Message;
  isLastAssistant: boolean;
  streaming: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  suggestions?: Suggestion[];
  onSuggestionSettled: (id: string) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-user">{m.content}</div>
        {m.attachments?.length ? (
          <div className="msg-attachments">
            {m.attachments.map((a) => (
              <span key={a.entryId} className="chip"><Icons.paperclip size={13} /> {a.title || 'Journal entry'}</span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (m.role === 'system') return null;

  const isStreaming = m.status === 'streaming';
  const failed = m.status === 'failed';
  const sources = sourcesLine(m.sources ?? []);

  return (
    <div className="msg assistant">
      <div className="msg-assistant" aria-live={isStreaming ? 'polite' : undefined} aria-busy={isStreaming || undefined}>
        {m.content ? (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
        ) : isStreaming ? (
          <span className="msg-typing" aria-label="Companion is replying" />
        ) : null}
      </div>

      {failed ? (
        <div className="msg-failed">
          <Alert kind="error">{m.error || 'The reply failed.'}</Alert>
          {isLastAssistant ? (
            <div><button type="button" className="btn secondary sm" onClick={onRegenerate} disabled={streaming}><Icons.refresh size={16} /> Retry</button></div>
          ) : null}
        </div>
      ) : null}

      {!isStreaming && !failed ? (
        <div className="msg-footer">
          <button type="button" className="btn icon ghost sm" aria-label="Copy reply" title="Copy" onClick={onCopy}><Icons.copy size={16} /></button>
          {isLastAssistant ? (
            <button type="button" className="btn icon ghost sm" aria-label="Regenerate reply" title="Regenerate" onClick={onRegenerate} disabled={streaming}><Icons.refresh size={16} /></button>
          ) : null}
          {m.status === 'stopped' ? <span className="meta"><Icons.stop size={12} /> Stopped</span> : null}
          {m.paymentSource === 'customer_key' ? <span className="chip info" title="Generated with your own API key"><Icons.key size={12} /> Your key</span> : null}
          {sources ? <p className="meta msg-sources">From the course: {sources}</p> : null}
        </div>
      ) : null}

      {suggestions?.length ? suggestions.map((s) => (
        <MemorySuggestionCard key={s.id} suggestion={s} onSettled={() => onSuggestionSettled(s.id)} />
      )) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ memory suggestion */
function MemorySuggestionCard({ suggestion, onSettled }: { suggestion: Suggestion; onSettled: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'pending' | 'editing' | 'busy' | 'approved' | 'rejected'>('pending');
  const [text, setText] = useState(suggestion.content);
  const [saved, setSaved] = useState(suggestion.content);

  async function act(body: { content?: string; status: 'approved' | 'rejected' }) {
    setMode('busy');
    try {
      await api.patch(`/api/memories/${suggestion.id}`, body);
      if (body.content) setSaved(body.content);
      setMode(body.status);
    } catch (e) {
      toast(errMessage(e, 'Could not update memory'), 'error');
      setMode('pending');
    }
  }

  if (mode === 'approved') {
    return (
      <div className="meta" role="status"><Icons.check size={14} /> Saved to memory: “{saved}”</div>
    );
  }
  if (mode === 'rejected') {
    return (
      <div className="meta" role="status">Not saved. <button type="button" className="btn ghost sm" onClick={onSettled}>Dismiss</button></div>
    );
  }

  return (
    <div className="card warm compact memory-suggestion" role="group" aria-label="Memory suggestion">
      <div className="head">
        <Icons.memory size={16} />
        <strong>Remember this?</strong>
        <span className="chip">{suggestion.category}</span>
      </div>
      {mode === 'editing' ? (
        <textarea className="textarea" aria-label="Memory text" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="small">{text}</div>
      )}
      <div className="actions">
        {mode === 'editing' ? (
          <>
            <button type="button" className="btn primary sm" disabled={!text.trim()} onClick={() => act({ content: text.trim(), status: 'approved' })}><Icons.check size={14} /> Save</button>
            <button type="button" className="btn secondary sm" onClick={() => { setText(saved); setMode('pending'); }}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary sm" disabled={mode === 'busy'} onClick={() => act({ status: 'approved' })}><Icons.check size={14} /> Approve</button>
            <button type="button" className="btn secondary sm" disabled={mode === 'busy'} onClick={() => setMode('editing')}><Icons.edit size={14} /> Edit</button>
            <button type="button" className="btn ghost sm" disabled={mode === 'busy'} onClick={() => act({ status: 'rejected' })}>Not now</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ attach journal modal */
function AttachJournalModal({ open, allowed, onClose, onPick }: { open: boolean; allowed: boolean; onClose: () => void; onPick: (e: JournalEntry) => void }) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open || !allowed) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    setQ('');
    api.get<{ entries: JournalEntry[] }>('/api/journal')
      .then((r) => !cancelled && setEntries(r.entries))
      .catch((e) => !cancelled && setError(errMessage(e, 'Could not load journal entries')));
    return () => { cancelled = true; };
  }, [open, allowed]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = entries ?? [];
    if (!needle) return list;
    return list.filter((e) => (e.title || '').toLowerCase().includes(needle) || e.entryDate.includes(needle) || formatDate(e.entryDate).toLowerCase().includes(needle));
  }, [entries, q]);

  return (
    <Modal open={open} onClose={onClose} title="Attach a journal entry" actions={<button type="button" className="btn secondary" onClick={onClose}>Cancel</button>}>
      {!allowed ? (
        <Alert kind="info">
          Journal sharing is off. Turn on “Allow sharing journal entries with the Companion” in <Link to="/privacy">Privacy & data</Link> to attach entries.
        </Alert>
      ) : (
        <>
          <p className="meta">Only the entry you choose is shared, and only in this message.</p>
          <input className="input" type="search" placeholder="Search by title or date" aria-label="Search journal entries" value={q} onChange={(e) => setQ(e.target.value)} />
          {error ? <div style={{ marginTop: 8 }}><Alert kind="error">{error}</Alert></div> : null}
          {entries === null && !error ? (
            <div className="row" style={{ justifyContent: 'center', padding: 16 }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div className="empty small">{entries?.length ? 'No entries match.' : 'No journal entries yet.'}</div>
          ) : (
            <div className="attach-list">
              {filtered.map((e) => (
                <button key={e.id} type="button" className="attach-item" onClick={() => onPick(e)}>
                  <strong>{e.title || 'Untitled entry'}</strong>
                  <span className="meta">{formatDate(e.entryDate)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
