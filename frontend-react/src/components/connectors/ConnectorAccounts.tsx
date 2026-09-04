import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountCard } from './AccountCard';
import { tauri, type ConnectorAccount } from '@/lib/tauri';

/**
 * The accounts list, and the loop that makes a pairing code mean something.
 *
 * Phase 3 built the whole mechanism — start a device flow, poll it, store the
 * grant in the vault — and left the last wire off: the card showed a code and
 * then sat there forever, because nothing ever asked whether the person had
 * finished. From the outside that is indistinguishable from a broken feature,
 * and there is nothing on screen to tell you otherwise.
 *
 * So the loop lives here, next to the only screen that renders those cards,
 * and it runs only while something is actually in flight.
 */

/** What the provider asks for in a device flow. Slower is rude to the user,
 *  faster is rude to the provider, and RFC 8628's own default is five. */
const POLL_MS = 5_000;

export function ConnectorAccounts() {
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A poll in flight must not be started twice by a re-render.
  const polling = useRef(false);

  const merge = useCallback((updated: ConnectorAccount) => {
    setAccounts((prev) => {
      const idx = prev.findIndex((a) => a.connector_id === updated.connector_id);
      if (idx === -1) return [...prev, updated];
      const next = prev.slice();
      next[idx] = updated;
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    tauri.connectors.accounts()
      .then((list) => { if (alive) setAccounts(list); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // One interval for the whole list: the number of accounts pairing at once is
  // realistically one, and a timer per card is a timer per card to leak.
  const pending = accounts.filter((a) => a.status === 'pairing').map((a) => a.connector_id);
  const pendingKey = pending.join(',');
  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',');
    const tick = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        for (const id of ids) {
          const updated = await tauri.connectors.pairPoll(id);
          merge(updated);
        }
      } catch (e) {
        // A failed poll is not a failed pairing — the next tick may well work,
        // so the card keeps its state and the reason goes on screen once.
        setError(String(e));
      } finally {
        polling.current = false;
      }
    };
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey, merge]);

  const connect = async (connectorId: string) => {
    setError(null);
    try {
      merge(await tauri.connectors.pairStart(connectorId));
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading) return <div className="h-24 rounded-xl bg-bg-hover animate-pulse" />;

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}
      {accounts.length === 0 ? (
        <p className="text-sm text-text-muted">
          No accounts yet. Connect one below and it will show up here.
        </p>
      ) : (
        accounts.map((a) => (
          <AccountCard key={a.connector_id} account={a} onConnect={(id) => void connect(id)} />
        ))
      )}
    </div>
  );
}
