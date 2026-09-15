/** Thin fetch wrapper for the Companion API. All requests use the session cookie. */

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function request<T>(method: string, url: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body instanceof FormData ? undefined : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const d = typeof data === 'object' && data ? (data as any) : {};
    const { error, code, ...extra } = d;
    throw new ApiError(res.status, error ?? `Request failed (${res.status})`, code ?? 'error', extra);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
};

export interface SseHandlers {
  onEvent: (event: string, data: any) => void;
  signal?: AbortSignal;
}

/**
 * POST and read a Server-Sent Events stream (used for chat replies).
 * Events: meta, delta, title, done, error.
 */
export async function streamPost(url: string, body: unknown, h: SseHandlers): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: h.signal,
  });
  if (!res.ok || !res.body) {
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
    const { error, code, ...extra } = data as any;
    throw new ApiError(res.status, error ?? 'Request failed', code ?? 'error', extra);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        h.onEvent(event, JSON.parse(data));
      } catch {
        h.onEvent(event, data);
      }
    }
  }
}

export function downloadUrl(url: string) {
  // Same-origin, cookie-authenticated download
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
