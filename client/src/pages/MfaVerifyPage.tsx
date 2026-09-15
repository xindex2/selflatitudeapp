import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../lib/auth';
import { Alert, Field, Logo } from '../components/ui';
import './auth.css';

/**
 * Second step of sign-in. Accepts either an authenticator code or a code emailed
 * to the account, depending on how the user set their account up.
 */
export default function MfaVerifyPage() {
  const nav = useNavigate();
  const loc = useLocation() as any;
  const { user, authConfig, refresh, logout } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<boolean>(!!loc.state?.sent);
  const [sending, setSending] = useState(false);

  // Method comes from the sign-in response; fall back to the account's own setting.
  const method: 'totp' | 'email' = loc.state?.method ?? (user?.mfaMethod === 'email' ? 'email' : 'totp');
  const minutes = authConfig?.emailCodeMinutes ?? 10;

  useEffect(() => {
    if (user && !user.mfaEnabled && user.mfaMethod === 'none') nav('/', { replace: true });
  }, [user, nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/mfa/verify', { code: code.trim() });
      await refresh();
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.');
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setSending(true);
    setError('');
    try {
      await api.post('/api/auth/mfa/send-code');
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo"><Logo height={52} /></div>
        <h1 className="display" style={{ fontSize: 28 }}>Two-step verification</h1>
        {method === 'email' ? (
          <p className="muted">
            {sent
              ? `We emailed a 6-digit code to ${user?.email ?? 'your address'}. It expires in ${minutes} minutes.`
              : 'Send a 6-digit code to your email address to finish signing in.'}
          </p>
        ) : (
          <p className="muted">Enter the 6-digit code from your authenticator app{user ? ` for ${user.email}` : ''}.</p>
        )}

        <form onSubmit={submit} className="stack">
          {error ? <Alert kind="error">{error}</Alert> : null}
          {method === 'email' && !sent ? (
            <button type="button" className="btn primary" style={{ width: '100%' }} onClick={sendCode} disabled={sending}>
              {sending ? 'Sending…' : 'Email me a code'}
            </button>
          ) : (
            <>
              <Field label={method === 'email' ? 'Emailed code' : 'Authenticator code'}>
                <input
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={8}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <button className="btn primary" style={{ width: '100%' }} disabled={busy || code.length < 6}>
                {busy ? 'Checking…' : 'Verify'}
              </button>
              {method === 'email' ? (
                <button type="button" className="btn ghost" onClick={sendCode} disabled={sending}>
                  {sending ? 'Sending…' : 'Send a new code'}
                </button>
              ) : null}
            </>
          )}
        </form>

        <div className="auth-footer">
          <button className="btn ghost sm" onClick={() => logout().then(() => nav('/login'))}>Sign in as someone else</button>
        </div>
      </div>
      <p className="meta auth-disclaimer">
        If you did not try to sign in, change your password and contact SelfLatitude.
      </p>
    </div>
  );
}
