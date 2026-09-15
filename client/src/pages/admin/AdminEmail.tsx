import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { Alert, Field, Icons, Spinner, Tabs, Toggle, useToast } from '../../components/ui';
import type { SupportInfo } from '../../api/types';
import { AccessAlert, errMsg, isAccessError } from './adminShared';
import './admin.css';
import '../settings.css';

interface EmailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  replyTo: string;
  hasPassword: boolean;
}
type TemplateKey = 'welcome' | 'renewal' | 'passwordReset' | 'loginCode' | 'invite';
interface Template { subject: string; body: string }
type Templates = Record<TemplateKey, Template>;

interface EmailResponse {
  configured: boolean;
  source: 'settings' | 'env' | null;
  settings: EmailSettings;
  env: { host: string; port: number; from: string } | null;
  templates: Templates;
  defaults: Templates;
}

const TEMPLATE_LIST: { id: TemplateKey; label: string; note: string }[] = [
  { id: 'welcome', label: 'Welcome', note: 'Sent when a purchase creates a new paying student’s account.' },
  { id: 'renewal', label: 'Renewal', note: 'Sent when an existing student’s Companion access is extended.' },
  { id: 'passwordReset', label: 'Password reset', note: 'Sent when someone asks to reset their password.' },
  { id: 'loginCode', label: 'Sign-in code', note: 'Sent when a one-time code is needed to sign in.' },
  { id: 'invite', label: 'Invite', note: 'Sent when an administrator creates an account by hand.' },
];

const PLACEHOLDERS = ['{{name}}', '{{email}}', '{{password}}', '{{loginUrl}}', '{{link}}', '{{code}}', '{{planName}}', '{{companionEnd}}', '{{appName}}', '{{minutes}}'];

interface ServerForm { host: string; port: string; secure: boolean; user: string; password: string; from: string; replyTo: string }

const toServerForm = (s: EmailSettings): ServerForm => ({
  host: s.host ?? '',
  port: String(s.port ?? 587),
  secure: !!s.secure,
  user: s.user ?? '',
  password: '',
  from: s.from ?? '',
  replyTo: s.replyTo ?? '',
});

