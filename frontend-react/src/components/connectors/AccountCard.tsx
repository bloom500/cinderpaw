/**
 * One connector account, in the words the person needs.
 *
 * The rule this card exists to keep: the mechanism is ours to know, not
 * theirs. Nobody is told about OAuth, device codes or grants. They are told a
 * code, where to type it, and — when something goes wrong — which of the
 * several different wrong things happened, because "disconnected" covers four
 * situations that need four different sentences:
 *
 *   - never connected      → connect
 *   - the code timed out   → nobody refused; try again
 *   - the account said no  → a decision, not a fault
 *   - the provider revoked → reconnect, and retrying silently is pointless
 */

import type { ConnectorAccount, ConnectorAccountStatus } from '@/lib/tauri';

/** `{ error: "…" }` is the only object-shaped status. */
function errorText(status: ConnectorAccountStatus): string | null {
  return typeof status === 'object' && status !== null && 'error' in status ? status.error : null;
}

function statusLine(account: ConnectorAccount): { headline: string; detail?: string } {
  const err = errorText(account.status);
  if (err) return { headline: 'Something went wrong', detail: err };

  switch (account.status) {
    case 'connected':
      return {
        headline: 'Connected',
        ...(account.display_name ? { detail: `as ${account.display_name}` } : {}),
      };
    case 'pairing':
      return { headline: 'Waiting for you to finish on the website' };
    case 'expired':
      // Not a failure and not a refusal: it simply ran out. Saying "error"
      // here sends people looking for a problem that does not exist.
      return { headline: 'Disconnected', detail: 'The connection ran out. Connect again to carry on.' };
    case 'revoked':
      return {
        headline: 'Disconnected',
        detail: 'The account ended this connection. Connecting again will ask for permission afresh.',
      };
    default:
      return { headline: 'Not connected' };
  }
}

export function AccountCard({
  account,
  onConnect,
}: {
  account: ConnectorAccount;
  /** Absent in read-only contexts; the button is then not offered at all
   *  rather than offered and dead. */
  onConnect?: (connectorId: string) => void;
}) {
  const { headline, detail } = statusLine(account);
  const waiting = account.auth_state?.kind === 'waiting_for_user' ? account.auth_state : null;
  // Every not-connected state offers the same way forward. A dead end with no
  // button is the failure this card is here to stop.
  const canConnect = account.status !== 'connected' && account.status !== 'pairing';

  return (
    <div className="rounded-lg border border-border p-4" data-testid={`account-${account.connector_id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium capitalize">{account.connector_id}</span>
        <span className="text-sm text-muted-foreground">{headline}</span>
      </div>

      {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}

      {waiting && (
        <div className="mt-3 space-y-2">
          <p className="text-sm">Type this code on the page below:</p>
          {/* The code is the whole point of the screen, so it is the biggest
              thing on it and selectable — people copy it. */}
          <p className="select-all font-mono text-2xl tracking-widest">{waiting.user_code}</p>
          <a
            className="text-sm underline"
            href={waiting.verification_uri}
            target="_blank"
            rel="noreferrer"
          >
            {waiting.verification_uri}
          </a>
        </div>
      )}

      {canConnect && onConnect && (
        <button
          type="button"
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm"
          onClick={() => onConnect(account.connector_id)}
        >
          {account.status === 'revoked' || account.status === 'expired' || errorText(account.status)
            ? 'Reconnect'
            : 'Connect'}
        </button>
      )}
    </div>
  );
}
