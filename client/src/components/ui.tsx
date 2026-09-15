import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/* ------------------------------------------------------------------ Icons */
const I = (d: string, extra?: string) =>
  function Icon({ size = 18, className }: { size?: number; className?: string }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <path d={d} />
        {extra ? <path d={extra} /> : null}
      </svg>
    );
  };

export const Icons = {
  chat: I('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
  plus: I('M12 5v14M5 12h14'),
  memory: I('M12 2a7 7 0 0 0-7 7c0 2.6 1.4 4.3 2.5 5.5.7.8 1.5 1.7 1.5 2.5v1h6v-1c0-.8.8-1.7 1.5-2.5C18.6 13.3 20 11.6 20 9a7 7 0 0 0-8-7z', 'M9 21h6'),
  journal: I('M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z', 'M8 4v16M12 9h4'),
  settings: I('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'),
  shield: I('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  admin: I('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z'),
  users: I('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8'),
  search: I('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3'),
  more: I('M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'),
  send: I('M22 2 11 13M22 2l-7 20-4-9-9-4z'),
  stop: I('M6 6h12v12H6z'),
  copy: I('M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  refresh: I('M23 4v6h-6M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15'),
  check: I('M20 6 9 17l-5-5'),
  x: I('M18 6 6 18M6 6l12 12'),
  menu: I('M3 12h18M3 6h18M3 18h18'),
  logout: I('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5M21 12H9'),
  archive: I('M21 8v13H3V8', 'M1 3h22v5H1zM10 12h4'),
  trash: I('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6', 'M10 11v6M14 11v6'),
  edit: I('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z'),
  download: I('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5M12 15V3'),
  info: I('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4M12 8h.01'),
  warning: I('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4M12 17h.01'),
  key: I('M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15 8m0 0 3 3 3-3-3-3-3 3z'),
  chevronLeft: I('M15 18l-6-6 6-6'),
  chevronRight: I('M9 18l6-6-6-6'),
  chevronDown: I('M6 9l6 6 6-6'),
  clock: I('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'),
  paperclip: I('M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'),
  file: I('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6M16 13H8M16 17H8M10 9H8'),
  eye: I('M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'),
  eyeOff: I('M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-6M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2', 'M1 1l22 22'),
  sparkle: I('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'),
  calendar: I('M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4M8 2v4M3 10h18'),
  lock: I('M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z', 'M7 11V7a5 5 0 0 1 10 0v4'),
  bolt: I('M13 2 3 14h9l-1 8 10-12h-9l1-8z'),
};

/* ------------------------------------------------------------------ Toasts */
interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'success' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------ Modal */
export function Modal({ open, onClose, title, children, actions, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 760 } : undefined}>
        <h2>{title}</h2>
        <div>{children}</div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Confirmation helper: returns [confirm(), element] */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((title: string, body: ReactNode, opts?: { danger?: boolean; confirmLabel?: string }) => {
    return new Promise<boolean>((resolve) => setState({ title, body, resolve, ...opts }));
  }, []);
  const el = state ? (
    <Modal
      open
      onClose={() => { state.resolve(false); setState(null); }}
      title={state.title}
      actions={
        <>
          <button className="btn secondary" onClick={() => { state.resolve(false); setState(null); }}>Cancel</button>
          <button className={`btn ${state.danger ? 'danger' : 'primary'}`} onClick={() => { state.resolve(true); setState(null); }}>{state.confirmLabel ?? 'Confirm'}</button>
        </>
      }
    >
      <div className="small">{state.body}</div>
    </Modal>
  ) : null;
  return [confirm, el] as const;
}

/* ------------------------------------------------------------------ Misc */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Alert({ kind, children }: { kind: 'info' | 'success' | 'warning' | 'error'; children: ReactNode }) {
  const Icon = kind === 'error' || kind === 'warning' ? Icons.warning : kind === 'success' ? Icons.check : Icons.info;
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={18} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className={`field ${error ? 'error' : ''}`}>
      <label>{label}</label>
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Small dropdown menu anchored to a trigger */
export function Menu({ trigger, children, align, menuClassName }: { trigger: ReactNode; children: ReactNode; align?: 'left' | 'right'; menuClassName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <span onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{trigger}</span>
      {open ? (
        <div className={`menu ${menuClassName ?? ''}`} style={align === 'left' ? { left: 0, right: 'auto' } : undefined} onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
  return d.toLocaleDateString(undefined, opts);
}
export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function Logo({ height = 28, onDark }: { height?: number; onDark?: boolean }) {
  return <img src={onDark ? '/brand/logo-on-dark.png' : '/brand/logo-on-light.png'} alt="SelfLatitude" style={{ height, width: 'auto', display: 'block' }} />;
}

/* ------------------------------------------------------------------ Avatar */
const AVATAR_TONES = ['#405F73', '#5F7F96', '#3F7867', '#A66F2C', '#4E7187', '#66747B'];

export function initialsOf(name: string, email?: string): string {
  const source = (name || email || '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Profile picture, falling back to initials on a stable colour derived from the name. */
export function Avatar({ name, email, src, size = 32, className }: {
  name: string;
  email?: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const key = (email || name || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length];
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };

  if (src && !failed) {
    return (
      <img
        className={`avatar ${className ?? ''}`}
        style={style}
        src={src}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className={`avatar avatar-initials ${className ?? ''}`} style={{ ...style, background: tone }} aria-hidden="true">
      {initialsOf(name, email)}
    </span>
  );
}
