/**
 * The inbound receiver: one listener for the connectors a platform must CALL.
 *
 * Five platforms (LINE, Twilio SMS, Google Chat, Teams, Synology Chat) have
 * no pull API: the provider POSTs each message to an address you own. The
 * decision in `docs/decisions/2026-09-12-webhook-inbound.md` is that Cinderpaw
 * ships this receiver and the user supplies the public address (a tunnel, a
 * reverse proxy, a domain). Nothing here is reachable until a webhook
 * connector is enabled, and the process never runs a relay.
 *
 * What it is NOT: the loopback gateway. That one carries `/runtime` and the
 * bearer-token API and must never be pointed at the internet. This listener
 * serves `POST /connectors/<id>` and answers 404 to everything else, so the
 * worst a tunnel can expose is a signature check.
 *
 * Signature verification is the transport's job and runs on the RAW bytes:
 * every platform signs the body as sent, and re-serialising parsed JSON
 * changes it. So a handler gets `Uint8Array` + headers and parses only after
 * it has accepted the signature.
 *
 * ponytail: one port for all five, no TLS (the tunnel or proxy terminates it),
 * no per-route rate limit. Add TLS the day someone runs this on a bare public
 * IP, and say so on the card first.
 */

import { cfgInt, cfgPath } from "../config.ts";

/** A platform POST, before anything about it has been trusted. */
export interface InboundRequest {
  /** The body exactly as received; verify the signature over THIS. */
  body: Uint8Array;
  headers: Headers;
  url: URL;
}

export type InboundHandler = (req: InboundRequest) => Promise<Response> | Response;

const handlers = new Map<string, InboundHandler>();
let server: ReturnType<typeof Bun.serve> | null = null;

/** Where the listener is bound, for the log line and the card. */
export function inboundAddress(): { host: string; port: number } {
  return {
    host: cfgPath("CINDERPAW_INBOUND_HOST") ?? "127.0.0.1",
    port: cfgInt("CINDERPAW_INBOUND_PORT"),
  };
}

/** The path a platform must be told, e.g. `/connectors/line`. */
export function inboundPath(id: string): string {
  return `/connectors/${id}`;
}

/**
 * Serve one connector's route. Starts the listener on the first route and
 * stops it on the last, so a machine with no webhook connector enabled has
 * no open port. The returned function unregisters.
 */
export async function serveInbound(
  id: string,
  handler: InboundHandler,
  log: (m: string) => void,
): Promise<() => Promise<void>> {
  handlers.set(id, handler);
  if (!server) {
    const { host, port } = inboundAddress();
    try {
      server = Bun.serve({ hostname: host, port, fetch: dispatch });
    } catch (e) {
      handlers.delete(id);
      throw new Error(
        `inbound: cannot listen on ${host}:${port} (${String(e)}). ` +
          "Another program has the port; set CINDERPAW_INBOUND_PORT to a free one and re-enable the connector.",
      );
    }
    // The person needs two things on screen: where it listens, and that a
    // loopback bind is only reachable through a tunnel or proxy on this
    // machine. Both are on the card too; this is for the log they do have.
    log(
      `inbound: listening on http://${host}:${port} — point your tunnel or reverse proxy here ` +
        `(loopback only unless CINDERPAW_INBOUND_HOST is set to 0.0.0.0)`,
    );
  }
  return async () => {
    handlers.delete(id);
    if (handlers.size === 0 && server) {
      const s = server;
      server = null;
      await s.stop(true);
      log("inbound: no webhook connector enabled, listener closed");
    }
  };
}

/** Exported for the test: the routing without a socket. */
export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const m = /^\/connectors\/([a-z0-9-]+)$/.exec(url.pathname);
  const handler = m ? handlers.get(m[1]!) : undefined;
  if (!handler) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = new Uint8Array(await request.arrayBuffer());
  try {
    return await handler({ body, headers: request.headers, url });
  } catch (e) {
    // A handler that throws must not answer 200: the platform would take
    // the message as delivered and never retry it.
    return new Response(String(e), { status: 500 });
  }
}

/** Test seam: the routes currently served. */
export function inboundRoutes(): string[] {
  return [...handlers.keys()].map(inboundPath);
}
