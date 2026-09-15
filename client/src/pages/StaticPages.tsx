import { Link } from 'react-router-dom';
import { Logo } from '../components/ui';

/**
 * Placeholder legal pages. SelfLatitude will replace this copy after legal review
 * (the brief requires the owner, not the developer, to certify compliance).
 */
function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page narrow">
      <Link to="/" style={{ display: 'inline-block', marginBottom: 24 }}><Logo height={40} /></Link>
      <h1 style={{ marginBottom: 8 }}>{title}</h1>
      <p className="meta">Version 2026-01 · Placeholder text pending legal review.</p>
      <div className="card stack">{children}</div>
    </div>
  );
}

export function TermsPage() {
  return (
    <Doc title="Terms of Use">
      <p>The SelfLatitude Companion is provided to purchasers of the SelfLatitude Foundations course as an educational and personal-development tool.</p>
      <p>It is not a therapist, psychologist, doctor, diagnostic service, or emergency service, and it does not monitor you or dispatch help. If you are in crisis, contact local emergency services or a crisis line.</p>
      <p>Your purchase includes lifetime access to the course and twelve months of Companion access, which may be renewed annually. Companion access may be suspended for misuse.</p>
      <p>Included AI usage is subject to a monthly allowance. You may optionally connect your own OpenAI API key, which is used only with your explicit confirmation and is subject to OpenAI's terms.</p>
    </Doc>
  );
}

export function PrivacyNoticePage() {
  return (
    <Doc title="Privacy Notice">
      <p><strong>What we store.</strong> Your account details, membership dates, conversations, approved memories, journal entries, usage records, consent records, and (encrypted) any OpenAI API key you choose to add.</p>
      <p><strong>How the Companion uses your data.</strong> Messages you send, relevant approved memories (when the per-chat toggle is on), and any journal entry you explicitly attach are sent to OpenAI to generate a reply. OpenAI does not use API data to train its models. Journal entries are never sent automatically.</p>
      <p><strong>Who can see it.</strong> Administrators can see your name, email, membership and usage counts, and audit records. They cannot routinely read your conversations, memories, or journal. Any temporary support access is limited and recorded.</p>
      <p><strong>Your rights.</strong> You can access, correct, export, and delete your information at any time from Privacy &amp; data, withdraw consent for memory, and submit a privacy request. We respond within 30 days. EU residents have rights under the GDPR.</p>
      <p><strong>Retention.</strong> Data is kept while your account exists. Deleting your account permanently removes your conversations, memories, journal, usage, and API key.</p>
    </Doc>
  );
}
