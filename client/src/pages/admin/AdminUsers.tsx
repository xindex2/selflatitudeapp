import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { AdminUser } from '../../api/types';
import { Alert, Field, Icons, Modal, Spinner, formatDate, formatDateTime, useToast } from '../../components/ui';
import { AccessAlert, copyText, errMsg, isAccessError } from './adminShared';
import './admin.css';
import '../settings.css';

type Role = AdminUser['role'];
type StatusFilter = 'all' | 'active' | 'suspended';

function companionAccess(u: AdminUser) {
  if (!u.companionEnd) return 'None';
  const end = new Date(u.companionEnd);
  if (end.getTime() < Date.now()) return 'Expired';
  return `Active until ${formatDate(u.companionEnd)}`;
}

const roleLabel: Record<Role, string> = { student: 'Student', owner: 'Owner', superadmin: 'Super Admin' };

interface Credentials { email: string; password: string; loginUrl: string }
interface PlanOption { id: string; name: string }

function AddUserModal({ open, onClose, onCreated, plans }: {
  open: boolean;
  onClose: () => void;
  onCreated: (user: AdminUser, credentials: Credentials, emailed: string | null, emailError: string | null) => void;
  plans: PlanOption[];
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('student');
  const [planId, setPlanId] = useState('');
  const [months, setMonths] = useState('12');
  const [delivery, setDelivery] = useState<'welcome' | 'reset' | 'none'>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail(''); setName(''); setRole('student');
      setPlanId(plans[0]?.id ?? ''); setMonths('12'); setDelivery('welcome'); setError(null);
    }
  }, [open, plans]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: AdminUser; credentials: Credentials; emailed: string | null; emailError: string | null }>('/api/admin/users', {
        email: email.trim(),
        name: name.trim(),
        role,
        planId: planId || null,
        grantCompanionMonths: planId ? undefined : Number(months) || 0,
        sendWelcomeEmail: delivery === 'welcome',
        sendResetEmail: delivery === 'reset',
      });
      onCreated(r.user, r.credentials, r.emailed, r.emailError);
    } catch (err) {
      setError(errMsg(err, 'Could not create the user.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add user"
      actions={
        <>
          <button className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" form="add-user-form" type="submit" disabled={busy || !email.trim() || !name.trim()}>
            {busy ? <Spinner /> : null} Create user
          </button>
        </>
      }
    >
      <form id="add-user-form" onSubmit={submit} className="stack">
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Email">
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Name">
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="student">Student</option>
            <option value="owner">Owner</option>
            <option value="superadmin">Super Admin</option>
          </select>
        </Field>
        <Field label="Plan" hint="The plan sets how long Companion access lasts and how much included usage they get.">
          <select className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="">No plan (set the months by hand)</option>
          </select>
        </Field>
        {!planId ? (
          <Field label="Grant Companion access (months)" hint="0 leaves Companion access off. Lifetime course access is always granted.">
            <input className="input" type="number" min={0} step={1} value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Sign-in details">
          <select className="select" value={delivery} onChange={(e) => setDelivery(e.target.value as typeof delivery)}>
            <option value="welcome">Email them a welcome message with their password</option>
            <option value="reset">Email them a link to choose their own password</option>
            <option value="none">Do not email; I will share the details myself</option>
          </select>
        </Field>
        <p className="meta" style={{ margin: 0 }}>
          The password is shown to you once after the account is created so you can copy it.
        </p>
      </form>
    </Modal>
  );
}

export default function AdminUsers() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [planFilter, setPlanFilter] = useState('');
  const [data, setData] = useState<{ users: AdminUser[]; total: number; page: number; pageSize: number; plans: PlanOption[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [created, setCreated] = useState<{ credentials: Credentials; emailed: string | null; emailError: string | null } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status !== 'all') params.set('status', status);
      if (planFilter) params.set('planId', planFilter);
      params.set('page', String(page));
      const r = await api.get<{ users: AdminUser[]; total: number; page: number; pageSize: number; plans: PlanOption[] }>(`/api/admin/users?${params.toString()}`);
      setData(r);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [q, status, planFilter, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 1))) : 1;

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p>Accounts, roles, and Companion access.</p>
        </div>
        <button className="btn primary" onClick={() => setAddOpen(true)} disabled={isAccessError(error)}><Icons.plus /> Add user</button>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load users.')}</Alert>}</div>
      ) : null}

      {!isAccessError(error) ? (
        <>
          <div className="toolbar">
            <input className="input" type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
            <select className="select" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); }} aria-label="Status filter">
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
            <select className="select" value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); setPage(1); }} aria-label="Plan filter">
              <option value="">All plans</option>
              {(data?.plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {loading ? <Spinner /> : null}
            {data ? <span className="meta">{data.total} user{data.total === 1 ? '' : 's'}</span> : null}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Plan</th>
                    <th>Companion access</th>
                    <th>Replies</th>
                    <th>Last login</th>
                    <th>MFA</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.users.map((u) => (
                    <tr
                      key={u.id}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => nav(`/admin/users/${u.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(`/admin/users/${u.id}`); } }}
                    >
                      <td>{u.name || <span className="muted">—</span>}</td>
                      <td>{u.email}</td>
                      <td><span className={`chip ${u.role !== 'student' ? 'info' : ''}`}>{roleLabel[u.role]}</span></td>
                      <td>
                        <span className={`chip ${u.status === 'active' ? 'success' : u.status === 'suspended' ? 'error' : ''}`}>
                          {u.status === 'active' ? 'Active' : u.status === 'suspended' ? 'Suspended' : 'Deleted'}
                        </span>
                      </td>
                      <td>{u.planName ?? <span className="muted">None</span>}</td>
                      <td>{companionAccess(u)}</td>
                      <td>{u.repliesTotal ?? 0}</td>
                      <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="muted">Never</span>}</td>
                      <td>{u.mfaEnabled ? (u.mfaMethod === 'email' ? 'Email code' : 'App') : 'No'}</td>
                    </tr>
                  ))}
                  {data && data.users.length === 0 ? (
                    <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 32 }}>No users match.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="pager">
            <span className="meta">Page {data?.page ?? page} of {totalPages}</span>
            <div className="row">
              <button className="btn secondary sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}><Icons.chevronLeft size={16} /> Prev</button>
              <button className="btn secondary sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next <Icons.chevronRight size={16} /></button>
            </div>
          </div>
        </>
      ) : null}

      <AddUserModal
        open={addOpen}
        plans={data?.plans ?? []}
        onClose={() => setAddOpen(false)}
        onCreated={(user, credentials, emailed, emailError) => {
          setAddOpen(false);
          toast(`Created ${user.email}.`, 'success');
          load();
          setCreated({ credentials, emailed, emailError });
        }}
      />

      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title="Account created"
        actions={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}
      >
        {created ? (
          <div className="stack">
            {created.emailError ? (
              <Alert kind="error">The account was created but the email could not be sent: {created.emailError}. Copy the details below and send them yourself.</Alert>
            ) : created.emailed === 'welcome' ? (
              <Alert kind="success">A welcome email with these sign-in details has been sent.</Alert>
            ) : created.emailed === 'reset' ? (
              <Alert kind="success">An email with a link to choose their own password has been sent. The password below still works until they use it.</Alert>
            ) : (
              <Alert kind="warning">No email was sent. Share these details with the student securely.</Alert>
            )}
            <Alert kind="warning">This password is shown once and will not be shown again. They must change it at first sign-in.</Alert>

            <div className="kv">
              {([['Sign-in page', created.credentials.loginUrl], ['Email', created.credentials.email], ['Password', created.credentials.password]] as const).map(([label, value]) => (
                <div className="kv-row" key={label}>
                  <span className="k">{label}</span>
                  <span className="v">
                    <span className="mono">{value}</span>
                    <button className="btn ghost icon sm" aria-label={`Copy ${label}`} onClick={async () => toast((await copyText(value)) ? 'Copied.' : 'Could not copy.')}>
                      <Icons.copy size={16} />
                    </button>
                  </span>
                </div>
              ))}
            </div>

            <button
              className="btn secondary"
              onClick={async () => {
                const block = `Sign in: ${created.credentials.loginUrl}\nEmail: ${created.credentials.email}\nPassword: ${created.credentials.password}`;
                toast((await copyText(block)) ? 'All sign-in details copied.' : 'Could not copy.');
              }}
            >
              <Icons.copy size={16} /> Copy all sign-in details
            </button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
