import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Alert } from '../../components/ui';

/** Error message helper shared by administration pages. */
export function errMsg(err: unknown, fallback = 'Something went wrong.') {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

/**
 * Super Admin sections return 403 with a message when the account is not a Super Admin
 * or the session has not been MFA-verified. Render that message with a helpful link.
 */
export function AccessAlert({ error }: { error: unknown }) {
  const message = errMsg(error, 'You do not have access to this section.');
  const lower = message.toLowerCase();
  const mentionsMfa = /multifactor|multi-factor|two-step|two-factor|authenticator|mfa/.test(lower);
  const notEnabled = /enable|set up|setup|not enabled|turn on/.test(lower);
  const is403 = error instanceof ApiError && error.status === 403;
  return (
    <Alert kind={is403 ? 'warning' : 'error'}>
      <div>{message}</div>
      {is403 && mentionsMfa ? (
        <div style={{ marginTop: 6 }}>
          {notEnabled ? <Link to="/settings#mfa">Enable two-step verification</Link> : <Link to="/mfa">Verify your code</Link>}
        </div>
      ) : null}
    </Alert>
  );
}

export function isAccessError(err: unknown) {
  return err instanceof ApiError && err.status === 403;
}

export const money = (n: number | null | undefined, digits = 2) => `$${(Number(n) || 0).toFixed(digits)}`;

export function truncate(s: string | null | undefined, n = 80) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
