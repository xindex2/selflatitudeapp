import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Spinner } from '../../components/ui';
import { errMsg, money } from './adminShared';
import './admin.css';

interface Overview {
  activeStudents: number;
  companionActive: number;
  suspended: number;
  conversations: number;
  replies30d: number;
  includedCost30d: number;
  indexedFiles: number;
  openPrivacyRequests: number;
}

function Tile({ label, value, link }: { label: string; value: string | number; link?: { to: string; label: string } }) {
  return (
    <div className="card stat-tile">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
      {link ? <Link to={link.to}>{link.label}</Link> : null}
    </div>
  );
}

export default function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);

  useEffect(() => {
    api.get<{ configured: boolean }>('/api/admin/openai/key').then((r) => setKeyOk(r.configured)).catch(() => setKeyOk(null));
    api.get<{ overview: Overview }>('/api/admin/overview')
      .then((r) => setData(r.overview))
      .catch((e) => setError(errMsg(e, 'Could not load the overview.')));
  }, []);

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>A snapshot of students, Companion activity, and open work.</p>
        </div>
      </div>

      {keyOk === false ? (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warning">The Companion is not connected to OpenAI yet, so students cannot get replies. <Link to="/admin/openai">Add the OpenAI API key</Link>.</Alert>
        </div>
      ) : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {!data && !error ? <Spinner /> : null}

      {data ? (
        <>
          <div className="section">
            <div className="grid-3">
              <Tile label="Active students" value={data.activeStudents} />
              <Tile label="Companion active" value={data.companionActive} />
              <Tile label="Suspended" value={data.suspended} />
              <Tile label="Conversations" value={data.conversations} />
              <Tile label="Replies (30 days)" value={data.replies30d} />
              <Tile label="Included cost (30 days)" value={money(data.includedCost30d)} />
              <Tile label="Indexed course files" value={data.indexedFiles} />
              <Tile
                label="Open privacy requests"
                value={data.openPrivacyRequests}
                link={{ to: '/admin/privacy-requests', label: 'Review requests' }}
              />
            </div>
          </div>

          <div className="section">
            <h2>Quick links</h2>
            <div className="quick-links">
              <Link className="btn secondary" to="/admin/companion">Edit Companion</Link>
              <Link className="btn secondary" to="/admin/users">Manage users</Link>
              <Link className="btn secondary" to="/admin/usage">Usage limits</Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
