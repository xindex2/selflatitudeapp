import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Field, Modal, Spinner, Toggle, useConfirm, useToast } from '../../components/ui';
import { AccessAlert, errMsg, isAccessError, money } from './adminShared';
import './admin.css';
import '../settings.css';

interface Plan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  durationMonths: number;
  grantsCourse: boolean;
  repliesPerPeriod: number | null;
  costCeilingUsd: number | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  userCount: number;
}

interface PlanForm {
  id: string;
  name: string;
  description: string;
  priceDollars: string;
  currency: string;
  durationMonths: string;
  grantsCourse: boolean;
  repliesPerPeriod: string;
  costCeilingUsd: string;
  isDefault: boolean;
  active: boolean;
  sortOrder: string;
}

const emptyForm = (): PlanForm => ({
  id: '',
  name: '',
  description: '',
  priceDollars: '',
  currency: 'USD',
  durationMonths: '12',
  grantsCourse: false,
  repliesPerPeriod: '',
  costCeilingUsd: '',
  isDefault: false,
  active: true,
  sortOrder: '0',
});

const toForm = (p: Plan): PlanForm => ({
  id: p.id,
  name: p.name,
  description: p.description ?? '',
  priceDollars: (p.priceCents / 100).toFixed(2),
  currency: p.currency || 'USD',
  durationMonths: String(p.durationMonths ?? 0),
  grantsCourse: !!p.grantsCourse,
  repliesPerPeriod: p.repliesPerPeriod === null || p.repliesPerPeriod === undefined ? '' : String(p.repliesPerPeriod),
  costCeilingUsd: p.costCeilingUsd === null || p.costCeilingUsd === undefined ? '' : String(p.costCeilingUsd),
  isDefault: !!p.isDefault,
  active: !!p.active,
  sortOrder: String(p.sortOrder ?? 0),
});

const optionalNumber = (s: string) => (s.trim() === '' ? null : Number(s));

function validate(f: PlanForm): string | null {
  if (!f.name.trim()) return 'Give the plan a name.';
  if (f.id.trim() && !/^[a-z0-9-]+$/.test(f.id.trim())) return 'The plan id may only contain lowercase letters, numbers and hyphens.';
  const price = Number(f.priceDollars);
  if (f.priceDollars.trim() === '' || Number.isNaN(price) || price < 0) return 'Enter a price of 0 or more.';
  const months = Number(f.durationMonths);
  if (!Number.isInteger(months) || months < 0) return 'Duration must be a whole number of months (0 for never expires).';
  for (const [label, value] of [['Included replies', f.repliesPerPeriod], ['Cost ceiling', f.costCeilingUsd]] as const) {
    if (value.trim() !== '' && (Number.isNaN(Number(value)) || Number(value) < 0)) return `${label} must be a non-negative number, or blank.`;
  }
  if (Number.isNaN(Number(f.sortOrder))) return 'Sort order must be a number.';
  return null;
}

const durationLabel = (months: number) => (months === 0 ? 'Never expires' : `${months} month${months === 1 ? '' : 's'}`);

