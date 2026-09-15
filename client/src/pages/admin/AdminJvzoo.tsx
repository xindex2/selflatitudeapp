import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Field, Icons, Spinner, Toggle, formatDateTime, useToast } from '../../components/ui';
import { AccessAlert, copyText, errMsg, isAccessError, money, truncate } from './adminShared';
import './admin.css';
import '../settings.css';

interface JvzooSettings {
  enabled: boolean;
  hasSecret: boolean;
  productMap: Record<string, string>;
  sendWelcomeEmail: boolean;
  revokeOnRefund: boolean;
}
interface PlanOption { id: string; name: string; durationMonths: number }
interface Stats { total: number; processed: number; errors: number; revenue_cents: number; refunded_cents: number; refunds: number }
interface JvzooResponse { settings: JvzooSettings; ipnUrl: string; plans: PlanOption[]; stats: Stats }

interface Payment {
  id: string;
  receipt: string;
  type: string;
  userId: string | null;
  userEmail: string | null;
  planId: string | null;
  productCode: string | null;
  productTitle: string | null;
  customerEmail: string | null;
  customerName: string | null;
  amountCents: number;
  currency: string;
  result: 'processed' | 'ignored' | 'error';
  note: string | null;
  createdAt: string;
  monthsGranted: number;
  grantedCourse: boolean;
  grantedUnlimited: boolean;
  reversedAt: string | null;
}

type MapRow = { code: string; planId: string };

const SUCCESS_TYPES = new Set(['SALE', 'BILL']);
const WARNING_TYPES = new Set(['RFND', 'CGBK', 'CANCEL-REBILL']);

function TypeChip({ type }: { type: string }) {
  const t = (type || '').toUpperCase();
  const kind = SUCCESS_TYPES.has(t) ? 'success' : WARNING_TYPES.has(t) ? 'warning' : '';
  return <span className={`chip ${kind}`.trim()}>{t || '—'}</span>;
}

function ResultChip({ result }: { result: Payment['result'] }) {
  if (result === 'processed') return <span className="chip success"><Icons.check size={14} /> Processed</span>;
  if (result === 'error') return <span className="chip error"><Icons.warning size={14} /> Error</span>;
  return <span className="chip">Ignored</span>;
}

