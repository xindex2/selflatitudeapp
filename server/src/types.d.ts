import type { SessionUser } from './middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
      mfaVerified?: boolean;
    }
  }
}
export {};