export default function AdminPlans() {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ form: PlanForm; original: Plan | null } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ plans: Plan[] }>('/api/admin/plans');
      setPlans(r.plans);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) =>
    setEditing((s) => (s ? { ...s, form: { ...s.form, [k]: v } } : s));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const f = editing.form;
    const problem = validate(f);
    if (problem) { setFormError(problem); return; }
    setFormError(null);
    setSaving(true);
    const body = {
      name: f.name.trim(),
      description: f.description.trim(),
      priceCents: Math.round(Number(f.priceDollars) * 100),
      currency: (f.currency || 'USD').trim().toUpperCase(),
      durationMonths: Number(f.durationMonths),
      grantsCourse: f.grantsCourse,
      repliesPerPeriod: optionalNumber(f.repliesPerPeriod),
      costCeilingUsd: optionalNumber(f.costCeilingUsd),
      isDefault: f.isDefault,
      active: f.active,
      sortOrder: Number(f.sortOrder) || 0,
    };
    try {
      if (editing.original) {
        await api.put<{ plan: Plan }>(`/api/admin/plans/${encodeURIComponent(editing.original.id)}`, body);
      } else {
        await api.post<{ plan: Plan }>('/api/admin/plans', f.id.trim() ? { ...body, id: f.id.trim() } : body);
      }
      setEditing(null);
      await load();
      toast(editing.original ? 'Plan saved.' : 'Plan created.', 'success');
    } catch (err) {
      setFormError(errMsg(err, 'Could not save the plan.'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(plan: Plan) {
    const ok = await confirm(
      `Delete "${plan.name}"?`,
      'The plan is removed from the list of plans you can assign. Students already on it keep the access they were given.',
      { danger: true, confirmLabel: 'Delete plan' },
    );
    if (!ok) return;
    setPageError(null);
    try {
      await api.del(`/api/admin/plans/${encodeURIComponent(plan.id)}`);
      await load();
      toast('Plan deleted.');
    } catch (err) {
      setPageError(errMsg(err, 'Could not delete the plan.'));
    }
  }

  const f = editing?.form;

  return (
    <div className="page admin-page">
      {confirmEl}
      <div className="page-header">
        <div>
          <h1>Plans</h1>
          <p>
            A plan decides how long Companion access lasts and how much included usage a student gets. JVZoo product codes are
            matched to plans on the <Link to="/admin/jvzoo">JVZoo &amp; payments</Link> page.
          </p>
        </div>
        <button className="btn primary" onClick={() => { setFormError(null); setEditing({ form: emptyForm(), original: null }); }}>New plan</button>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load plans.')}</Alert>}</div>
      ) : null}
      {pageError ? <div className="section"><Alert kind="error">{pageError}</Alert></div> : null}
      {!plans && !error ? <Spinner /> : null}

      {plans ? (
        plans.length === 0 ? (
          <div className="card empty">
            <p>No plans yet. Create one to describe what a purchase gives a student.</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Price</th>
                    <th>Duration</th>
                    <th>Course access</th>
                    <th>Included replies</th>
                    <th>Cost ceiling</th>
                    <th className="num">Users</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <strong>{p.name}</strong>
                          {p.isDefault ? <span className="chip success">Default</span> : null}
                          {!p.active ? <span className="chip warning">Inactive</span> : null}
                        </div>
                        <div className="meta mono">{p.id}</div>
                        {p.description ? <div className="meta">{p.description}</div> : null}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{money(p.priceCents / 100)} {p.currency}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{durationLabel(p.durationMonths)}</td>
                      <td>{p.grantsCourse ? 'Yes' : 'No'}</td>
                      <td>{p.repliesPerPeriod ?? <span className="muted">Global setting</span>}</td>
                      <td>{p.costCeilingUsd === null || p.costCeilingUsd === undefined ? <span className="muted">Global setting</span> : money(p.costCeilingUsd)}</td>
                      <td className="num">{p.userCount}</td>
                      <td className="actions-cell">
                        <button className="btn secondary sm" onClick={() => { setFormError(null); setEditing({ form: toForm(p), original: p }); }}>Edit</button>
                        <button className="btn danger-outline sm" onClick={() => remove(p)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.original ? `Edit ${editing.original.name}` : 'New plan'}
        wide
        actions={
          <>
            <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" form="plan-form" disabled={saving}>{saving ? 'Saving…' : editing?.original ? 'Save plan' : 'Create plan'}</button>
          </>
        }
      >
        {f ? (
          <form id="plan-form" className="stack" onSubmit={save}>
            {formError ? <Alert kind="error">{formError}</Alert> : null}
            <div className="grid-2">
              <Field label="Name" hint="Shown to you and in emails, for example “Companion — 12 months”">
                <input className="input" value={f.name} onChange={(e) => setField('name', e.target.value)} required />
              </Field>
              <Field label="Plan id" hint={editing?.original ? 'The id cannot be changed after a plan is created.' : 'Optional. Left blank it is derived from the name. Lowercase letters, numbers and hyphens only.'}>
                <input className="input mono" value={f.id} onChange={(e) => setField('id', e.target.value)} disabled={!!editing?.original} placeholder="companion-12" />
              </Field>
            </div>

            <Field label="Description" hint="A short internal note about what this plan includes">
              <textarea className="textarea" value={f.description} onChange={(e) => setField('description', e.target.value)} style={{ minHeight: 70 }} />
            </Field>

            <div className="grid-3">
              <Field label="Price" hint="In dollars, for example 497.00">
                <input className="input" type="number" min={0} step="0.01" inputMode="decimal" value={f.priceDollars} onChange={(e) => setField('priceDollars', e.target.value)} required />
              </Field>
              <Field label="Currency" hint="Three-letter code">
                <input className="input" value={f.currency} onChange={(e) => setField('currency', e.target.value)} maxLength={3} />
              </Field>
              <Field label="Duration (months)" hint="How many months of Companion access a purchase grants. 0 means the access never expires.">
                <input className="input" type="number" min={0} step={1} value={f.durationMonths} onChange={(e) => setField('durationMonths', e.target.value)} required />
              </Field>
            </div>

            <div className="grid-2">
              <Field label="Included replies per period" hint="Leave blank to use the global usage limits">
                <input className="input" type="number" min={0} step={1} value={f.repliesPerPeriod} onChange={(e) => setField('repliesPerPeriod', e.target.value)} placeholder="Global setting" />
              </Field>
              <Field label="Cost ceiling (USD) per period" hint="Leave blank to use the global usage limits">
                <input className="input" type="number" min={0} step="0.01" value={f.costCeilingUsd} onChange={(e) => setField('costCeilingUsd', e.target.value)} placeholder="Global setting" />
              </Field>
            </div>

            <div className="stack">
              <Toggle checked={f.grantsCourse} onChange={(v) => setField('grantsCourse', v)} label="Grants course access" />
              <p className="meta" style={{ margin: '-4px 0 0 0' }}>Course access is granted for life; it is never taken away when Companion access ends.</p>
              <Toggle checked={f.isDefault} onChange={(v) => setField('isDefault', v)} label="Use as the default plan" />
              <p className="meta" style={{ margin: '-4px 0 0 0' }}>Sales that do not match a mapped product code fall back to the default plan.</p>
              <Toggle checked={f.active} onChange={(v) => setField('active', v)} label="Active" />
              <p className="meta" style={{ margin: '-4px 0 0 0' }}>Inactive plans stay on the students who have them but are not offered for new assignments.</p>
            </div>

            <Field label="Sort order" hint="Lower numbers appear first in lists">
              <input className="input" type="number" step={1} value={f.sortOrder} onChange={(e) => setField('sortOrder', e.target.value)} style={{ maxWidth: 160 }} />
            </Field>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
