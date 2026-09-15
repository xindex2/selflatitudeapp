import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, downloadUrl } from '../api/client';
import { useAuth } from '../lib/auth';
import { notifyConversationsChanged } from '../components/ConversationSidebar';
import { Alert, Field, Icons, Modal, Spinner, Toggle, formatDate, formatDateTime, useConfirm, useToast } from '../components/ui';
import './settings.css';

type RequestKind = 'access' | 'correction' | 'portability' | 'deletion' | 'consent' | 'other';
type RequestStatus = 'open' | 'in_progress' | 'closed';

interface PrivacyRequest {
  id: string;
  kind: RequestKind;
  message: string | null;
  status: RequestStatus;
  due_at: string | null;
  created_at: string;
}

interface PrivacyData {
  settings: { memoryEnabledDefault: boolean; journalShareAllowed: boolean };
  consent: { termsVersion: string | null; privacyVersion: string | null; consentAt: string | null; currentTerms: string; currentPrivacy: string };
  requests: PrivacyRequest[];
}

const KIND_LABELS: Record<RequestKind, string> = {
  access: 'Access to my data',
  correction: 'Correct my data',
  portability: 'Portability',
  deletion: 'Deletion',
  consent: 'Withdraw consent',
  other: 'Other',
};

const STATUS_CHIP: Record<RequestStatus, { cls: string; label: string; Icon: (p: { size?: number }) => JSX.Element }> = {
  open: { cls: 'warning', label: 'Open', Icon: Icons.clock },
  in_progress: { cls: 'info', label: 'In progress', Icon: Icons.refresh },
  closed: { cls: 'success', label: 'Closed', Icon: Icons.check },
};

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export default function PrivacyPage() {
  const { refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmEl] = useConfirm();

  const [data, setData] = useState<PrivacyData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<PrivacyData>('/api/privacy');
      setData(r);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load your privacy settings.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* --- settings toggles */
  async function updateSetting(patch: Partial<PrivacyData['settings']>) {
    if (!data) return;
    const prev = data.settings;
    setData({ ...data, settings: { ...prev, ...patch } });
    setSavingSettings(true);
    try {
      await api.patch('/api/privacy/settings', patch);
      await refresh();
      toast('Settings saved.', 'success');
    } catch (err) {
      setData((d) => (d ? { ...d, settings: prev } : d));
      toast(errorMessage(err, 'Could not save settings.'), 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  /* --- delete all */
  const [deleting, setDeleting] = useState<string | null>(null);
  async function deleteAll(what: 'conversations' | 'memories' | 'journal', label: string) {
    const ok = await confirm(`Delete all ${label}?`, `This permanently removes all of your ${label}. This cannot be undone.`, { danger: true, confirmLabel: `Delete all ${label}` });
    if (!ok) return;
    setDeleting(what);
    try {
      await api.post('/api/privacy/delete-all', { what });
      // Other screens hold their own copies of this data; tell them it is gone.
      if (what === 'conversations') notifyConversationsChanged();
      window.dispatchEvent(new CustomEvent('sl:data-deleted', { detail: { what } }));
      toast(`All ${label} deleted.`, 'success');
    } catch (err) {
      toast(errorMessage(err, `Could not delete your ${label}.`), 'error');
    } finally {
      setDeleting(null);
    }
  }

  /* --- privacy request */
  const [kind, setKind] = useState<RequestKind>('access');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState('');
  async function submitRequest(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setRequestError('');
    try {
      const r = await api.post<{ request: PrivacyRequest }>('/api/privacy/requests', { kind, message: message.trim() || undefined });
      setData((d) => (d ? { ...d, requests: [r.request, ...d.requests] } : d));
      setMessage('');
      toast('Your request was submitted.', 'success');
    } catch (err) {
      setRequestError(errorMessage(err, 'Could not submit your request.'));
    } finally {
      setSubmitting(false);
    }
  }

  /* --- delete account */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  async function deleteAccount() {
    setDeletingAccount(true);
    setDeleteError('');
    try {
      await api.post('/api/privacy/delete-account', { password, confirm: 'DELETE' });
      setDeleteOpen(false);
      await refresh();
      navigate('/login', { replace: true });
    } catch (err) {
      setDeleteError(errorMessage(err, 'Could not delete your account.'));
    } finally {
      setDeletingAccount(false);
    }
  }

  const consent = data?.consent;
  const policiesUpdated = !!consent && (consent.currentTerms !== consent.termsVersion || consent.currentPrivacy !== consent.privacyVersion);

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Privacy &amp; data</h1>
          <p>You control what the Companion remembers, what it can see, and what happens to your information.</p>
        </div>
      </div>

      {loadError ? <div className="section"><Alert kind="error">{loadError}</Alert></div> : null}

      {/* Consent & memory settings */}
      <section className="section settings-section" id="consent">
        <h2>Consent &amp; memory settings</h2>
        <div className="card settings-card">
          {!data ? (
            <Spinner />
          ) : (
            <>
              <div className="stack">
                <Toggle
                  checked={data.settings.memoryEnabledDefault}
                  disabled={savingSettings}
                  onChange={(v) => updateSetting({ memoryEnabledDefault: v })}
                  label="Use cross-chat memory by default"
                />
                <p className="settings-note">New conversations will use your approved memories. You can still turn memory off for any single chat.</p>
                <Toggle
                  checked={data.settings.journalShareAllowed}
                  disabled={savingSettings}
                  onChange={(v) => updateSetting({ journalShareAllowed: v })}
                  label="Allow me to attach journal entries to conversations"
                />
                <p className="settings-note">Journal entries are private. They are only shared with the Companion when you attach one yourself.</p>
              </div>
              <div className="divider" />
              {consent?.consentAt ? (
                <p className="small" style={{ margin: 0 }}>
                  You accepted Terms <strong>{consent.termsVersion}</strong> and Privacy Notice <strong>{consent.privacyVersion}</strong> on {formatDateTime(consent.consentAt)}.
                </p>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>No consent record found.</p>
              )}
              {policiesUpdated ? (
                <Alert kind="info">
                  Our policies have been updated since you last accepted them (Terms {consent!.currentTerms}, Privacy Notice {consent!.currentPrivacy}).
                  Please review the <Link to="/terms">Terms</Link> and the <Link to="/privacy-notice">Privacy Notice</Link>.
                </Alert>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* Export */}
      <section className="section settings-section" id="export">
        <h2>Export your information</h2>
        <div className="card settings-card">
          <div className="action-row">
            <div className="text">
              <strong>Conversations</strong>
              <span>All of your saved conversations as a single Markdown file.</span>
            </div>
            <button type="button" className="btn secondary" onClick={() => downloadUrl('/api/privacy/export/conversations.md')}><Icons.download size={16} />Download conversations (Markdown)</button>
          </div>
          <div className="action-row">
            <div className="text">
              <strong>Journal</strong>
              <span>Every journal entry, in date order.</span>
            </div>
            <button type="button" className="btn secondary" onClick={() => downloadUrl('/api/privacy/export/journal.md')}><Icons.download size={16} />Download journal (Markdown)</button>
          </div>
          <div className="action-row">
            <div className="text">
              <strong>Everything</strong>
              <span>A structured export of your account, conversations, memories, journal, and usage. Your API key is never included.</span>
            </div>
            <button type="button" className="btn secondary" onClick={() => downloadUrl('/api/privacy/export/account.json')}><Icons.download size={16} />Download everything (JSON)</button>
          </div>
        </div>
      </section>

      {/* Delete data */}
      <section className="section settings-section" id="delete-data">
        <h2>Delete data</h2>
        <div className="card settings-card">
          <div className="action-row">
            <div className="text">
              <strong>Conversations</strong>
              <span>Removes every conversation and its messages, including archived chats.</span>
            </div>
            <button type="button" className="btn danger-outline" disabled={deleting !== null} onClick={() => deleteAll('conversations', 'conversations')}>
              {deleting === 'conversations' ? <Spinner /> : <Icons.trash size={16} />}Delete all conversations
            </button>
          </div>
          <div className="action-row">
            <div className="text">
              <strong>Memories</strong>
              <span>Removes all approved, pending, and disabled memories.</span>
            </div>
            <button type="button" className="btn danger-outline" disabled={deleting !== null} onClick={() => deleteAll('memories', 'memories')}>
              {deleting === 'memories' ? <Spinner /> : <Icons.trash size={16} />}Delete all memories
            </button>
          </div>
          <div className="action-row">
            <div className="text">
              <strong>Journal</strong>
              <span>Removes every journal entry. Consider downloading your journal first.</span>
            </div>
            <button type="button" className="btn danger-outline" disabled={deleting !== null} onClick={() => deleteAll('journal', 'journal entries')}>
              {deleting === 'journal' ? <Spinner /> : <Icons.trash size={16} />}Delete all journal entries
            </button>
          </div>
        </div>
      </section>

      {/* Privacy request */}
      <section className="section settings-section" id="requests">
        <h2>Privacy request</h2>
        <div className="card settings-card">
          <form className="settings-form" onSubmit={submitRequest} style={{ maxWidth: 'none' }}>
            {requestError ? <Alert kind="error">{requestError}</Alert> : null}
            <Field label="What would you like to request?">
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as RequestKind)} style={{ maxWidth: 320 }}>
                {(Object.keys(KIND_LABELS) as RequestKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
            </Field>
            <Field label="Details (optional)">
              <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} placeholder="Tell us anything that will help us handle your request." />
            </Field>
            <div className="settings-actions">
              <button className="btn primary" disabled={submitting}>{submitting ? <Spinner /> : null}Submit request</button>
              <span className="settings-note">We respond within 30 days as required by GDPR.</span>
            </div>
          </form>

          {data && data.requests.length > 0 ? (
            <>
              <div className="divider" />
              <h3>Your requests</h3>
              <div className="request-list">
                {data.requests.map((r) => {
                  const s = STATUS_CHIP[r.status] ?? STATUS_CHIP.open;
                  return (
                    <div className="request-item" key={r.id}>
                      <div className="grow">
                        <div className="row wrap">
                          <strong>{KIND_LABELS[r.kind] ?? r.kind}</strong>
                          <span className={`chip ${s.cls}`}><s.Icon size={13} /> {s.label}</span>
                        </div>
                        {r.message ? <p className="msg">{r.message}</p> : null}
                      </div>
                      <div className="meta" style={{ textAlign: 'right' }}>
                        <div>Submitted {formatDate(r.created_at)}</div>
                        {r.due_at && r.status !== 'closed' ? <div>Due by {formatDate(r.due_at)}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </section>

      {/* Admin visibility */}
      <section className="section settings-section" id="admin-visibility">
        <h2>What administrators can see</h2>
        <div className="card subtle settings-card">
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <Icons.info size={20} />
            <div className="grow stack" style={{ gap: 10 }}>
              <p className="small" style={{ margin: 0 }}>SelfLatitude administrators can see:</p>
              <ul className="info-list">
                <li>your name, email address, and membership dates;</li>
                <li>how many replies you have used and what they cost (not what you said);</li>
                <li>audit records of account actions, such as sign-ins and settings changes.</li>
              </ul>
              <p className="small" style={{ margin: 0 }}>
                They cannot routinely read your conversations, memories, or journal. If you ask for help that requires temporary support access,
                that access is limited to what is needed and is recorded in the audit log.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Delete account */}
      <section className="section settings-section" id="delete-account">
        <h2>Delete account</h2>
        <div className="card danger-zone settings-card">
          <h3><Icons.warning size={18} /> Permanently delete my account</h3>
          <p className="small" style={{ margin: 0 }}>
            This is permanent. It removes your Companion account together with all conversations, memories, journal entries, usage records, and any saved API key.
            Your SelfLatitude course access is separate and is not affected.
          </p>
          <div className="settings-actions">
            <button type="button" className="btn danger-outline" onClick={() => { setDeleteError(''); setPassword(''); setConfirmText(''); setDeleteOpen(true); }}>
              <Icons.trash size={16} />Permanently delete my account
            </button>
          </div>
        </div>
      </section>

      <Modal
        open={deleteOpen}
        onClose={() => !deletingAccount && setDeleteOpen(false)}
        title="Delete your account?"
        actions={
          <>
            <button type="button" className="btn secondary" onClick={() => setDeleteOpen(false)} disabled={deletingAccount}>Cancel</button>
            <button type="button" className="btn danger" onClick={deleteAccount} disabled={deletingAccount || !password || confirmText !== 'DELETE'}>
              {deletingAccount ? <Spinner /> : <Icons.trash size={16} />}Delete my account
            </button>
          </>
        }
      >
        <div className="stack small">
          {deleteError ? <Alert kind="error">{deleteError}</Alert> : null}
          <Alert kind="warning">This cannot be undone. Your conversations, memories, journal, usage history, and API key will be permanently removed.</Alert>
          <Field label="Your password">
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Type DELETE to confirm">
            <input className="input mono" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" spellCheck={false} placeholder="DELETE" />
          </Field>
        </div>
      </Modal>
      {confirmEl}
    </div>
  );
}
