import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { SupportInfo } from '../api/types';
import { useAuth } from '../lib/auth';
import { Alert, Icons, Spinner, useToast } from '../components/ui';
import './profile.css';

const FAQS: { q: string; a: JSX.Element }[] = [
  {
    q: 'What is the Companion, and what is it not?',
    a: (
      <>
        <p>It is a private guide for applying the SelfLatitude Foundations course to your own life. It answers questions about the course, helps you think through real situations, and points you to the module a suggestion came from.</p>
        <p>It is not therapy, medical care, diagnosis, or an emergency service, and it cannot contact anyone on your behalf.</p>
      </>
    ),
  },
  {
    q: 'How many replies do I get each month?',
    a: (
      <>
        <p>Your membership includes a set number of completed replies each month. You can see how many are left, and the date they reset, on your <Link to="/profile">Profile</Link> and in <Link to="/settings#usage">Settings</Link>.</p>
        <p>Unused replies do not carry over. Replies that fail never count against your allowance.</p>
      </>
    ),
  },
  {
    q: 'What happens when I run out?',
    a: (
      <>
        <p>You can wait for the next reset, or connect your own OpenAI API key in <Link to="/settings#usage">Settings</Link> to keep going for the rest of the month. Nothing is charged to your key until you confirm the switch, and your conversations are unaffected either way.</p>
      </>
    ),
  },
  {
    q: 'Who can read my conversations and journal?',
    a: (
      <>
        <p>Only you. Administrators can see your name, email, membership dates, and usage counts, but not the content of your conversations, memories, or journal entries.</p>
        <p>Journal entries are never sent to the Companion unless you choose "Discuss with Companion" on an entry.</p>
      </>
    ),
  },
  {
    q: 'How does memory work?',
    a: (
      <>
        <p>Each conversation has a toggle for remembering across chats. When it is on, the Companion may suggest something worth remembering. Nothing is saved until you approve it, and you can edit or delete anything in <Link to="/memory">Memory</Link> at any time.</p>
        <p>Temporary chats never use or create memories, and are not saved to your history.</p>
      </>
    ),
  },
  {
    q: 'Can I get my information out, or delete it?',
    a: (
      <>
        <p>Yes. <Link to="/privacy">Privacy &amp; data</Link> lets you download your conversations and journal, export everything as a structured file, delete individual records, and permanently close your account.</p>
      </>
    ),
  },
  {
    q: 'I forgot my password.',
    a: <p>Use "Forgot your password" on the sign-in page. If the reset email does not arrive, check your spam folder, then contact support at the address above.</p>,
  },
];

/** Help and support. Contact details are set by SelfLatitude in the admin area. */
export default function HelpPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [support, setSupport] = useState<SupportInfo | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get<{ support: SupportInfo }>('/api/profile/support').then((r) => setSupport(r.support)).catch(() => setError(true));
  }, []);

  const subject = encodeURIComponent('SelfLatitude Companion support');
  const body = encodeURIComponent(
    `\n\n---\nAccount: ${user?.email ?? ''}\nPlease describe what happened and what you expected.`,
  );

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Help</h1>
          <p>Answers to common questions, and how to reach a person.</p>
        </div>
      </div>

      {!support && !error ? <Spinner /> : null}

      {support ? (
        <>
          <section className="section">
            <div className="card settings-card help-card">
              <h2>Contact support</h2>
              <p className="small" style={{ margin: 0 }}>
                Email us with what happened and what you expected. We usually reply {support.responseTime}.
              </p>
              <div className="contact">
                <a href={`mailto:${support.email}?subject=${subject}&body=${body}`}>{support.email}</a>
                <button
                  className="btn secondary sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(support.email);
                      toast('Email address copied.', 'success');
                    } catch {
                      toast('Could not copy. Select the address instead.', 'error');
                    }
                  }}
                >
                  <Icons.copy size={16} /> Copy address
                </button>
                {support.helpUrl ? (
                  <a className="btn ghost sm" href={support.helpUrl} target="_blank" rel="noopener">Help centre</a>
                ) : null}
              </div>
              {user ? <p className="meta" style={{ margin: 0 }}>Mention the email on your account, {user.email}, so we can find you.</p> : null}
            </div>
          </section>

          <section className="section">
            <Alert kind="warning">{support.crisisNote}</Alert>
          </section>
        </>
      ) : null}

      {error ? <Alert kind="error">Could not load the support details. Please try again.</Alert> : null}

      <section className="section">
        <h2>Common questions</h2>
        <div className="card faq" style={{ padding: '0 16px' }}>
          {FAQS.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <div className="answer">{f.a}</div>
            </details>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Useful pages</h2>
        <div className="card">
          <div className="kv">
            <div className="kv-row"><span className="k">Your plan and credits</span><span className="v"><Link to="/profile">Profile</Link></span></div>
            <div className="kv-row"><span className="k">Usage, API key, two-step verification</span><span className="v"><Link to="/settings">Settings</Link></span></div>
            <div className="kv-row"><span className="k">What the Companion remembers</span><span className="v"><Link to="/memory">Memory</Link></span></div>
            <div className="kv-row"><span className="k">Export or delete your information</span><span className="v"><Link to="/privacy">Privacy &amp; data</Link></span></div>
            <div className="kv-row"><span className="k">Terms and Privacy Notice</span><span className="v"><Link to="/terms">Terms</Link> · <Link to="/privacy-notice">Privacy Notice</Link></span></div>
          </div>
        </div>
      </section>
    </div>
  );
}
