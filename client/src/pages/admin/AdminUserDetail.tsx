import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { AdminUser, UsageStatus } from '../../api/types';
import { Alert, Field, Icons, Modal, Spinner, Toggle, formatDate, formatDateTime, useConfirm, useToast } from '../../components/ui';
import { AccessAlert, copyText, errMsg, isAccessError, money, truncate } from './adminShared';
import './admin.css';

type Role = AdminUser['role'];

interface UsageHistoryRow { period_start: string; period_end: string; payment_source: string; replies: number; cost: number }
interface Session { id: string; created_at: string; ip: string | null; user_agent: string | null; last_seen_at?: string | null }
interface AuditRow { id: string; actor_email: string | null; action: string; created_at: string }
interface Detail {
  user: AdminUser;
  usage: UsageStatus | null;
  history: UsageHistoryRow[];
  counts: { conversations: number; memories: number; journalEntries: number; repliesAllTime: number; costAllTime: number; lastMessageAt: string | null };
  plan: { id: string; name: string; durationMonths: number; priceCents: number; currency: string } | null;
  plans: { id: string; name: string; durationMonths: number; priceCents: number; currency: string }[];
  payments: { receipt: string; type: string; productCode: string; productTitle: string; amountCents: number; currency: string; result: string; note: string | null; createdAt: string }[];
  apiKey: { last4: string; valid: boolean; activeUntil: string | null; keepUsing: boolean; validatedAt: string | null } | null;
  sessions: Session[];
  audit: AuditRow[];
}

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

function companionStatus(u: AdminUser) {
  if (u.status === 'suspended') return { label: 'Suspended', chip: 'error' };
  if (!u.companionEnd) return { label: 'No Companion access', chip: '' };
  if (new Date(u.companionEnd).getTime() < Date.now()) return { label: 'Expired', chip: 'warning' };
  return { label: `Active until ${formatDate(u.companionEnd)}`, chip: 'success' };
}

