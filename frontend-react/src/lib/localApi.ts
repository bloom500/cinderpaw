import { tauri } from '@/lib/tauri';

/** The port the local API asks for by default (Settings > API server). */
const ASKED = 11435;
let actual: number | null = null;
let pending: Promise<number> | null = null;

/**
 * The bundled engine's address on this launch. Usually localhost:11435, but
 * when that port is taken at launch the API binds any free one (boot.rs), and
 * the address written into the UI in four places then reached nothing: local
 * models went silent with no reason on screen. Asked of the host once.
 */
export function localApiBase(): Promise<string> {
  pending ??= tauri.raw.getLocalApiPort().then((p) => (actual = p)).catch(() => ASKED);
  return pending.then((p) => `http://localhost:${p}`);
}

/** Whether a base URL is the bundled engine, on either port it may be on. */
export function isLocalEngineUrl(url: string | null | undefined): boolean {
  const m = /^https?:\/\/(localhost|127\.0\.0\.1):(\d+)/.exec(url ?? '');
  return !!m && (Number(m[2]) === ASKED || Number(m[2]) === actual);
}
