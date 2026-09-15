import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { UsageStatus } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Field, Icons, Modal, Spinner, formatDate, useConfirm, useToast } from '../components/ui';
import './settings.css';

interface UsageHistoryRow {
  period_start: string;
  period_end: string;
  payment_source: 'included' | 'customer_key';
  replies: number;
  cost: number;
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function money(n: number) {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

/* ------------------------------------------------------------------ Profile */
function ProfileSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setName(user?.name ?? ''), [user?.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Please enter your name.');
    setSaving(true);
    setError('');
    try {
      await api.patch('/api/auth/profile', { name: name.trim() });
      await refresh();
      toast('Profile saved.', 'success');
    } catch (err) {
      setError(errorMessage(err, 'Could not save your profile.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section settings-section" id="profile">
      <h2>Profile</h2>
      <form className="card settings-card" onSubmit={save}>
        <div className="settings-form">
          <Field label="Name" error={error || undefined}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
          </Field>
          <Field label="Email" hint="Contact SelfLatitude to change your email.">
            <input className="input" value={user?.email ?? ''} readOnly aria-readonly="true" />
          </Field>
        </div>
        <div className="settings-actions">
          <button className="btn primary" disabled={saving || name.trim() === (user?.name ?? '')}>{saving ? <Spinner /> : null}Save changes</button>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ Usage & API key */
function UsageSection() {
  const { usage, setUsage } = useAuth();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [history, setHistory] = useState<UsageHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ usage: UsageStatus; history: UsageHistoryRow[] }>('/api/usage');
      setUsage(r.usage);
      setHistory(r.history ?? []);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load your usage.'));
    } finally {
      setLoading(false);
    }
  }, [setUsage]);

  useEffect(() => {
    load();
  }, [load]);

  // API key form state
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Activation modal
  const [activateOpen, setActivateOpen] = useState(false);
  const [keepUsing, setKeepUsing] = useState(false);
  const [activating, setActivating] = useState(false);

  async function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.post<{ usage: UsageStatus }>('/api/usage/api-key', { apiKey: apiKey.trim() });
      setUsage(r.usage);
      setApiKey('');
      setShowKeyForm(false);
      toast('Your API key was saved and tested successfully.', 'success');
    } catch (err) {
      setKeyMsg({ kind: 'error', text: errorMessage(err, 'Could not save your API key.') });
    } finally {
      setKeyBusy(false);
    }
  }

  async function testKey() {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.post<{ ok: boolean; error?: string; usage: UsageStatus }>('/api/usage/api-key/test');
      if (r.usage) setUsage(r.usage);
      setKeyMsg(r.ok ? { kind: 'success', text: 'Key is valid and working.' } : { kind: 'error', text: r.error || 'Key test failed.' });
    } catch (err) {
      setKeyMsg({ kind: 'error', text: errorMessage(err, 'Could not test your API key.') });
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeKey() {
    const ok = await confirm('Remove your API key?', 'Your OpenAI key will be deleted from SelfLatitude. If it is currently in use, the Companion will switch back to included usage.', { danger: true, confirmLabel: 'Remove key' });
    if (!ok) return;
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await api.del<{ usage: UsageStatus }>('/api/usage/api-key');
      setUsage(r.usage);
      setShowKeyForm(false);
      toast('API key removed.', 'success');
    } catch (err) {
      setKeyMsg({ kind: 'error', text: errorMessage(err, 'Could not remove your API key.') });
    } finally {
      setKeyBusy(false);
    }
  }

  async function activate() {
    setActivating(true);
    try {
      const r = await api.post<{ usage: UsageStatus }>('/api/usage/api-key/activate', { keepUsing });
      setUsage(r.usage);
      setActivateOpen(false);
      toast('Now using your OpenAI key.', 'success');
    } catch (err) {
      toast(errorMessage(err, 'Could not switch to your key.'), 'error');
    } finally {
      setActivating(false);
    }
  }

