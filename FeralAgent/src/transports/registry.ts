/**
 * One place that knows which transports exist.
 *
 * `ConnectorManager` used to name Discord, Slack and WhatsApp in its own
 * fields (`#discord`, `#slack`, `#whatsapp`), each with a hand-written
 * start/stop/health branch. Adding a fourth meant editing the manager, and a
 * connector that shipped in the catalog but not in those branches simply did
 * nothing on a stranger's machine — enabled in the file, absent in the
 * process, no message anywhere. A transport now registers itself and the
 * manager only asks this map.
 *
 * `send` is deliberately `(sessionId, text) => Promise<void>`, the same shape
 * as `ChannelSender` in `core/ask-user-channel.ts`: session ids are already
 * connector-prefixed and `ChannelAskRouter` routes on that prefix, so there is
 * no message envelope to invent here.
 */

import type {
  AgentLike,
  ConnectorHealth,
  ConnectorRow,
  ConnectorRunHooks,
  Log,
} from "./connectors.ts";
import type { ChannelAskRouter } from "../core/ask-user-channel.ts";
import type { LeadDesk } from "../core/lead-desk.ts";

/** Everything a transport needs to run, assembled by the host. */
export interface ConnectorContext {
  /** The persisted config — WITHOUT secret values. */
  row: ConnectorRow;
  /**
   * Credentials, already resolved out of the vault by the host, keyed by the
   * catalog's field key. A transport never reads the vault itself, so it also
   * never has a path that writes one back to disk.
   */
  secrets: Record<string, string>;
  agent: AgentLike;
  log: Log;
  runs: ConnectorRunHooks | null;
  askRouter: ChannelAskRouter;
  personaProfileId?: string;
  /** Host service a transport may use if it wants it (WhatsApp's public mode
   *  hands strangers to it). One optional field beats an abstraction: a
   *  transport that does not want it never reads it. */
  leadDesk?: LeadDesk;
}

export interface LiveConnector {
  start(ctx: ConnectorContext): Promise<void>;
  stop(): Promise<void>;
  /** What actually connected, as opposed to what the config asks for. */
  health(): ConnectorHealth;
  send(sessionId: string, text: string): Promise<void>;
}

export type ConnectorFactory = () => LiveConnector;

const transports = new Map<string, ConnectorFactory>();

/** Last registration for an id wins — ids come from the catalog and are
 *  unique, so a second one means a test double is deliberately replacing it. */
export function registerTransport(id: string, make: ConnectorFactory): void {
  transports.set(id, make);
}

export function transportFor(id: string): ConnectorFactory | undefined {
  return transports.get(id);
}

export function registeredTransports(): string[] {
  return [...transports.keys()];
}
