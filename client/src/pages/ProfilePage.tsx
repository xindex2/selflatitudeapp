import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { UsageStatus } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Avatar, Field, Icons, Modal, Spinner, formatDate, useConfirm, useToast } from '../components/ui';
import './settings.css';
import './profile.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Profile: picture, name, sign-in email, password, and a summary of the plan and
 * remaining credits. Usage details and the API key live in Settings.
 */
export default function ProfilePage() {
  const { user, usage, plan, setUsage, logout } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    // Credits can be stale if the user has been chatting in another tab.
    api.get<{ usage: UsageStatus }>('/api/usage').then((r) => setUsage(r.usage)).catch(() => {});
  }, [setUsage]);

  if (!user) return null;

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Profile</h1>
          <p>Your picture, name, and sign-in details.</p>
        </div>
      </div>

      <AvatarSection />
      <NameSection />
      <EmailSection />
      <PasswordSection />

      <section className="section settings-section">
        <h2>Your plan and credits</h2>
        <div className="card settings-card">
          <div className="kv">
            <div className="kv-row">
              <span className="k">Plan</span>
              <span className="v">{plan ? plan.name : <span className="muted">No plan assigned</span>}</span>
            </div>
            <div className="kv-row">
              <span className="k">Companion access</span>
              <span className="v">
                {user.companionActive ? (
                  <span className="chip success"><Icons.check size={14} /> {user.companionEnd ? `Active until ${formatDate(user.companionEnd)}` : 'Active'}</span>
                ) : (
                  <span className="chip warning"><Icons.warning size={14} /> Not active</span>
                )}
              </span>
            </div>
            <div className="kv-row">
              <span className="k">Course access</span>
              <span className="v">{user.courseAccess ? 'Lifetime' : <span className="muted">Not granted</span>}</span>
            </div>
            {usage ? (
              <>
                <div className="kv-row">
                  <span className="k">Replies left this month</span>
                  <span className="v">
                    <strong>{usage.repliesRemaining}</strong>
                    <span className="muted">of {usage.repliesLimit}</span>
                  </span>
                </div>
                <div className="kv-row">
                  <span className="k">Next reset</span>
                  <span className="v">{formatDate(usage.periodEnd)}</span>
                </div>
                <div className="kv-row">
                  <span className="k">Paid by</span>
                  <span className="v">
                    {usage.paymentSource === 'customer_key'
                      ? <span className="chip info"><Icons.key size={14} /> Your own OpenAI key</span>
                      : <span className="chip">Included with your membership</span>}
                  </span>
                </div>
              </>
            ) : null}
          </div>
          {usage ? (
            <div className="usage-meter">
              <div className={`bar ${usage.warning === 'none' ? '' : usage.includedExhausted ? 'error' : 'warning'}`}>
                <span style={{ width: `${usage.repliesLimit ? Math.min(100, (usage.repliesUsed / usage.repliesLimit) * 100) : 0}%` }} />
              </div>
            </div>
          ) : null}
          <div className="settings-actions">
            <Link className="btn secondary" to="/settings#usage">Usage and API key</Link>
            <Link className="btn ghost" to="/help">Get help</Link>
          </div>
        </div>
      </section>

      <div className="settings-footer">
        <button className="btn secondary" onClick={() => logout().then(() => nav('/login'))}>
          <Icons.logout size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Picture */
function AvatarSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cache-buster so a new picture appears immediately.
  const [version, setVersion] = useState(0);

  if (!user) return null;

  /** Shrink to a 256px square in the browser so uploads stay small. */
  async function resize(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process the image.');
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    bitmap.close?.();
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the image.'))), 'image/png', 0.92),
    );
  }

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    try {
      const blob = await resize(file);
      const form = new FormData();
      form.append('avatar', blob, 'avatar.png');
      await api.upload('/api/profile/avatar', form);
      await refresh();
      setVersion((v) => v + 1);
      toast('Picture updated.', 'success');
    } catch (e) {
      setError(errText(e, 'Could not upload that picture.'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    if (!(await confirm('Remove your picture?', 'Your initials will be shown instead.', { confirmLabel: 'Remove' }))) return;
    setBusy(true);
    try {
      await api.del('/api/profile/avatar');
      await refresh();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errText(e, 'Could not remove the picture.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-section">
      {confirmEl}
      <h2>Picture</h2>
      <div className="card settings-card">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="avatar-editor">
          <Avatar name={user.name} email={user.email} src={user.avatarUrl ? `${user.avatarUrl}?v=${version}` : null} size={88} />
          <div className="grow">
            <p className="small" style={{ margin: 0 }}>A PNG, JPEG or WebP image. It is cropped to a square and resized in your browser before it is uploaded.</p>
            <div className="settings-actions" style={{ marginTop: 12 }}>
              <button className="btn secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
                {busy ? <Spinner /> : <Icons.edit size={16} />} {user.avatarUrl ? 'Change picture' : 'Upload picture'}
              </button>
              {user.avatarUrl ? <button className="btn ghost" onClick={remove} disabled={busy}>Remove</button> : null}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Name */
function NameSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(user?.name ?? ''), [user?.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch('/api/auth/profile', { name: name.trim() });
      await refresh();
      toast('Name saved.', 'success');
    } catch (e) {
      setError(errText(e, 'Could not save your name.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-section">
      <h2>Name</h2>
      <form className="card settings-card" onSubmit={save}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="settings-form">
          <Field label="Display name" hint="The Companion uses this when it addresses you.">
            <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="settings-actions">
          <button className="btn primary" disabled={busy || !name.trim() || name.trim() === user?.name}>
            {busy ? <Spinner /> : null} Save name
          </button>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ Email */
function EmailSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = user?.pendingEmail ?? null;

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/profile/email', { newEmail: newEmail.trim(), password });
      await refresh();
      setOpen(false);
      setPassword('');
      toast('We sent a code to the new address.', 'success');
    } catch (e) {
      setError(errText(e, 'Could not start the change.'));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/profile/email/verify', { code: code.trim() });
      await refresh();
      setCode('');
      setNewEmail('');
      toast('Email address updated.', 'success');
    } catch (e) {
      setError(errText(e, 'Could not confirm the code.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api.post('/api/profile/email/cancel');
      await refresh();
      setCode('');
      setError(null);
    } catch (e) {
      setError(errText(e, 'Could not cancel the change. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-section" id="email">
      <h2>Sign-in email</h2>
      <div className="card settings-card">
        {error && !open ? <Alert kind="error">{error}</Alert> : null}
        <div className="kv">
          <div className="kv-row">
            <span className="k">Email</span>
            <span className="v">{user?.email}</span>
          </div>
        </div>

        {pending ? (
          <>
            <Alert kind="info">
              Waiting for confirmation. We emailed a 6-digit code to <strong>{pending}</strong>. Your address changes only once
              you enter it, so a typo cannot lock you out.
            </Alert>
            <form className="settings-form" onSubmit={verify}>
              <Field label="Code from the new address">
                <input className="input" inputMode="numeric" pattern="[0-9]*" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <div className="settings-actions">
                <button className="btn primary" disabled={busy || code.length < 6}>{busy ? <Spinner /> : null} Confirm new email</button>
                <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>Cancel change</button>
              </div>
            </form>
          </>
        ) : (
          <div className="settings-actions">
            <button className="btn secondary" onClick={() => { setError(null); setNewEmail(''); setOpen(true); }}>Change email</button>
          </div>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Change your sign-in email"
        actions={
          <>
            <button className="btn secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn primary" form="email-change-form" type="submit" disabled={busy || !newEmail.trim() || !password}>
              {busy ? <Spinner /> : null} Send confirmation code
            </button>
          </>
        }
      >
        <form id="email-change-form" onSubmit={start} className="stack">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="small muted" style={{ margin: 0 }}>We will email a code to the new address. Your current address keeps working until you enter it.</p>
          <Field label="New email">
            <input className="input" type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </Field>
          <Field label="Your current password">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </section>
  );
}

/* ------------------------------------------------------------------ Password */
function PasswordSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (next !== confirmPw) return setError('The new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      await refresh();
      setCurrent(''); setNext(''); setConfirmPw('');
      toast('Password changed.', 'success');
    } catch (e) {
      setError(errText(e, 'Could not change your password.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-section" id="password">
      <h2>Password</h2>
      {user?.mustChangePassword ? (
        <div style={{ marginBottom: 12 }}>
          <Alert kind="warning">You signed in with a temporary password. Please choose your own now.</Alert>
        </div>
      ) : null}
      <form className="card settings-card" onSubmit={save}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="settings-form">
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input className="input" type="password" autoComplete="new-password" minLength={10} required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" autoComplete="new-password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          </Field>
        </div>
        <div className="settings-actions">
          <button className="btn primary" disabled={busy || !current || next.length < 10}>{busy ? <Spinner /> : null} Change password</button>
          <Link className="btn ghost" to="/settings#mfa">Two-step verification</Link>
        </div>
      </form>
    </section>
  );
}