export default function AdminEmail() {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'server' | 'templates' | 'support'>('server');
  const [support, setSupport] = useState<SupportInfo | null>(null);
  const [supportSaved, setSupportSaved] = useState<SupportInfo | null>(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [data, setData] = useState<EmailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [form, setForm] = useState<ServerForm | null>(null);
  const [savedForm, setSavedForm] = useState<ServerForm | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savingServer, setSavingServer] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [templates, setTemplates] = useState<Templates | null>(null);
  const [savedTemplates, setSavedTemplates] = useState<string>('');
  const [selected, setSelected] = useState<TemplateKey>('welcome');
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [savingTemplates, setSavingTemplates] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get<EmailResponse>('/api/admin/settings/email')
      .then((r) => {
        setData(r);
        const f = toServerForm(r.settings);
        setForm(f);
        setSavedForm(f);
        setTemplates(r.templates);
        setSavedTemplates(JSON.stringify(r.templates));
      })
      .catch(setError);
  }, []);

  useEffect(() => { if (user?.email && !testTo) setTestTo(user.email); }, [user?.email]);

  // Support details shown on the student Help page
  useEffect(() => {
    api.get<{ support: SupportInfo }>('/api/admin/settings/support')
      .then((r) => { setSupport(r.support); setSupportSaved(r.support); })
      .catch((e) => setSupportError(errMsg(e, 'Could not load the support details.')));
  }, []);

  const supportDirty = !!support && !!supportSaved && JSON.stringify(support) !== JSON.stringify(supportSaved);

  async function saveSupport() {
    if (!support) return;
    setSupportBusy(true);
    setSupportError(null);
    try {
      const r = await api.put<{ support: SupportInfo }>('/api/admin/settings/support', support);
      setSupport(r.support);
      setSupportSaved(r.support);
      toast('Support details saved.', 'success');
    } catch (e) {
      setSupportError(errMsg(e, 'Could not save the support details.'));
    } finally {
      setSupportBusy(false);
    }
  }

  const set = <K extends keyof ServerForm>(k: K, v: ServerForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const serverDirty = !!form && !!savedForm && JSON.stringify(form) !== JSON.stringify(savedForm);
  const templatesDirty = !!templates && JSON.stringify(templates) !== savedTemplates;

  async function saveServer(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setServerError(null);
    setSavingServer(true);
    const body: Record<string, unknown> = {
      host: form.host.trim(),
      port: Number(form.port) || 0,
      secure: form.secure,
      user: form.user.trim(),
      from: form.from.trim(),
      replyTo: form.replyTo.trim(),
    };
    if (form.password) body.password = form.password;
    try {
      await api.put('/api/admin/settings/email', body);
      const r = await api.get<EmailResponse>('/api/admin/settings/email');
      setData(r);
      const f = toServerForm(r.settings);
      setForm(f);
      setSavedForm(f);
      setTestResult(null);
      toast('Email server settings saved.', 'success');
    } catch (err) {
      setServerError(errMsg(err, 'Could not save the email server settings.'));
    } finally {
      setSavingServer(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.post<{ ok: boolean; error?: string }>('/api/admin/settings/email/test', { to: testTo.trim() }));
    } catch (err) {
      setTestResult({ ok: false, error: errMsg(err, 'The test email could not be sent.') });
    } finally {
      setTesting(false);
    }
  }

  const setTemplate = (patch: Partial<Template>) =>
    setTemplates((t) => (t ? { ...t, [selected]: { ...t[selected], ...patch } } : t));

  function insertPlaceholder(ph: string) {
    const el = bodyRef.current;
    if (!el || !templates) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + ph + el.value.slice(end);
    setTemplate({ body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + ph.length, start + ph.length);
    });
  }

  async function saveTemplates() {
    if (!templates) return;
    setTemplatesError(null);
    setSavingTemplates(true);
    try {
      const r = await api.put<{ templates: Templates }>('/api/admin/settings/email/templates', templates);
      setTemplates(r.templates);
      setSavedTemplates(JSON.stringify(r.templates));
      toast('Email templates saved.', 'success');
    } catch (err) {
      setTemplatesError(errMsg(err, 'Could not save the templates.'));
    } finally {
      setSavingTemplates(false);
    }
  }

  const current = templates?.[selected];
  const meta = TEMPLATE_LIST.find((t) => t.id === selected)!;

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Email</h1>
          <p>The mailbox SelfLatitude sends from, and the wording of every message students receive.</p>
        </div>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load the email settings.')}</Alert>}</div>
      ) : null}
      {!data && !error ? <Spinner /> : null}

      {data && form && templates ? (
        <>
          <Tabs
            tabs={[
              { id: 'server' as const, label: 'Server' },
              { id: 'templates' as const, label: 'Templates' },
              { id: 'support' as const, label: 'Support details' },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'server' ? (
            <div className="tab-body">
              {data.configured ? (
                <Alert kind="success">
                  Outgoing email is working, sent from {data.settings.from || data.env?.from || 'the configured address'}.
                  {data.source === 'env' ? ' These settings come from the server environment, not from this page. Saving here replaces them.' : ''}
                </Alert>
              ) : (
                <Alert kind="warning">
                  Outgoing email is not configured. Password resets, sign-in codes and welcome emails will not be delivered until an SMTP server is saved below.
                </Alert>
              )}

              <form className="card settings-card stack" onSubmit={saveServer}>
                <div className="row between wrap">
                  <h2 style={{ margin: 0 }}>SMTP server</h2>
                  {serverDirty ? <span className="save-status dirty">Unsaved changes</span> : null}
                </div>
                <div className="grid-2">
                  <Field label="Host" hint="For example smtp.postmarkapp.com">
                    <input className="input" value={form.host} onChange={(e) => set('host', e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Port" hint="587 for STARTTLS, 465 for TLS on connect">
                    <input className="input" type="number" min={1} max={65535} step={1} value={form.port} onChange={(e) => set('port', e.target.value)} />
                  </Field>
                </div>
                <Toggle checked={form.secure} onChange={(v) => set('secure', v)} label="Use TLS on connect (port 465)" />
                <div className="grid-2">
                  <Field label="Username">
                    <input className="input" value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Password" hint={data.settings.hasPassword ? 'A password is already saved. It is never shown again.' : 'Stored encrypted and never shown again.'}>
                    <div className="input-with-btn">
                      <input
                        className="input mono"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        spellCheck={false}
                        value={form.password}
                        onChange={(e) => set('password', e.target.value)}
                        placeholder={data.settings.hasPassword ? 'Leave blank to keep the saved password' : ''}
                      />
                      <button type="button" className="btn icon ghost" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((s) => !s)}>
                        {showPassword ? <Icons.eyeOff /> : <Icons.eye />}
                      </button>
                    </div>
                  </Field>
                </div>
                <div className="grid-2">
                  <Field label="From address" hint="The name and address students see as the sender">
                    <input className="input" value={form.from} onChange={(e) => set('from', e.target.value)} placeholder="SelfLatitude Companion <no-reply@selflatitude.com>" />
                  </Field>
                  <Field label="Reply-to address" hint="Where replies from students should go. Optional.">
                    <input className="input" type="email" value={form.replyTo} onChange={(e) => set('replyTo', e.target.value)} placeholder="support@selflatitude.com" />
                  </Field>
                </div>
                {serverError ? <Alert kind="error">{serverError}</Alert> : null}
                <div className="row wrap">
                  <button type="submit" className="btn primary" disabled={savingServer}>{savingServer ? 'Saving…' : 'Save email settings'}</button>
                  {serverDirty ? <button type="button" className="btn secondary" onClick={() => savedForm && setForm(savedForm)}>Discard changes</button> : null}
                </div>
              </form>

              <div className="card settings-card stack">
                <h2 style={{ margin: 0 }}>Send a test email</h2>
                <p className="meta" style={{ margin: 0 }}>Uses the saved settings, so save any changes first.</p>
                <Field label="Send to">
                  <div className="row wrap">
                    <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} style={{ maxWidth: 360 }} />
                    <button type="button" className="btn secondary" onClick={sendTest} disabled={testing || !testTo.trim()}>
                      {testing ? 'Sending…' : 'Send test email'}
                    </button>
                  </div>
                </Field>
                {testResult ? (
                  testResult.ok
                    ? <Alert kind="success">Test email sent to {testTo}. Check the inbox, and the spam folder if it does not arrive.</Alert>
                    : <Alert kind="error">{testResult.error || 'The test email could not be sent.'}</Alert>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === 'templates' && current ? (
            <div className="tab-body">
              <div className="row between wrap">
                <div className="segmented" role="group" aria-label="Choose a template">
                  {TEMPLATE_LIST.map((t) => (
                    <button key={t.id} type="button" aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}>{t.label}</button>
                  ))}
                </div>
                {templatesDirty ? <span className="save-status dirty">Unsaved changes</span> : null}
              </div>

              <div className="card settings-card stack">
                <p className="meta" style={{ margin: 0 }}>{meta.note}</p>
                <Field label="Subject">
                  <input className="input" value={current.subject} onChange={(e) => setTemplate({ subject: e.target.value })} />
                </Field>
                <Field label="Body">
                  <textarea
                    ref={bodyRef}
                    className="textarea code"
                    style={{ minHeight: 320 }}
                    value={current.body}
                    onChange={(e) => setTemplate({ body: e.target.value })}
                  />
                </Field>

                <div>
                  <div className="meta" style={{ marginBottom: 6 }}>Placeholders — click one to insert it where the cursor is.</div>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {PLACEHOLDERS.map((ph) => (
                      <button key={ph} type="button" className="btn secondary sm mono" onClick={() => insertPlaceholder(ph)}>{ph}</button>
                    ))}
                  </div>
                </div>

                {templatesError ? <Alert kind="error">{templatesError}</Alert> : null}

                <div className="row between wrap">
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setTemplates((t) => (t && data ? { ...t, [selected]: { ...data.defaults[selected] } } : t))}
                  >
                    Reset this template to default
                  </button>
                  <button type="button" className="btn primary" onClick={saveTemplates} disabled={savingTemplates}>
                    {savingTemplates ? 'Saving…' : 'Save templates'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'support' ? (
            <div className="tab-body">
              <div className="card settings-card">
                <div className="card-title">
                  <h3><Icons.info size={18} /> Support details</h3>
                  {supportDirty ? <span className="chip warning">Unsaved changes</span> : null}
                </div>
                <p className="meta" style={{ margin: 0 }}>
                  These appear on the student Help page at <span className="mono">/help</span>.
                </p>
                {supportError ? <Alert kind="error">{supportError}</Alert> : null}
                {support ? (
                  <>
                    <div className="settings-form">
                      <Field label="Support email" hint="Where students are told to write. Make sure somebody reads it.">
                        <input className="input" type="email" value={support.email} onChange={(e) => setSupport({ ...support, email: e.target.value })} />
                      </Field>
                      <Field label="Expected response time" hint='Completes the sentence "We usually reply ...".'>
                        <input className="input" value={support.responseTime} onChange={(e) => setSupport({ ...support, responseTime: e.target.value })} placeholder="within 2 business days" />
                      </Field>
                      <Field label="Help centre link (optional)">
                        <input className="input" value={support.helpUrl} onChange={(e) => setSupport({ ...support, helpUrl: e.target.value })} placeholder="https://selflatitude.com/help" />
                      </Field>
                      <Field label="Safety notice" hint="Shown prominently on the Help page. Keep the non-clinical wording.">
                        <textarea className="textarea" rows={5} value={support.crisisNote} onChange={(e) => setSupport({ ...support, crisisNote: e.target.value })} />
                      </Field>
                    </div>
                    <div className="settings-actions">
                      <button className="btn primary" onClick={saveSupport} disabled={supportBusy || !supportDirty}>
                        {supportBusy ? <Spinner /> : null} Save support details
                      </button>
                    </div>
                  </>
                ) : !supportError ? <Spinner /> : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
