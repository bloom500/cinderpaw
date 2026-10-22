/**
 * Sign in to a web extension in the browser (OAuth 2.1, as the MCP
 * authorization spec describes it). Notion, Linear and most big services
 * connect this way instead of with a key.
 *
 * Their 401 names where to sign in. Cinderpaw registers itself with the
 * service (dynamic client registration: nobody creates an app by hand), opens
 * the browser, catches the answer on 127.0.0.1, and keeps the tokens in
 * ~/.cinderpaw/mcp-oauth/, behind the wall the agent's file tools cannot
 * cross. An access token about to run out is refreshed before it is sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";

export interface OAuthTokens {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch; absent when the service did not say. */
  expiresAt?: number;
}

const dir = () => join(cinderpawHome(), "mcp-oauth");
const file = (id: string) => join(dir(), `${id.replace(/[^\w.-]/g, "_")}.json`);

export function loadTokens(id: string): OAuthTokens | null {
  try {
    return JSON.parse(readFileSync(file(id), "utf8")) as OAuthTokens;
  } catch {
    return null;
  }
}

function saveTokens(id: string, tokens: OAuthTokens): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(id)}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
  renameSync(tmp, file(id));
}

/** Forget the sign-in of every service no longer in the config. */
export function pruneTokens(keep: ReadonlySet<string>): void {
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return;
  }
  const kept = new Set([...keep].map((id) => `${id.replace(/[^\w.-]/g, "_")}.json`));
  for (const name of names) if (!kept.has(name)) rmSync(join(dir(), name), { force: true });
}

/** https, or http on this machine (local servers, tests). Anything else is refused. */
function safeUrl(raw: unknown, what: string): string {
  const u = new URL(String(raw));
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error(`sign-in: the service's ${what} is not https`);
  }
  return u.href;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** RFC 8414, then OpenID discovery, path-aware, in the order the MCP spec gives. */
async function authServerMetadata(issuer: string): Promise<Record<string, unknown>> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  const tries = path
    ? [
        `${u.origin}/.well-known/oauth-authorization-server${path}`,
        `${u.origin}/.well-known/openid-configuration${path}`,
        `${u.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const url of tries) {
    const meta = await getJson(url);
    if (meta?.authorization_endpoint && meta.token_endpoint) return meta;
  }
  throw new Error("sign-in: the service did not say where to sign in");
}

/** One `name="value"` from a WWW-Authenticate header. */
function param(header: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, "i").exec(header)?.[1];
}

/** The default browser, with no shell in between: a `&` in the link stays a character. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
): Promise<Pick<OAuthTokens, "accessToken" | "refreshToken" | "expiresAt">> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in: the service did not hand over access (HTTP ${res.status}${body.error ? ` ${body.error}` : ""})`);
  }
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
  };
}

/** Where sign-in pages open. Tests swap `open` so no real browser starts. */
export const browser = { open: openInBrowser };

export interface SignInOptions {
  /** Where the sign-in page goes; the default browser unless a test says otherwise. */
  open?: (url: string) => void;
  /** Under the desktop's BROWSER_LOGIN_TIMEOUT (600 s), so the host never gives up first. */
  timeoutMs?: number;
}

/** The whole sign-in, from the 401's WWW-Authenticate to saved tokens. */
export async function signIn(
  id: string,
  serverUrl: string,
  wwwAuthenticate: string,
  opts: SignInOptions = {},
): Promise<OAuthTokens> {
  const server = new URL(serverUrl);
  const path = server.pathname.replace(/\/$/, "");
  const prmUrl = param(wwwAuthenticate, "resource_metadata") ?? `${server.origin}/.well-known/oauth-protected-resource${path}`;
  const prm = await getJson(safeUrl(prmUrl, "sign-in information"));
  const issuer = (prm?.authorization_servers as string[] | undefined)?.[0] ?? server.origin;
  const as = await authServerMetadata(safeUrl(issuer, "sign-in server"));
  if (!as.registration_endpoint) {
    throw new Error("sign-in: this service only lets apps it already knows sign in");
  }
  const resource = typeof prm?.resource === "string" ? prm.resource : `${server.origin}${server.pathname}`;
  const scope = param(wwwAuthenticate, "scope") ?? (prm?.scopes_supported as string[] | undefined)?.join(" ");

  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let deliver!: (u: URL) => void;
  const arrived = new Promise<URL>((resolve) => (deliver = resolve));
  const loopback = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) {
        return new Response("Not found", { status: 404 });
      }
      deliver(u);
      return new Response(
        "<!doctype html><meta charset=utf-8><title>Cinderpaw</title>" +
          "<p style='font:16px system-ui;margin:3em'>Done. You can close this tab and go back to Cinderpaw.</p>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    },
  });
  const redirect = `http://127.0.0.1:${loopback.port}/callback`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reg = await fetch(safeUrl(as.registration_endpoint, "registration link"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Cinderpaw",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await reg.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    if (!reg.ok || !client.client_id) {
      throw new Error(`sign-in: the service would not register Cinderpaw (HTTP ${reg.status})`);
    }

    const page = new URL(safeUrl(as.authorization_endpoint, "sign-in page"));
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource,
      ...(scope ? { scope } : {}),
    })) page.searchParams.set(k, v);
    (opts.open ?? browser.open)(page.href);

    const back = await Promise.race([
      arrived,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("sign-in: nobody finished signing in in the browser")),
          opts.timeoutMs ?? 570_000,
        );
      }),
    ]);
    const refused = back.searchParams.get("error");
    if (refused) throw new Error(`sign-in: the service said ${refused}`);
    const code = back.searchParams.get("code");
    if (!code) throw new Error("sign-in: the browser came back without a code");

    const tokenEndpoint = safeUrl(as.token_endpoint, "token link");
    const secret: Record<string, string> = client.client_secret ? { client_secret: client.client_secret } : {};
    const granted = await tokenRequest(tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      client_id: client.client_id,
      resource,
      ...secret,
    });
    const tokens: OAuthTokens = {
      clientId: client.client_id,
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
      tokenEndpoint,
      resource,
      ...granted,
    };
    saveTokens(id, tokens);
    return tokens;
  } finally {
    clearTimeout(timer);
    loopback.stop(true);
  }
}

/**
 * The access token to send for `id`, refreshed when it runs out within a
 * minute. null when there is no sign-in, or the service refused the refresh.
 */
export async function accessToken(id: string): Promise<string | null> {
  const t = loadTokens(id);
  if (!t) return null;
  if (!t.expiresAt || t.expiresAt - Date.now() > 60_000) return t.accessToken;
  if (!t.refreshToken) return null;
  try {
    const fresh = await tokenRequest(t.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
      client_id: t.clientId,
      resource: t.resource,
      ...(t.clientSecret ? { client_secret: t.clientSecret } : {}),
    });
    const next: OAuthTokens = { ...t, ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken };
    saveTokens(id, next);
    return next.accessToken;
  } catch {
    return null;
  }
}
