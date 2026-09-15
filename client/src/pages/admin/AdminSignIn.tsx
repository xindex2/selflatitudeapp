import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Field, Spinner, Toggle, useToast } from '../../components/ui';
import { AccessAlert, errMsg, isAccessError } from './adminShared';
import './admin.css';
import '../settings.css';

interface AuthPolicy {
  allowSelfRegistration: boolean;
  selfRegistrationMonths: number;
  requireEmailCodeForAll: boolean;
  requireMfaForAdmins: boolean;
  emailCodeMinutes: number;
}

export default function AdminSignIn() {
  const toast = useToast();
  const [auth, setAuth] = useState<AuthPolicy | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ auth: AuthPolicy }>('/api/admin/settings/auth')
      .then((r) => { setAuth(r.auth); setSaved(JSON.stringify(r.auth)); })
      .catch(setError);
  }, []);

  const set = <K extends keyof AuthPolicy>(k: K, v: AuthPolicy[K]) => setAuth((a) => (a ? { ...a, [k]: v } : a));
  const dirty = !!auth && JSON.stringify(auth) !== saved;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!auth) return;
    const minutes = Number(auth.emailCodeMinutes);
    if (!Number.isFinite(minutes) || minutes < 2 || minutes > 60) {
      setSaveError('The sign-in code must stay valid for between 2 and 60 minutes.');
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const r = await api.put<{ auth: AuthPolicy }>('/api/admin/settings/auth', {
        allowSelfRegistration: auth.allowSelfRegistration,
        selfRegistrationMonths: Number(auth.selfRegistrationMonths) || 0,
        requireEmailCodeForAll: auth.requireEmailCodeForAll,
        requireMfaForAdmins: auth.requireMfaForAdmins,
        emailCodeMinutes: minutes,
      });
      setAuth(r.auth);
      setSaved(JSON.stringify(r.auth));
      toast('Sign-in policy saved.', 'success');
    } catch (err) {
      setSaveError(errMsg(err, 'Could not save the sign-in policy.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Sign-in policy</h1>
          <p>Who can create an account, and what everyone has to do to sign in.</p>
        </div>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load the sign-in policy.')}</Alert>}</div>
      ) : null}
      {!auth && !error ? <Spinner /> : null}

      {auth ? (
        <form className="stack" onSubmit={save} style={{ maxWidth: 720 }}>
          <div className="card settings-card stack">
            <h2 style={{ margin: 0 }}>New accounts</h2>
            <Toggle checked={auth.allowSelfRegistration} onChange={(v) => set('allowSelfRegistration', v)} label="Allow people to sign themselves up" />
            <p className="meta" style={{ margin: '-4px 0 0 0' }}>
              Show the public sign-up page. Off means accounts are only created by a purchase or by an administrator.
            </p>

            {auth.allowSelfRegistration ? (
              <Field
                label="Companion months for a self-created account"
                hint="Companion months a self-created account receives. 0 means they can sign in but have no Companion access until you grant it."
              >
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={auth.selfRegistrationMonths}
                  onChange={(e) => set('selfRegistrationMonths', Number(e.target.value))}
                  style={{ maxWidth: 160 }}
                />
              </Field>
            ) : null}
          </div>

          <div className="card settings-card stack">
            <h2 style={{ margin: 0 }}>Signing in</h2>
            <Toggle checked={auth.requireEmailCodeForAll} onChange={(v) => set('requireEmailCodeForAll', v)} label="Require an emailed code for every student" />
            <p className="meta" style={{ margin: '-4px 0 0 0' }}>Every student must enter a code emailed to them at each sign-in.</p>

            {auth.requireEmailCodeForAll ? (
              <Alert kind="warning">
                Outgoing email must be working or nobody will be able to sign in.
                <div style={{ marginTop: 6 }}><Link to="/admin/email">Check the email settings</Link></div>
              </Alert>
            ) : null}

            <Toggle checked={auth.requireMfaForAdmins} onChange={(v) => set('requireMfaForAdmins', v)} label="Require two-step verification for administrators" />
            <p className="meta" style={{ margin: '-4px 0 0 0' }}>
              Owner and Super Admin accounts must complete a second step before they can reach the Super Admin sections.
              This can only be turned off on a local development machine; a live site always requires it. Turning it off
              does not remove a factor an administrator has already set up for themselves.
            </p>
            {!auth.requireMfaForAdmins ? (
              <Alert kind="warning">
                Administrators can reach the Super Admin sections with a password alone. Only leave this off while
                developing locally.
              </Alert>
            ) : null}

            <Field label="Sign-in code valid for (minutes)" hint="Between 2 and 60 minutes. Shorter is safer; longer is kinder to slow inboxes.">
              <input
                className="input"
                type="number"
                min={2}
                max={60}
                step={1}
                value={auth.emailCodeMinutes}
                onChange={(e) => set('emailCodeMinutes', Number(e.target.value))}
                style={{ maxWidth: 160 }}
              />
            </Field>
          </div>

          {saveError ? <Alert kind="error">{saveError}</Alert> : null}

          <div className="row between wrap">
            <span className={`save-status ${dirty ? 'dirty' : ''}`.trim()}>{dirty ? 'Unsaved changes' : ''}</span>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save sign-in policy'}</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
