import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../lib/auth';
import { Alert, Field, Logo } from '../components/ui';
import './auth.css';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo"><Logo height={52} /></div>
        <h1 className="display" style={{ fontSize: 28 }}>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </div>
      <p className="meta auth-disclaimer">The Companion is an educational tool for the SelfLatitude Foundations course. It is not therapy, medical care, or an emergency service.</p>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const loc = useLocation() as any;
  const { user, refresh, authConfig } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) nav(user.role === 'superadmin' && user.mfaEnabled && !user.mfaVerified ? '/mfa' : '/', { replace: true });
  }, [user, nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ mfaRequired: boolean; mfaMethod: 'totp' | 'email' | null; user: { mustChangePassword: boolean } }>('/api/auth/login', { email, password });
      await refresh();
      if (r.mfaRequired) nav('/mfa', { replace: true, state: { from: loc.state?.from, method: r.mfaMethod, sent: r.mfaMethod === 'email' } });
      else if (r.user.mustChangePassword) nav('/settings#password', { replace: true });
      else nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your SelfLatitude Companion."
      footer={
        <>
          <Link to="/forgot-password">Forgot your password?</Link>
          {authConfig?.allowSelfRegistration ? (
            <><span className="muted"> · </span><Link to="/register">Create an account</Link></>
          ) : null}
        </>
      }
    >
      <form onSubmit={submit} className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Email"><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const nav = useNavigate();
  const { refresh, authConfig } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/register', form);
      await refresh();
      nav('/welcome', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  }
  if (authConfig && !authConfig.allowSelfRegistration) {
    return (
      <AuthLayout title="Accounts come with your purchase" subtitle="" footer={<Link to="/login">Go to sign in</Link>}>
        <Alert kind="info">
          Your SelfLatitude Companion account is created automatically when you buy SelfLatitude Foundations, and your
          sign-in details are emailed to you. If you have purchased the course and cannot sign in, use "Forgot your
          password" on the sign-in page or contact SelfLatitude.
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="Use the email you purchased the Foundations course with so we can connect your access." footer={<><span className="muted">Already have an account? </span><Link to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Name"><input className="input" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <button className="btn primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/forgot', { email });
    } finally {
      setSent(true);
      setBusy(false);
    }
  }
  return (
    <AuthLayout title="Reset your password" subtitle="We will email you a link that expires in one hour." footer={<Link to="/login">Back to sign in</Link>}>
      {sent ? (
        <Alert kind="success">If an account exists for {email}, a reset link is on its way.</Alert>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn primary" disabled={busy} style={{ width: '100%' }}>Send reset link</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match.');
    setError('');
    try {
      await api.post('/api/auth/reset', { token, password });
      setDone(true);
      setTimeout(() => nav('/login'), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset password.');
    }
  }
  return (
    <AuthLayout title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      {done ? (
        <Alert kind="success">Password updated. Redirecting to sign in…</Alert>
      ) : (
        <form onSubmit={submit} className="stack">
          {!token ? <Alert kind="error">This link is missing its token. Request a new one.</Alert> : null}
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label="New password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Confirm password"><input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <button className="btn primary" disabled={!token} style={{ width: '100%' }}>Update password</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function OneTimePage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState('');
  useEffect(() => {
    const token = params.get('token');
    if (!token) return setError('This link is missing its token.');
    api
      .post<{ mfaRequired: boolean; mfaMethod: 'totp' | 'email' | null }>('/api/auth/one-time', { token })
      .then(async (r) => {
        await refresh();
        if (r.mfaRequired) nav('/mfa', { replace: true, state: { method: r.mfaMethod, sent: r.mfaMethod === 'email' } });
        else nav('/', { replace: true });
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'This link is no longer valid.'));
  }, [params, nav, refresh]);
  return (
    <AuthLayout title="Signing you in…" footer={<Link to="/login">Go to sign in</Link>}>
      {error ? <Alert kind="error">{error}</Alert> : <p className="muted">One moment.</p>}
    </AuthLayout>
  );
}
