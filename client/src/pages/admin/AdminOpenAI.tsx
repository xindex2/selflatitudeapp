import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { Alert, Field, Icons, Spinner, useConfirm, useToast } from '../../components/ui';
import { errMsg } from './adminShared';
import './admin.css';
import '../settings.css';

interface KeyStatus {
  configured: boolean;
  source: 'settings' | 'env' | null;
  last4: string | null;
  validatedAt: string | null;
  setBy: string | null;
}

/**
 * Admin → OpenAI connection. SelfLatitude's own OpenAI API key funds included usage,
 * embeddings for course search, and the owner preview. Stored encrypted; never shown again.
 */
export default function AdminOpenAI() {
  const { user } = useAuth();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [editing, setEditing] = useState(false);

  const isSuper = user?.role === 'superadmin';

  const load = () =>
    api.get<KeyStatus>('/api/admin/openai/key').then(setStatus).catch((e) => setError(errMsg(e, 'Could not load the OpenAI connection status.')));
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const r = await api.put<KeyStatus>('/api/admin/openai/key', { apiKey });
      setStatus(r);
      setApiKey('');
      setEditing(false);
      setTestResult(null);
      toast('OpenAI key saved and verified.', 'success');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      setTestResult(await api.post<{ ok: boolean; error: string | null }>('/api/admin/openai/key/test'));
    } catch (err) {
      setTestResult({ ok: false, error: errMsg(err, 'Test failed.') });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm('Remove the OpenAI key?', 'Students will not be able to get replies on included usage until a new key is added (unless OPENAI_API_KEY is set on the server).', { danger: true, confirmLabel: 'Remove key' }))) return;
    try {
      await api.del('/api/admin/openai/key');
      await load();
      toast('Key removed.');
    } catch (err) {
      setError(errMsg(err, 'Could not remove the key.'));
    }
  }

  return (
    <div className="page admin-page">
      {confirmEl}
      <div className="page-header">
        <div>
          <h1>OpenAI connection</h1>
          <p>SelfLatitude's OpenAI Platform key pays for students' included usage, course-search indexing, and your preview chats.</p>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {!status && !error ? <Spinner /> : null}

      {status ? (
        <div className="stack" style={{ maxWidth: 680 }}>
          {status.configured ? (
            <Alert kind="success">
              Connected. Key ending in <span className="mono">••••{status.last4}</span>
              {status.source === 'env' ? ' (from the server environment variable OPENAI_API_KEY).' : status.setBy ? ` (added by ${status.setBy}).` : '.'}
            </Alert>
          ) : (
            <Alert kind="warning">
              No OpenAI key yet. Students will see "The Companion is not connected to OpenAI yet" until one is added.
            </Alert>
          )}

          <div className="card settings-card">
            <h2>Platform API key</h2>
            <p className="meta" style={{ margin: 0 }}>
              Create a key in the <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">OpenAI Platform dashboard</a> under SelfLatitude's own organisation and project. The key is encrypted at rest and is never shown again after saving. Changing it does not affect students' personal keys.
            </p>

            {!isSuper ? (
              <Alert kind="info">Only a Super Admin with two-step verification can change the key. You can still test the connection.</Alert>
            ) : null}

            {isSuper && (editing || !status.configured || status.source === 'env') ? (
              <form onSubmit={save} className="stack">
                <Field label={status.configured && status.source === 'settings' ? 'Replace key' : 'API key'} hint="Starts with sk-. We verify it with OpenAI before saving.">
                  <div className="input-with-btn">
                    <input className="input mono" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" required minLength={20} />
                    <button type="button" className="btn icon ghost" aria-label={show ? 'Hide key' : 'Show key'} onClick={() => setShow((s) => !s)}>{show ? <Icons.eyeOff /> : <Icons.eye />}</button>
                  </div>
                </Field>
                {formError ? <Alert kind="error">{formError}</Alert> : null}
                <div className="row wrap">
                  <button className="btn primary" disabled={busy || apiKey.length < 20}>{busy ? 'Verifying…' : 'Save and verify'}</button>
                  {editing ? <button type="button" className="btn secondary" onClick={() => { setEditing(false); setApiKey(''); }}>Cancel</button> : null}
                </div>
              </form>
            ) : null}

            {status.configured ? (
              <div className="row wrap">
                <button className="btn secondary" onClick={test} disabled={busy}>Test connection</button>
                {isSuper && status.source === 'settings' && !editing ? <button className="btn secondary" onClick={() => setEditing(true)}>Replace key</button> : null}
                {isSuper && status.source === 'settings' ? <button className="btn danger-outline" onClick={remove}>Remove key</button> : null}
              </div>
            ) : null}
            {testResult ? (
              testResult.ok ? <Alert kind="success">OpenAI accepted the key.</Alert> : <Alert kind="error">{testResult.error}</Alert>
            ) : null}
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 8 }}>What this key is used for</h3>
            <ul className="info-list">
              <li>Replies on students' included monthly usage (capped per student in <Link to="/admin/usage">Usage limits</Link>).</li>
              <li>Embeddings when course files are indexed, and semantic search on each message.</li>
              <li>Your test chats in the Companion preview.</li>
              <li>Listing the newest models in <Link to="/admin/companion">Companion → Models</Link>.</li>
            </ul>
            <p className="meta" style={{ margin: 0 }}>Students who connect their own key are billed by OpenAI directly for their own requests; this key is not used for those.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
