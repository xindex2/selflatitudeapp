import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Alert, Icons, Spinner, formatDateTime } from '../../components/ui';
import { AccessAlert, errMsg, isAccessError } from './adminShared';
import './admin.css';

interface AuditEntry {
  id: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: unknown;
  ip: string | null;
  created_at: string;
}

const PAGE_SIZE = 100;

function detailsText(d: unknown) {
  if (d == null || d === '') return '';
  if (typeof d === 'string') {
    try { return JSON.stringify(JSON.parse(d)); } catch { return d; }
  }
  try { return JSON.stringify(d); } catch { return String(d); }
}

export default function AdminAudit() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    api.get<{ entries: AuditEntry[] }>(`/api/admin/audit?${params.toString()}`)
      .then((r) => { if (!cancelled) { setEntries(r.entries); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [q, page]);

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Audit history</h1>
          <p>Administrative actions, sign-ins, and security events.</p>
        </div>
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load the audit log.')}</Alert>}</div>
      ) : null}

      {!isAccessError(error) ? (
        <>
          <div className="toolbar">
            <input className="input" type="search" placeholder="Search actor, action, or target" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search audit log" style={{ minWidth: 280 }} />
            {loading ? <Spinner /> : null}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Details</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {entries?.map((e) => {
                    const d = detailsText(e.details);
                    return (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.created_at)}</td>
                        <td>{e.actor_email || <span className="muted">system</span>}</td>
                        <td className="mono">{e.action}</td>
                        <td className="mono">{e.target_type ? `${e.target_type}${e.target_id ? ` · ${e.target_id}` : ''}` : <span className="muted">—</span>}</td>
                        <td className="details mono muted" title={d}>{d}</td>
                        <td className="mono">{e.ip || ''}</td>
                      </tr>
                    );
                  })}
                  {entries && entries.length === 0 ? (
                    <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No entries.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="pager">
            <span className="meta">Page {page}{entries ? ` · ${entries.length} entries` : ''}</span>
            <div className="row">
              <button className="btn secondary sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}><Icons.chevronLeft size={16} /> Prev</button>
              <button className="btn secondary sm" disabled={loading || !entries || entries.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>Next <Icons.chevronRight size={16} /></button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