function SecretModal({ open, title, warning, value, meta, onClose }: { open: boolean; title: string; warning: string; value: string; meta?: ReactNode; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open={open} onClose={onClose} title={title} actions={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        <Alert kind="warning">{warning}</Alert>
        <div className="row">
          <div className="code-box grow">{value}</div>
          <button className="btn secondary" onClick={async () => toast((await copyText(value)) ? 'Copied.' : 'Could not copy.')}><Icons.copy size={16} /> Copy</button>
        </div>
        {meta ? <div className="meta">{meta}</div> : null}
      </div>
    </Modal>
  );
}

export default function AdminUserDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Editable profile fields
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('student');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [months, setMonths] = useState('12');
  const [replyOverride, setReplyOverride] = useState('');
  const [planChoice, setPlanChoice] = useState('');
  const [costOverride, setCostOverride] = useState('');
  const [linkMinutes, setLinkMinutes] = useState('30');

  const [secret, setSecret] = useState<{ title: string; warning: string; value: string; meta?: ReactNode } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');

  const applyUser = (u: AdminUser) => {
    setName(u.name ?? '');
    setEmail(u.email ?? '');
    setRole(u.role);
    setStart(toDateInput(u.companionStart));
    setEnd(toDateInput(u.companionEnd));
    setReplyOverride(u.replyLimitOverride == null ? '' : String(u.replyLimitOverride));
    setPlanChoice(u.planId ?? '');
    setCostOverride(u.costLimitOverride == null ? '' : String(u.costLimitOverride));
  };

  const load = useCallback(async () => {
    try {
      const r = await api.get<Detail>(`/api/admin/users/${id}`);
      setData(r);
      applyUser(r.user);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>, okMsg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const patch = (key: string, body: Record<string, unknown>, okMsg = 'Saved.') =>
    run(key, async () => {
      const r = await api.patch<{ user: AdminUser }>(`/api/admin/users/${id}`, body);
      setData((d) => (d ? { ...d, user: r.user } : d));
      applyUser(r.user);
    }, okMsg);

  const access = (action: 'grant' | 'renew' | 'suspend' | 'revoke' | 'reactivate', extra?: { months?: number }) =>
    run(action, async () => {
      const r = await api.post<{ user: AdminUser }>(`/api/admin/users/${id}/access`, { action, ...extra });
      setData((d) => (d ? { ...d, user: r.user } : d));
      applyUser(r.user);
      await load();
    }, 'Access updated.');

  if (error) {
    return (
      <div className="page admin-page">
        <div className="page-header"><div><h1>User</h1><p><Link to="/admin/users">Back to users</Link></p></div></div>
        {isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load this user.')}</Alert>}
      </div>
    );
  }
  if (!data) return <div className="page admin-page"><Spinner /></div>;

  const { user, usage, history, counts, apiKey, sessions, audit, plan, plans, payments } = data;
  const cs = companionStatus(user);
  const profileDirty = name !== (user.name ?? '') || email !== (user.email ?? '') || role !== user.role;
  const datesDirty = start !== toDateInput(user.companionStart) || end !== toDateInput(user.companionEnd);
  const overridesDirty = replyOverride !== (user.replyLimitOverride == null ? '' : String(user.replyLimitOverride)) || costOverride !== (user.costLimitOverride == null ? '' : String(user.costLimitOverride));

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <p style={{ margin: '0 0 6px' }}><Link to="/admin/users">← Users</Link></p>
          <h1>{user.name || user.email}</h1>
          <p>
            {user.email} · <span className={`chip ${user.status === 'active' ? 'success' : 'error'}`}>{user.status === 'active' ? 'Active' : user.status === 'suspended' ? 'Suspended' : 'Deleted'}</span>
            {' '}· Created {formatDate(user.createdAt)}
          </p>
        </div>
      </div>

      <div className="detail-grid">
        <div className="col">
          {/* Profile */}
          <div className="card">
            <h2>Profile</h2>
            <div className="grid-2">
              <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="Role">
                <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="student">Student</option>
                  <option value="owner">Owner</option>
                  <option value="superadmin">Super Admin</option>
                </select>
              </Field>
              <Field label="Course access" hint="Lifetime access to course material.">
                <Toggle checked={user.courseAccess} disabled={busy === 'courseAccess'} onChange={(v) => patch('courseAccess', { courseAccess: v })} label={user.courseAccess ? 'Enabled' : 'Disabled'} />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn primary" disabled={!profileDirty || busy === 'profile'} onClick={() => patch('profile', { name: name.trim(), email: email.trim(), role }, 'Profile saved.')}>
                {busy === 'profile' ? <Spinner /> : null} Save profile
              </button>
            </div>
          </div>

          {/* Companion access */}
          <div className="card">
            <h2>Companion access</h2>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className={`chip ${cs.chip}`}>{cs.label}</span>
            </div>
            <div className="grid-2">
              <Field label="Companion start"><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Companion end"><input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn secondary sm" disabled={!datesDirty || busy === 'dates'} onClick={() => patch('dates', { companionStart: start || null, companionEnd: end || null }, 'Dates saved.')}>Save dates</button>
            </div>
            <div className="divider" />
            <div className="row wrap">
              <input className="input" type="number" min={1} step={1} value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 90 }} aria-label="Months" />
              <button className="btn secondary sm" disabled={!!busy} onClick={() => access('grant', { months: Number(months) || 12 })}>Grant {months || 12} months</button>
              <button className="btn secondary sm" disabled={!!busy} onClick={() => access('renew', { months: Number(months) || 12 })}>Renew</button>
              <button className="btn secondary sm" disabled={!!busy || !user.companionEnd} onClick={async () => (await confirm('Revoke Companion access?', 'The student keeps lifetime course access but can no longer use the Companion.', { confirmLabel: 'Revoke' })) && access('revoke')}>Revoke</button>
              {user.status === 'suspended' ? (
                <button className="btn secondary sm" disabled={!!busy} onClick={async () => (await confirm('Reactivate this account?', 'The user will be able to sign in again.', { confirmLabel: 'Reactivate' })) && access('reactivate')}>Reactivate</button>
              ) : (
                <button className="btn danger-outline sm" disabled={!!busy} onClick={async () => (await confirm('Suspend this account?', 'The user is signed out everywhere and cannot sign in until reactivated.', { danger: true, confirmLabel: 'Suspend' })) && access('suspend')}>Suspend</button>
              )}
            </div>
            <p className="meta" style={{ marginTop: 12, marginBottom: 0 }}>Suspending signs the user out everywhere and blocks sign-in. Revoking ends Companion access but keeps lifetime course access. Renew extends from the current end date.</p>
          </div>

          {/* Usage */}
          <div className="card">
            <h2>Usage</h2>
            {usage ? (
              <dl className="kv">
                <dt>Period</dt><dd>{formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}</dd>
                <dt>Replies</dt><dd>{usage.repliesUsed} of {usage.repliesLimit} used ({usage.repliesRemaining} remaining)</dd>
                <dt>Cost</dt><dd>{money(usage.costUsed, 3)} of {money(usage.costLimit)}</dd>
                <dt>Payment source</dt><dd>{usage.paymentSource === 'customer_key' ? "Student's own key" : 'Included'}</dd>
                <dt>Warning</dt><dd>{usage.warning === 'none' ? <span className="muted">None</span> : <span className="chip warning">{usage.warning.replace('_', ' ')}</span>}{usage.includedExhausted ? <span className="chip error" style={{ marginLeft: 6 }}>Included exhausted</span> : null}</dd>
              </dl>
            ) : <p className="muted">No usage data.</p>}
            <div className="divider" />
            <div className="grid-2">
              <Field label="Reply limit override" hint="Blank = use global setting">
                <input className="input" type="number" min={0} step={1} value={replyOverride} onChange={(e) => setReplyOverride(e.target.value)} placeholder="Global" />
              </Field>
              <Field label="Cost limit override (USD)" hint="Blank = use global setting">
                <input className="input" type="number" min={0} step={0.01} value={costOverride} onChange={(e) => setCostOverride(e.target.value)} placeholder="Global" />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className="btn secondary sm"
                disabled={!overridesDirty || busy === 'overrides'}
                onClick={() => patch('overrides', {
                  replyLimitOverride: replyOverride.trim() === '' ? null : Number(replyOverride),
                  costLimitOverride: costOverride.trim() === '' ? null : Number(costOverride),
                }, 'Overrides saved.')}
              >
                Save overrides
              </button>
            </div>
            {history.length ? (
              <>
                <h3 style={{ margin: '16px 0 8px' }}>Usage history</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Period</th><th>Source</th><th className="num">Replies</th><th className="num">Cost</th></tr></thead>
                    <tbody>
                      {history.map((h, i) => (
                        <tr key={i}>
                          <td>{formatDate(h.period_start)} – {formatDate(h.period_end)}</td>
                          <td>{h.payment_source === 'customer_key' ? 'Own key' : 'Included'}</td>
                          <td className="num">{h.replies}</td>
                          <td className="num">{money(h.cost, 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </div>

          {/* Sessions */}
          <div className="card">
            <h2>Recent sessions</h2>
            {sessions.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Created</th><th>IP</th><th>User agent</th></tr></thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.created_at)}</td>
                        <td className="mono">{s.ip || ''}</td>
                        <td className="muted small" title={s.user_agent ?? ''}>{truncate(s.user_agent, 60)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted" style={{ margin: 0 }}>No active sessions.</p>}
          </div>

          {/* Audit */}
          <div className="card">
            <h2>Recent audit entries</h2>
            {audit.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Action</th><th>Actor</th><th>Date</th></tr></thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.action}</td>
                        <td>{a.actor_email || <span className="muted">system</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted" style={{ margin: 0 }}>No audit entries.</p>}
            <p className="meta" style={{ margin: '8px 0 0' }}><Link to="/admin/audit">Open full audit history</Link></p>
          </div>
        </div>

        <div className="col">
          {/* API key */}
          <div className="card">
            <h2>API key</h2>
            {apiKey ? (
              <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                <dt>Key</dt><dd className="mono">•••• {apiKey.last4}</dd>
                <dt>Valid</dt><dd>{apiKey.valid ? <span className="chip success">Valid</span> : <span className="chip error">Invalid</span>}</dd>
                <dt>Active until</dt><dd>{apiKey.activeUntil ? formatDate(apiKey.activeUntil) : <span className="muted">Not active</span>}</dd>
                <dt>Keep using</dt><dd>{apiKey.keepUsing ? 'Yes' : 'No'}</dd>
                {apiKey.validatedAt ? <><dt>Validated</dt><dd>{formatDateTime(apiKey.validatedAt)}</dd></> : null}
              </dl>
            ) : <p className="muted">No key on file.</p>}
            <p className="meta" style={{ margin: '8px 0 0' }}>The key itself is encrypted and cannot be viewed.</p>
          </div>

          {/* Plan */}
          <section className="card">
            <h2>Plan</h2>
            <p className="meta">The plan sets how long an extension lasts and the student's included usage. Changing the plan here does not extend access on its own; use "Apply plan" to start or extend it.</p>
            <div className="row wrap" style={{ gap: 8 }}>
              <select
                className="select"
                style={{ maxWidth: 320 }}
                value={planChoice}
                onChange={(e) => setPlanChoice(e.target.value)}
                aria-label="Plan"
              >
                <option value="">No plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.durationMonths ? ` · ${p.durationMonths} months` : ' · never expires'}</option>
                ))}
              </select>
              <button
                className="btn secondary sm"
                disabled={planChoice === (user.planId ?? '') || !!busy}
                onClick={() => patch('plan', { planId: planChoice || null }, 'Plan saved.')}
              >
                Save plan
              </button>
              <button
                className="btn primary sm"
                disabled={!planChoice || !!busy}
                onClick={async () => {
                  if (!(await confirm('Apply this plan?', 'This sets the plan and extends Companion access by the plan length. Existing access is extended, not replaced.', { confirmLabel: 'Apply plan' }))) return;
                  setBusy('plan');
                  try {
                    await api.post(`/api/admin/plans/${planChoice}/assign`, { userId: user.id, mode: 'extend' });
                    toast('Plan applied.', 'success');
                    load();
                  } catch (e) {
                    toast(errMsg(e, 'Could not apply the plan.'), 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Apply plan
              </button>
            </div>
            {plan ? <p className="meta" style={{ marginTop: 8 }}>Currently on <strong>{plan.name}</strong>.</p> : <p className="meta" style={{ marginTop: 8 }}>No plan assigned.</p>}
          </section>

          {/* Purchases */}
          <section className="card">
            <h2>Purchases</h2>
            {payments.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Type</th><th>Product</th><th>Amount</th><th>Result</th></tr></thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={`${p.receipt}-${p.type}-${p.createdAt}`}>
                        <td>{formatDate(p.createdAt)}</td>
                        <td><span className={`chip ${['SALE', 'BILL'].includes(p.type) ? 'success' : 'warning'}`}>{p.type}</span></td>
                        <td>{p.productTitle || p.productCode || <span className="muted">—</span>}</td>
                        <td>{money(p.amountCents / 100)}</td>
                        <td>{p.result === 'processed' ? <span className="chip success"><Icons.check size={14} /> Processed</span> : p.result === 'error' ? <span className="chip error"><Icons.warning size={14} /> Error</span> : <span className="chip">Ignored</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">No payments recorded for this account.</p>}
          </section>

          {/* Private content */}
          <div className="card">
            <h2>Private content</h2>
            <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
              <dt>Conversations</dt><dd>{counts.conversations}</dd>
              <dt>Approved memories</dt><dd>{counts.memories}</dd>
              <dt>Journal entries</dt><dd>{counts.journalEntries}</dd>
              <dt>Replies all time</dt><dd>{counts.repliesAllTime ?? 0}</dd>
              <dt>Cost to SelfLatitude</dt><dd>{money(counts.costAllTime ?? 0, 3)}</dd>
              <dt>Last message</dt><dd>{counts.lastMessageAt ? formatDateTime(counts.lastMessageAt) : <span className="muted">Never</span>}</dd>
            </dl>
            <p className="meta" style={{ margin: '8px 0 0' }}>Administrators cannot read private conversations, memories, or journal entries.</p>
          </div>

          {/* Security */}
          <div className="card">
            <h2>Security</h2>
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr', marginBottom: 12 }}>
              <dt>MFA</dt><dd>{user.mfaEnabled ? 'Enabled' : 'Not enabled'}</dd>
              <dt>Last login</dt><dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : <span className="muted">Never</span>}</dd>
              <dt>Password</dt><dd>{user.mustChangePassword ? <span className="chip warning">Must change</span> : 'Set'}</dd>
            </dl>
            <div className="stack">
              <button className="btn secondary" disabled={!!busy} onClick={() => run('reset-email', () => api.post(`/api/admin/users/${id}/reset-email`).then(() => undefined), 'Password reset email sent.')}>
                Send password reset email
              </button>
              <button
                className="btn secondary"
                disabled={!!busy}
                onClick={async () => {
                  if (!(await confirm('Set a temporary password?', 'The current password stops working. The temporary password is shown once and must be changed at next sign-in.', { confirmLabel: 'Set password' }))) return;
                  run('temp-password', async () => {
                    const r = await api.post<{ temporaryPassword: string }>(`/api/admin/users/${id}/temp-password`);
                    setSecret({ title: 'Temporary password', warning: 'Shown once and never again. Share it securely.', value: r.temporaryPassword });
                  });
                }}
              >
                Set temporary password
              </button>
              <div className="row">
                <select className="select" value={linkMinutes} onChange={(e) => setLinkMinutes(e.target.value)} aria-label="Link expiry" style={{ width: 'auto' }}>
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                  <option value="60">1 hour</option>
                  <option value="240">4 hours</option>
                </select>
                <button
                  className="btn secondary grow"
                  disabled={!!busy}
                  onClick={() => run('one-time-link', async () => {
                    const r = await api.post<{ link: string; expiresInMinutes: number }>(`/api/admin/users/${id}/one-time-link`, { minutes: Number(linkMinutes) });
                    setSecret({ title: 'One-time login link', warning: 'This link signs the user in once. It is shown only now.', value: r.link, meta: `Expires in ${r.expiresInMinutes} minutes.` });
                  })}
                >
                  Generate one-time login link
                </button>
              </div>
              <button className="btn secondary" disabled={!!busy} onClick={() => run('sign-out', () => api.post(`/api/admin/users/${id}/sign-out-everywhere`).then(() => load()), 'Signed out everywhere.')}>
                Sign out everywhere
              </button>
            </div>
          </div>

          {/* Danger zone */}
          <div className="card danger-zone">
            <h2>Danger zone</h2>
            <p className="small">Permanently deletes the account and all private content. This cannot be undone.</p>
            <button className="btn danger-outline" disabled={!!busy} onClick={() => { setDeleteTyped(''); setDeleteOpen(true); }}>
              <Icons.trash size={16} /> Delete user permanently
            </button>
          </div>
        </div>
      </div>

      {confirmEl}

      <SecretModal open={!!secret} title={secret?.title ?? ''} warning={secret?.warning ?? ''} value={secret?.value ?? ''} meta={secret?.meta} onClose={() => setSecret(null)} />

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete user permanently"
        actions={
          <>
            <button className="btn secondary" onClick={() => setDeleteOpen(false)}>Cancel</button>
            <button
              className="btn danger"
              disabled={deleteTyped.trim().toLowerCase() !== user.email.toLowerCase() || busy === 'delete'}
              onClick={() => run('delete', async () => {
                await api.del(`/api/admin/users/${id}`);
                setDeleteOpen(false);
                nav('/admin/users');
              }, 'User deleted.')}
            >
              {busy === 'delete' ? <Spinner /> : null} Delete permanently
            </button>
          </>
        }
      >
        <div className="stack">
          <Alert kind="error">This removes the account, conversations, memories, and journal entries. It cannot be undone.</Alert>
          <Field label={`Type the email address to confirm: ${user.email}`}>
            <input className="input" value={deleteTyped} onChange={(e) => setDeleteTyped(e.target.value)} autoFocus />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
