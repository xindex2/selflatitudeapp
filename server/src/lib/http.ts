import type { Request, Response, NextFunction } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import type { ZodTypeAny, TypeOf } from 'zod';

export class HttpError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, m, code);
export const unauthorized = (m = 'Please sign in.') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have access to this.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');

/** Validate and return the parsed value (with any zod defaults applied). */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): TypeOf<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'input'}: ${first.message}`, 'validation');
  }
  return r.data;
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Rate limiter that is disabled under NODE_ENV=test. */
export function limiter(opts: Partial<Options>) {
  if (process.env.NODE_ENV === 'test') return (_req: Request, _res: Response, next: NextFunction) => next();
  return rateLimit({ standardHeaders: true, legacyHeaders: false, ...opts });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ?? {}) });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request too large.', code: 'too_large' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.', code: 'server_error' });
}