  async function deactivate() {
    setKeyBusy(true);
    try {
      const r = await api.post<{ usage: UsageStatus }>('/api/usage/api-key/deactivate');
      setUsage(r.usage);
      toast('Switched back to included usage.', 'success');
    } catch (err) {
      toast(errorMessage(err, 'Could not switch back.'), 'error');
    } finally {
      setKeyBusy(false);
    }
  }

  const pct = usage && usage.repliesLimit > 0 ? Math.min(100, Math.round((usage.repliesUsed / usage.repliesLimit) * 100)) : 0;
  const barKind = !usage || usage.warning === 'none' ? '' : usage.warning === 'critical' || usage.includedExhausted ? 'error' : 'warning';
  const key = usage?.customerKey ?? null;
  const usingKey = usage?.paymentSource === 'customer_key';

  return (
    <section className="section settings-section" id="usage">
      <h2>Usage</h2>
      <div className="stack">
        {loadError ? <Alert kind="error">{loadError}</Alert> : null}
        <div className="card settings-card">
          <div className="card-title">
            <h3>Included usage this month</h3>
            {usage ? (
              usingKey && key ? (
                <span className="chip success"><Icons.key size={14} /> Your OpenAI key ••••{key.last4}</span>
              ) : (
                <span className="chip info"><Icons.info size={14} /> SelfLatitude included usage</span>
              )
            ) : null}
          </div>
          {loading && !usage ? (
            <Spinner />
          ) : usage ? (
            <>
              <div className="usage-meter">
                <div className={`bar ${barKind}`} role="progressbar" aria-valuemin={0} aria-valuemax={usage.repliesLimit} aria-valuenow={usage.repliesUsed} aria-label="Replies used this month">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div className="stats">
                  <span><strong>{usage.repliesUsed}</strong> of {usage.repliesLimit} replies used</span>
                  <span className="muted">{money(usage.costUsed)} of {money(usage.costLimit)}</span>
                </div>
                <div className="meta">Next reset: {formatDate(usage.periodEnd)}</div>
              </div>
              {usage.warning !== 'none' ? (
                <Alert kind={usage.warning === 'critical' ? 'error' : 'warning'}>
                  {usage.warning === 'cost'
                    ? 'You are approaching the monthly cost ceiling for included usage.'
                    : `${usage.repliesRemaining} ${usage.repliesRemaining === 1 ? 'reply' : 'replies'} remaining this month.`}
                  {usage.includedExhausted && !usingKey ? ' Included usage is used up until the next reset.' : ''}
                </Alert>
              ) : null}
              <p className="settings-note">Unused replies do not roll over. Failed responses never count.</p>
            </>
          ) : null}
        </div>

        <div className="card settings-card">
          <div className="card-title">
            <h3><Icons.key size={18} /> Your OpenAI API key</h3>
            {key ? (
              key.valid ? (
                <span className="chip success"><Icons.check size={14} /> Valid</span>
              ) : (
                <span className="chip error"><Icons.warning size={14} /> Invalid</span>
              )
            ) : null}
          </div>

          {keyMsg ? <Alert kind={keyMsg.kind}>{keyMsg.text}</Alert> : null}

          {key ? (
            <>
              <div className="kv">
                <div className="kv-row">
                  <span className="k">Saved key</span>
                  <span className="v mono">Key ending in ••••{key.last4}</span>
                </div>
              </div>

              {usingKey ? (
                <Alert kind="success">
                  <div className="stack" style={{ gap: 8 }}>
                    <div>
                      {key.keepUsing
                        ? 'Using your key (kept on after reset).'
                        : `Using your key until ${formatDate(key.activeUntil ?? usage?.periodEnd)}.`}
                    </div>
                    <div>
                      <button type="button" className="btn secondary sm" onClick={deactivate} disabled={keyBusy}>Switch back to included usage</button>
                    </div>
                  </div>
                </Alert>
              ) : (
                <Alert kind="info">
                  <div className="stack" style={{ gap: 8 }}>
                    <div>Your key is saved but not in use. Included usage is used first.</div>
                    <div>
                      <button type="button" className="btn primary sm" onClick={() => { setKeepUsing(false); setActivateOpen(true); }} disabled={keyBusy || !key.valid}>
                        Use my key for the rest of this month
                      </button>
                    </div>
                  </div>
                </Alert>
              )}

              <div className="settings-actions">
                <button type="button" className="btn secondary" onClick={testKey} disabled={keyBusy}>{keyBusy ? <Spinner /> : <Icons.refresh size={16} />}Test key</button>
                <button type="button" className="btn secondary" onClick={() => { setShowKeyForm((s) => !s); setKeyMsg(null); }} disabled={keyBusy}>
                  <Icons.edit size={16} />{showKeyForm ? 'Cancel replace' : 'Replace key'}
                </button>
                <button type="button" className="btn danger-outline" onClick={removeKey} disabled={keyBusy}><Icons.trash size={16} />Remove key</button>
              </div>
            </>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              If you use up your included allowance, you can connect your own OpenAI Platform API key to keep going for the rest of the month.
              Your key is encrypted and never visible to SelfLatitude staff.
            </p>
          )}

          {!key || showKeyForm ? (
            <form className="settings-form" onSubmit={saveKey}>
              <Field label={key ? 'New OpenAI API key' : 'OpenAI API key'} hint="Starts with sk-. It will be tested with OpenAI before it is saved.">
                <div className="input-with-btn">
                  <input
                    className="input"
                    type={reveal ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-..."
                  />
                  <button type="button" className="btn ghost icon" onClick={() => setReveal((r) => !r)} aria-label={reveal ? 'Hide key' : 'Show key'} title={reveal ? 'Hide key' : 'Show key'}>
                    {reveal ? <Icons.eyeOff size={18} /> : <Icons.eye size={18} />}
                  </button>
                </div>
              </Field>
              <div className="settings-actions">
                <button className="btn primary" disabled={keyBusy || !apiKey.trim()}>{keyBusy ? <Spinner /> : null}Save and test key</button>
              </div>
            </form>
          ) : null}
        </div>

        {history.length > 0 ? (
          <div className="card settings-card">
            <h3>Usage history</h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Source</th>
                    <th>Replies</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={`${h.period_start}-${h.payment_source}-${i}`}>
                      <td>{formatDate(h.period_start)} – {formatDate(h.period_end)}</td>
                      <td>{h.payment_source === 'customer_key' ? 'Your OpenAI key' : 'Included'}</td>
                      <td>{h.replies}</td>
                      <td>{money(Number(h.cost))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      <Modal
        open={activateOpen}
        onClose={() => !activating && setActivateOpen(false)}
        title="Use your own OpenAI key?"
        actions={
          <>
            <button type="button" className="btn secondary" onClick={() => setActivateOpen(false)} disabled={activating}>Cancel</button>
            <button type="button" className="btn primary" onClick={activate} disabled={activating}>{activating ? <Spinner /> : null}Confirm</button>
          </>
        }
      >
        <div className="stack small">
          <p>
            From now until the next reset on <strong>{formatDate(usage?.periodEnd)}</strong>, Companion replies will be billed to your OpenAI account instead of SelfLatitude's included usage.
            Replies made with your key do not count toward your included allowance, and you can switch back at any time.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={keepUsing} onChange={(e) => setKeepUsing(e.target.checked)} />
            <span>Keep using my key after the monthly reset too (you can change this any time)</span>
          </label>
        </div>
      </Modal>
      {confirmEl}
    </section>
  );
}

/* ------------------------------------------------------------------ Password */
function PasswordSection() {
  const { refresh } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('Your new password must be at least 8 characters.');
    if (next !== confirmPw) return setError('The new passwords do not match.');
    setSaving(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirmPw('');
      await refresh();
      toast('Password changed.', 'success');
    } catch (err) {
      setError(errorMessage(err, 'Could not change your password.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section settings-section" id="password">
      <h2>Password</h2>
      <form className="card settings-card" onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="settings-form">
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" autoComplete="new-password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          </Field>
        </div>
        <div className="settings-actions">
          <button className="btn primary" disabled={saving}>{saving ? <Spinner /> : null}Change password</button>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ Two-step verification */
function MfaSection() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [emailCodeError, setEmailCodeError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');

  const isSuper = user?.role === 'superadmin';

  async function startSetup() {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ secret: string; qr: string }>('/api/auth/mfa/setup');
      setSetup(r);
      setCode('');
    } catch (err) {
      setError(errorMessage(err, 'Could not start setup.'));
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/mfa/enable', { code });
      setSetup(null);
      setCode('');
      await refresh();
      toast('Two-step verification is on.', 'success');
    } catch (err) {
      setError(errorMessage(err, 'That code did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/mfa/disable', { password });
      setDisableOpen(false);
      setPassword('');
      await refresh();
      toast('Two-step verification is off.', 'success');
    } catch (err) {
      setError(errorMessage(err, 'Could not turn off two-step verification.'));
    } finally {
      setBusy(false);
    }
  }

  async function useEmailCodes() {
    setBusy(true);
    setEmailCodeError('');
    try {
      await api.post('/api/auth/mfa/use-email');
      await refresh();
      setSetup(null);
      toast('Emailed codes are on. Enter the code we just sent to finish.', 'success');
      nav('/mfa');
    } catch (err) {
      setEmailCodeError(errorMessage(err, 'Could not switch to emailed codes.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-section" id="mfa">
      <h2>Two-step verification</h2>
      <p className="muted small" style={{ marginTop: -4 }}>Pick one way to confirm it is you when signing in.</p>
      <div className="card settings-card">
        <div className="card-title">
          <h3><Icons.shield size={18} /> Authenticator app</h3>
          {user?.mfaMethod === 'totp' ? (
            <span className="chip success"><Icons.check size={14} /> In use</span>
          ) : (
            <span className="chip"><Icons.x size={14} /> Not set up</span>
          )}
        </div>
        {error && !disableOpen ? <Alert kind="error">{error}</Alert> : null}

        {user?.mfaMethod === 'totp' ? (
          <>
            <p className="small" style={{ margin: 0 }}>Each time you sign in, you will be asked for a 6-digit code from your authenticator app.</p>
            {isSuper ? (
              <p className="settings-note">Required for Super Admin accounts.</p>
            ) : (
              <div className="settings-actions">
                <button type="button" className="btn secondary" onClick={() => { setError(''); setDisableOpen(true); }}>Turn off</button>
              </div>
            )}
          </>
        ) : setup ? (
          <form className="mfa-setup" onSubmit={enable}>
            <img src={setup.qr} alt="QR code for your authenticator app" />
            <div className="side">
              <p className="small" style={{ margin: 0 }}>Scan this QR code with an authenticator app (such as Google Authenticator, 1Password, or Authy), then enter the 6-digit code it shows.</p>
              <div className="secret">
                <span className="muted">Can't scan? Enter this key manually:</span>
                <div className="mono">{setup.secret}</div>
              </div>
              <Field label="Authenticator code">
                <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <div className="settings-actions">
                <button className="btn primary" disabled={busy || code.length < 6}>{busy ? <Spinner /> : null}Turn on</button>
                <button type="button" className="btn ghost" onClick={() => setSetup(null)} disabled={busy}>Cancel</button>
              </div>
            </div>
          </form>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>Add a second step when signing in using a code from an authenticator app on your phone.</p>
            {isSuper ? <p className="settings-note">Required for Super Admin accounts.</p> : null}
            <div className="settings-actions">
              <button type="button" className="btn primary" onClick={startSetup} disabled={busy}>{busy ? <Spinner /> : null}Set up authenticator app</button>
            </div>
          </>
        )}
      </div>

      <div className="card settings-card">
        <div className="card-title">
          <h3><Icons.send size={18} /> Emailed code</h3>
          {user?.mfaMethod === 'email' ? (
            <span className="chip success"><Icons.check size={14} /> In use</span>
          ) : (
            <span className="chip"><Icons.x size={14} /> Not in use</span>
          )}
        </div>
        {emailCodeError ? <Alert kind="error">{emailCodeError}</Alert> : null}
        {user?.mfaMethod === 'email' ? (
          <>
            <p className="small" style={{ margin: 0 }}>Each time you sign in, we email a 6-digit code to {user.email}.</p>
            <div className="settings-actions">
              <button type="button" className="btn secondary" onClick={startSetup} disabled={busy}>Switch to an authenticator app</button>
              {!isSuper ? <button type="button" className="btn ghost" onClick={() => { setError(''); setDisableOpen(true); }}>Turn off two-step verification</button> : null}
            </div>
          </>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>No app needed. We email you a 6-digit code each time you sign in. Slower than an authenticator app, and it depends on your email arriving.</p>
            <div className="settings-actions">
              <button type="button" className="btn secondary" onClick={useEmailCodes} disabled={busy}>{busy ? <Spinner /> : null}Use emailed codes</button>
            </div>
          </>
        )}
      </div>

      <Modal
        open={disableOpen}
        onClose={() => !busy && setDisableOpen(false)}
        title="Turn off two-step verification?"
        actions={
          <>
            <button type="button" className="btn secondary" onClick={() => setDisableOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn danger" onClick={disable} disabled={busy || !password}>{busy ? <Spinner /> : null}Turn off</button>
          </>
        }
      >
        <div className="stack small">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p>Your account will be protected by your password only. Enter your password to confirm.</p>
          <Field label="Password">
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </section>
  );
}

/* ------------------------------------------------------------------ Membership */
function MembershipSection() {
  const { user } = useAuth();
  return (
    <section className="section settings-section" id="membership">
      <h2>Membership</h2>
      <div className="card settings-card">
        <div className="kv">
          <div className="kv-row">
            <span className="k">Companion access</span>
            <span className="v">
              {user?.companionActive ? (
                <span className="chip success"><Icons.check size={14} /> Active until {formatDate(user.companionEnd)}</span>
              ) : (
                <span className="chip warning"><Icons.warning size={14} /> Not active</span>
              )}
            </span>
          </div>
          <div className="kv-row">
            <span className="k">Course access</span>
            <span className="v"><span className="chip info"><Icons.check size={14} /> Lifetime</span></span>
          </div>
        </div>
        <p className="settings-note">Renewals are handled by SelfLatitude. Your course access is never affected by Companion renewal.</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Page */
export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  async function signOut() {
    try {
      await logout();
    } finally {
      navigate('/login');
    }
  }

  if (!user) return null;

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Your profile, usage, security, and membership.</p>
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 'var(--sl-space-4)' }}>
        {user.mustChangePassword ? (
          <Alert kind="warning">You signed in with a temporary password. Please <a href="#password">choose a new one</a>.</Alert>
        ) : null}
        {user.role === 'superadmin' && !user.mfaEnabled ? (
          <Alert kind="warning">Super Admin tools stay locked until you <a href="#mfa">enable two-step verification</a>.</Alert>
        ) : null}
      </div>

      <ProfileSection />
      <UsageSection />
      <PasswordSection />
      <MfaSection />
      <MembershipSection />

      <div className="settings-footer">
        <button type="button" className="btn secondary" onClick={signOut}><Icons.logout size={16} />Sign out</button>
      </div>
    </div>
  );
}