export default function AdminJvzoo() {
  const toast = useToast();
  const [data, setData] = useState<JvzooResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [enabled, setEnabled] = useState(false);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);
  const [revokeOnRefund, setRevokeOnRefund] = useState(true);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const apply = (r: JvzooResponse) => {
    setData(r);
    setEnabled(r.settings.enabled);
    setSendWelcomeEmail(r.settings.sendWelcomeEmail);
    setRevokeOnRefund(r.settings.revokeOnRefund);
    setRows(Object.entries(r.settings.productMap ?? {}).map(([code, planId]) => ({ code, planId })));
    setSecret('');
  };

  const loadSettings = useCallback(async () => {
    try {
      apply(await api.get<JvzooResponse>('/api/admin/settings/jvzoo'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  const loadPayments = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.get<{ payments: Payment[] }>('/api/admin/settings/payments?limit=100');
      setPayments(r.payments);
      setPaymentsError(null);
    } catch (e) {
      setPaymentsError(errMsg(e, 'Could not load the payments log.'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadSettings(); loadPayments(); }, [loadSettings, loadPayments]);

  const setRow = (i: number, patch: Partial<MapRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const productMap: Record<string, string> = {};
    for (const r of rows) {
      const code = r.code.trim();
      if (!code) continue;
      if (!r.planId) { setFormError(`Choose a plan for product code “${code}”.`); return; }
      productMap[code] = r.planId;
    }
    const body: Record<string, unknown> = { enabled, productMap, sendWelcomeEmail, revokeOnRefund };
    if (secret) body.secret = secret;
    setSaving(true);
    try {
      await api.put('/api/admin/settings/jvzoo', body);
      await loadSettings();
      toast('JVZoo settings saved.', 'success');
    } catch (err) {
      setFormError(errMsg(err, 'Could not save the JVZoo settings.'));
    } finally {
      setSaving(false);
    }
  }

  const stats = data?.stats;

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>JVZoo &amp; payments</h1>
          <p>Connect JVZoo so a sale creates the student's account and starts their Companion access automatically.</p>
        </div>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load the JVZoo settings.')}</Alert>}</div>
      ) : null}
      {!data && !error ? <Spinner /> : null}

      {data ? (
        <form className="stack" onSubmit={save}>
          <div className="card settings-card stack">
            <h2 style={{ margin: 0 }}>Setup</h2>
            <Field label="JVZoo IPN URL">
              <div className="stack">
                <div className="code-box">{data.ipnUrl}</div>
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={async () => { const ok = await copyText(data.ipnUrl); setCopied(ok); toast(ok ? 'IPN URL copied.' : 'Could not copy — select the text instead.', ok ? 'success' : 'error'); }}
                  >
                    <Icons.copy size={16} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </Field>
            <p className="meta" style={{ margin: 0 }}>
              In JVZoo, open the product, go to Manage Your Product Settings, and paste this into the JVZoo IPN URL field. Then copy
              your JVZoo secret key from your JVZoo account settings and paste it below.
            </p>

            <Field label="JVZoo secret key" hint={data.settings.hasSecret ? 'A key is already saved. It is never shown again.' : 'Required before JVZoo notifications can be trusted.'}>
              <div className="input-with-btn">
                <input
                  className="input mono"
                  type={showSecret ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={data.settings.hasSecret ? 'Leave blank to keep the saved key' : 'Paste your JVZoo secret key'}
                />
                <button type="button" className="btn icon ghost" aria-label={showSecret ? 'Hide key' : 'Show key'} onClick={() => setShowSecret((s) => !s)}>
                  {showSecret ? <Icons.eyeOff /> : <Icons.eye />}
                </button>
              </div>
            </Field>

            <div className="stack">
              <Toggle checked={enabled} onChange={setEnabled} label="Accept JVZoo notifications" />
              <Toggle checked={sendWelcomeEmail} onChange={setSendWelcomeEmail} label="Email the student their sign-in details when a sale creates their account" />
              <Toggle checked={revokeOnRefund} onChange={setRevokeOnRefund} label="End Companion access on refunds and chargebacks (course access is never removed)" />
            </div>
          </div>

          <div className="card settings-card stack">
            <h2 style={{ margin: 0 }}>Product mapping</h2>
            <p className="meta" style={{ margin: 0 }}>
              Match each JVZoo product to the plan a buyer should receive. Sales with a product code that is not listed here fall back
              to the default plan set on the <Link to="/admin/plans">Plans</Link> page.
            </p>

            {rows.length === 0 ? <p className="meta" style={{ margin: 0 }}>No products mapped yet.</p> : null}

            <div className="stack">
              {rows.map((r, i) => (
                <div key={i} className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                  <Field label="Product code" hint="JVZoo product id, the cproditem field">
                    <input className="input mono" value={r.code} onChange={(e) => setRow(i, { code: e.target.value })} placeholder="123456" style={{ minWidth: 200 }} />
                  </Field>
                  <Field label="Plan">
                    <select className="select" value={r.planId} onChange={(e) => setRow(i, { planId: e.target.value })} style={{ minWidth: 240 }}>
                      <option value="">Choose a plan…</option>
                      {data.plans.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} — {p.durationMonths === 0 ? 'never expires' : `${p.durationMonths} months`}</option>
                      ))}
                    </select>
                  </Field>
                  <button type="button" className="btn danger-outline sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
            </div>

            <div>
              <button type="button" className="btn secondary sm" onClick={() => setRows((rs) => [...rs, { code: '', planId: '' }])}>
                <Icons.plus size={16} /> Add product
              </button>
            </div>
          </div>

          {formError ? <Alert kind="error">{formError}</Alert> : null}
          <div className="row">
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save JVZoo settings'}</button>
          </div>
        </form>
      ) : null}

      {stats ? (
        <div className="section grid-2" style={{ marginTop: 24 }}>
          <div className="card stat-tile"><span className="value">{stats.total}</span><span className="label">Notifications received</span></div>
          <div className="card stat-tile"><span className="value">{stats.processed}</span><span className="label">Processed</span></div>
          <div className="card stat-tile"><span className="value">{stats.errors}</span><span className="label">Errors</span></div>
          <div className="card stat-tile"><span className="value">{money(stats.revenue_cents / 100)}</span><span className="label">Revenue kept</span></div>
          <div className="card stat-tile"><span className="value">{money((stats.refunded_cents ?? 0) / 100)}</span><span className="label">Refunded ({stats.refunds ?? 0})</span></div>
        </div>
      ) : null}

      <div className="section">
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Payments log</h2>
          <button type="button" className="btn secondary sm" onClick={loadPayments} disabled={refreshing}>
            <Icons.refresh size={16} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {paymentsError ? <Alert kind="error">{paymentsError}</Alert> : null}
        {!payments && !paymentsError ? <Spinner /> : null}

        {payments ? (
          payments.length === 0 ? (
            <div className="card empty"><p>No notifications yet. Once JVZoo is connected, every sale appears here.</p></div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Customer</th>
                      <th>Product</th>
                      <th className="num">Amount</th>
                      <th>Granted</th>
                      <th>Result</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(p.createdAt)}</td>
                        <td><TypeChip type={p.type} /></td>
                        <td>
                          <div>
                            {p.userId
                              ? <Link to={`/admin/users/${p.userId}`}>{p.customerName || p.customerEmail || p.userEmail || 'View student'}</Link>
                              : (p.customerName || p.customerEmail || <span className="muted">—</span>)}
                          </div>
                          {p.customerEmail ? <div className="meta">{p.customerEmail}</div> : null}
                        </td>
                        <td>
                          <div>{p.productTitle || <span className="muted">—</span>}</div>
                          {p.productCode ? <div className="meta mono">{p.productCode}</div> : null}
                        </td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>{money(p.amountCents / 100)} {p.currency}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {p.reversedAt ? (
                            <span className="chip warning" title={`Reversed ${formatDateTime(p.reversedAt)}`}>
                              <Icons.refresh size={14} /> Reversed
                            </span>
                          ) : p.grantedUnlimited ? (
                            <span className="chip success">No expiry{p.grantedCourse ? ' + course' : ''}</span>
                          ) : p.monthsGranted > 0 ? (
                            <span className="chip">{p.monthsGranted} month{p.monthsGranted === 1 ? '' : 's'}{p.grantedCourse ? ' + course' : ''}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td><ResultChip result={p.result} /></td>
                        <td className="details" title={p.note ?? ''}>{p.note ? truncate(p.note, 60) : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
