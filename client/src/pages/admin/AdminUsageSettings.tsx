import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { UsageSettings } from '../../api/types';
import { Alert, Field, Spinner, useToast } from '../../components/ui';
import { errMsg } from './adminShared';
import './admin.css';

type Form = Record<keyof Omit<UsageSettings, 'warnAtReplies'>, string> & { warnAtReplies: [string, string, string] };

function toForm(u: UsageSettings): Form {
  const w = u.warnAtReplies ?? [];
  return {
    repliesPerPeriod: String(u.repliesPerPeriod ?? ''),
    costCeilingUsd: String(u.costCeilingUsd ?? ''),
    warnAtReplies: [String(w[0] ?? ''), String(w[1] ?? ''), String(w[2] ?? '')],
    warnAtCostFraction: String(u.warnAtCostFraction ?? ''),
    reserveEstimateUsd: String(u.reserveEstimateUsd ?? ''),
    maxContextMessages: String(u.maxContextMessages ?? ''),
    retrievalPassages: String(u.retrievalPassages ?? ''),
    memoryPassages: String(u.memoryPassages ?? ''),
    privacyRequestDays: String(u.privacyRequestDays ?? ''),
  };
}

function fromForm(f: Form): UsageSettings {
  const n = (s: string) => Number(s);
  return {
    repliesPerPeriod: n(f.repliesPerPeriod),
    costCeilingUsd: n(f.costCeilingUsd),
    warnAtReplies: f.warnAtReplies.filter((s) => s.trim() !== '').map(n),
    warnAtCostFraction: n(f.warnAtCostFraction),
    reserveEstimateUsd: n(f.reserveEstimateUsd),
    maxContextMessages: n(f.maxContextMessages),
    retrievalPassages: n(f.retrievalPassages),
    memoryPassages: n(f.memoryPassages),
    privacyRequestDays: n(f.privacyRequestDays),
  };
}

function validate(f: Form): string | null {
  const numeric: (keyof Omit<Form, 'warnAtReplies'>)[] = [
    'repliesPerPeriod', 'costCeilingUsd', 'warnAtCostFraction', 'reserveEstimateUsd', 'maxContextMessages', 'retrievalPassages', 'memoryPassages', 'privacyRequestDays',
  ];
  for (const k of numeric) {
    if (f[k].trim() === '' || Number.isNaN(Number(f[k])) || Number(f[k]) < 0) return `Enter a valid non-negative number for ${k}.`;
  }
  for (const w of f.warnAtReplies) if (w.trim() !== '' && (Number.isNaN(Number(w)) || Number(w) < 0)) return 'Warning thresholds must be non-negative numbers.';
  const frac = Number(f.warnAtCostFraction);
  if (frac < 0 || frac > 1) return 'The cost warning fraction must be between 0 and 1.';
  return null;
}

export default function AdminUsageSettings() {
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [defaults, setDefaults] = useState<UsageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ usage: UsageSettings; defaults: UsageSettings }>('/api/admin/settings/usage')
      .then((r) => { setForm(toForm(r.usage)); setDefaults(r.defaults); })
      .catch((e) => setError(errMsg(e, 'Could not load usage settings.')));
  }, []);

  const set = (k: keyof Omit<Form, 'warnAtReplies'>, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setWarn = (i: number, v: string) =>
    setForm((f) => {
      if (!f) return f;
      const w = [...f.warnAtReplies] as Form['warnAtReplies'];
      w[i] = v;
      return { ...f, warnAtReplies: w };
    });

  const save = async () => {
    if (!form) return;
    const v = validate(form);
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const r = await api.put<{ usage: UsageSettings }>('/api/admin/settings/usage', fromForm(form));
      setForm(toForm(r.usage));
      toast('Usage settings saved.', 'success');
    } catch (e) {
      setError(errMsg(e, 'Could not save usage settings.'));
    } finally {
      setSaving(false);
    }
  };

  const num = (k: keyof Omit<Form, 'warnAtReplies'>, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input className="input" type="number" inputMode="decimal" value={form?.[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...extra} />
  );

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Usage limits</h1>
          <p>Included usage for every student per monthly period. Per-user overrides live on each user's page.</p>
        </div>
      </div>

      {error ? <div className="section"><Alert kind="error">{error}</Alert></div> : null}
      {!form && !error ? <Spinner /> : null}

      {form ? (
        <form
          onSubmit={(e) => { e.preventDefault(); save(); }}
          className="stack"
        >
          <div className="card">
            <h2>Included usage</h2>
            <div className="grid-2">
              <Field label="Replies per period" hint="Included completed replies per monthly period, default 250">
                {num('repliesPerPeriod', { min: 0, step: 1 })}
              </Field>
              <Field label="Cost ceiling (USD)" hint="Maximum measured API cost per period, default $5">
                {num('costCeilingUsd', { min: 0, step: 0.01 })}
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Warnings</h2>
            <div className="grid-3">
              <Field label="First warning (replies remaining)" hint="Show a gentle notice when this many replies remain">
                <input className="input" type="number" min={0} step={1} value={form.warnAtReplies[0]} onChange={(e) => setWarn(0, e.target.value)} />
              </Field>
              <Field label="Second warning" hint="Show a stronger notice at this threshold">
                <input className="input" type="number" min={0} step={1} value={form.warnAtReplies[1]} onChange={(e) => setWarn(1, e.target.value)} />
              </Field>
              <Field label="Third warning" hint="Final warning before included usage is exhausted">
                <input className="input" type="number" min={0} step={1} value={form.warnAtReplies[2]} onChange={(e) => setWarn(2, e.target.value)} />
              </Field>
            </div>
            <div className="grid-2" style={{ marginTop: 16 }}>
              <Field label="Cost warning fraction (0-1)" hint="Warn when this fraction of the cost ceiling is used">
                {num('warnAtCostFraction', { min: 0, max: 1, step: 0.01 })}
              </Field>
              <Field label="Reserve estimate (USD)" hint="Estimated cost reserved per request before completion so simultaneous requests cannot exceed the ceiling">
                {num('reserveEstimateUsd', { min: 0, step: 0.001 })}
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Context and retrieval</h2>
            <div className="grid-3">
              <Field label="Max context messages" hint="Recent messages sent to the model with each reply">
                {num('maxContextMessages', { min: 0, step: 1 })}
              </Field>
              <Field label="Retrieval passages" hint="Course passages retrieved per reply">
                {num('retrievalPassages', { min: 0, step: 1 })}
              </Field>
              <Field label="Memory passages" hint="Approved memories included per reply">
                {num('memoryPassages', { min: 0, step: 1 })}
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Privacy</h2>
            <div className="grid-2">
              <Field label="Privacy request response days" hint="Days allowed to answer a privacy request; sets the due date shown in Privacy requests">
                {num('privacyRequestDays', { min: 0, step: 1 })}
              </Field>
            </div>
          </div>

          <div className="row between wrap">
            <button type="button" className="btn secondary" disabled={!defaults} onClick={() => defaults && setForm(toForm(defaults))}>
              Reset to defaults
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? <Spinner /> : null} Save settings
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
