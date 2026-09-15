import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Field, Modal, Spinner, Toggle, formatDate, formatDateTime, useToast } from '../../components/ui';
import { AccessAlert, errMsg, isAccessError } from './adminShared';
import './admin.css';

type Status = 'open' | 'in_progress' | 'closed';
interface PrivacyRequest {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  kind: string;
  message: string | null;
  status: Status;
  due_at: string | null;
  admin_note: string | null;
  created_at: string;
}

const kindLabel: Record<string, string> = {
  access: 'Access',
  correction: 'Correction',
  portability: 'Portability',
  deletion: 'Deletion',
  consent: 'Consent',
  other: 'Other',
};

const MSG_LIMIT = 100;

function MessageCell({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="muted">—</span>;
  const long = text.length > MSG_LIMIT;
  return (
    <div className="msg-cell">
      <div className={open ? 'full' : undefined}>{open || !long ? text : text.slice(0, MSG_LIMIT) + '…'}</div>
      {long ? <button type="button" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button> : null}
    </div>
  );
}

export default function AdminPrivacyRequests() {
  const toast = useToast();
  const [requests, setRequests] = useState<PrivacyRequest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [noteEdit, setNoteEdit] = useState<{ req: PrivacyRequest; note: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ requests: PrivacyRequest[] }>('/api/admin/privacy-requests');
      setRequests(r.requests);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = async (id: string, body: { status?: Status; adminNote?: string }) => {
    setBusyId(id);
    try {
      const r = await api.patch<{ request: PrivacyRequest }>(`/api/admin/privacy-requests/${id}`, body);
      setRequests((rs) => rs?.map((x) => (x.id === id ? r.request : x)) ?? rs);
      toast('Request updated.', 'success');
      return true;
    } catch (e) {
      toast(errMsg(e, 'Could not update the request.'), 'error');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const visible = requests?.filter((r) => showClosed || r.status !== 'closed') ?? [];

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Privacy requests</h1>
          <p>Access, correction, portability, deletion, and consent requests from students.</p>
        </div>
        <Toggle checked={showClosed} onChange={setShowClosed} label="Show closed" />
      </div>

      {error ? (
        <div className="section">{isAccessError(error) ? <AccessAlert error={error} /> : <Alert kind="error">{errMsg(error, 'Could not load privacy requests.')}</Alert>}</div>
      ) : null}
      {!requests && !error ? <Spinner /> : null}

      {requests ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Kind</th>
                  <th>Message</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Admin note</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const overdue = r.status !== 'closed' && r.due_at && new Date(r.due_at).getTime() < Date.now();
                  return (
                    <tr key={r.id}>
                      <td>
                        <div><Link to={`/admin/users/${r.user_id}`}>{r.user_name || r.user_email}</Link></div>
                        <div className="meta">{r.user_email}</div>
                      </td>
                      <td>{kindLabel[r.kind] ?? r.kind}</td>
                      <td><MessageCell text={r.message} /></td>
                      <td>
                        <select
                          className="select"
                          value={r.status}
                          disabled={busyId === r.id}
                          onChange={(e) => patch(r.id, { status: e.target.value as Status })}
                          aria-label="Status"
                        >
                          <option value="open">Open</option>
                          <option value="in_progress">In progress</option>
                          <option value="closed">Closed</option>
                        </select>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.due_at ? (overdue ? <span className="chip error">Overdue · {formatDate(r.due_at)}</span> : formatDate(r.due_at)) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <div className="row">
                          <span className="small grow" style={{ whiteSpace: 'pre-wrap' }}>{r.admin_note || <span className="muted">—</span>}</span>
                          <button className="btn secondary sm" onClick={() => setNoteEdit({ req: r, note: r.admin_note ?? '' })}>Edit</button>
                        </div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.created_at)}</td>
                    </tr>
                  );
                })}
                {visible.length === 0 ? (
                  <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>{showClosed ? 'No requests.' : 'No open requests.'}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Modal
        open={!!noteEdit}
        onClose={() => setNoteEdit(null)}
        title="Admin note"
        actions={
          <>
            <button className="btn secondary" onClick={() => setNoteEdit(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={!!busyId}
              onClick={async () => {
                if (!noteEdit) return;
                if (await patch(noteEdit.req.id, { adminNote: noteEdit.note })) setNoteEdit(null);
              }}
            >
              Save note
            </button>
          </>
        }
      >
        {noteEdit ? (
          <Field label={`Note for ${noteEdit.req.user_email}`} hint="Internal only. Not visible to the student.">
            <textarea className="textarea" value={noteEdit.note} onChange={(e) => setNoteEdit({ ...noteEdit, note: e.target.value })} autoFocus />
          </Field>
        ) : null}
      </Modal>
    </div>
  );
}
