import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../lib/auth';
import { Alert, Logo, Toggle } from '../components/ui';
import './auth.css';

/**
 * First login: confirm Terms, Privacy Notice, age, and the optional memory choice.
 * Briefly explains included usage, the private journal, and that this is not therapy.
 */
export default function OnboardingPage() {
  const nav = useNavigate();
  const { user, refresh } = useAuth();
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [adult, setAdult] = useState(false);
  const [memory, setMemory] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user?.onboardingCompleted) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!terms || !privacy || !adult) return setError('Please confirm each item to continue.');
    setBusy(true);
    try {
      await api.post('/api/auth/onboarding', { acceptTerms: true, acceptPrivacy: true, isAdult: true, memoryEnabled: memory });
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your choices.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <Logo height={48} />
      <h1 className="display" style={{ marginTop: 32 }}>Welcome, {user?.name?.split(' ')[0] ?? 'there'}.</h1>
      <p className="muted" style={{ fontSize: 17 }}>Before you begin, a few things worth knowing about your Companion.</p>

      <div className="card warm">
        <h3 style={{ marginBottom: 12 }}>How the Companion works</h3>
        <ul className="small">
          <li><strong>Grounded in the course.</strong> Answers follow SelfLatitude's instructions and draw on the approved Foundations materials.</li>
          <li><strong>Included usage.</strong> Your membership includes a monthly allowance of Companion replies. You can see what is left at any time, and optionally connect your own OpenAI key if you run out.</li>
          <li><strong>Your journal is private.</strong> Nothing you write in the journal is sent to the Companion unless you choose "Discuss with Companion" on an entry.</li>
          <li><strong>Memory is yours to control.</strong> The Companion only remembers things across chats that you approve, and you can edit or delete them any time.</li>
          <li><strong>Not therapy or emergency care.</strong> The Companion is an educational and personal-development tool. It cannot diagnose, treat, or respond to emergencies. If you are in crisis, contact local emergency services or a crisis line.</li>
        </ul>
      </div>

      <form onSubmit={submit} className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <label className="checkbox"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /><span>I accept the SelfLatitude <a href="/terms" target="_blank" rel="noopener">Terms of Use</a>.</span></label>
        <label className="checkbox"><input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} /><span>I have read the <a href="/privacy-notice" target="_blank" rel="noopener">Privacy Notice</a> and understand how my information is handled.</span></label>
        <label className="checkbox"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /><span>I confirm I am 18 or older.</span></label>
        <div className="card compact" style={{ marginTop: 8 }}>
          <Toggle checked={memory} onChange={setMemory} label="Turn on cross-chat memory by default" />
          <p className="meta" style={{ margin: '8px 0 0' }}>You can change this per conversation and in Settings. Nothing is remembered until you approve it.</p>
        </div>
        <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Continue to the Companion'}</button>
      </form>
    </div>
  );
}
