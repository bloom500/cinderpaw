// Makes Cubby's audio with ElevenLabs, once, on Darius's machine. Run it from a
// PowerShell window of your own (never through Claude Code, never with the key
// typed into a chat), with ELEVENLABS_API_KEY set in that window:
//
//   bun run voice:render                  render every new or changed line
//   bun run voice:render --only a,b       just these lines
//   bun run voice:render --model eleven_v4
//   bun run voice:check                   no calls; exit 1 if any line needs audio
//
// Writes src/assets/voice/<id>.mp3 and src/voice/cubby-voice.json. The key is
// read from the environment and never printed or written anywhere.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUBBY_LINES } from '../src/voice/cubby-lines';

export const VOICE_ID = 'C9MXee9tu78kuWq66zMt'; // "Cubby", sample A2, in Darius's ElevenLabs account
export const DEFAULT_MODEL = 'eleven_v4'; // Darius's pick, 9 Oct 2026; change here, then re-render

export type Manifest = Record<string, { text: string; model: string; voice: string; file: string }>;

export interface Io {
  lines: Record<string, string>;
  log(s: string): void;
  readManifest(): Promise<Manifest>;
  writeManifest(m: Manifest): Promise<void>;
  writeAudio(file: string, bytes: Uint8Array): Promise<void>;
  hasFile(file: string): boolean;
  fetch: typeof fetch;
}

export function linesToRender(
  lines: Record<string, string>,
  m: Manifest,
  model: string,
  voice: string,
  only?: string[],
): string[] {
  return Object.keys(lines).filter((id) => {
    if (only && !only.includes(id)) return false;
    const e = m[id];
    return !e || e.text !== lines[id] || e.model !== model || e.voice !== voice;
  });
}

export function staleLines(lines: Record<string, string>, m: Manifest, hasFile: (file: string) => boolean): string[] {
  return Object.keys(lines).filter((id) => {
    const e = m[id];
    return !e || e.text !== lines[id] || !hasFile(e.file);
  });
}

export async function render(
  ids: string[],
  lines: Record<string, string>,
  m: Manifest,
  model: string,
  key: string,
  io: Io,
): Promise<{ manifest: Manifest; failed: string[] }> {
  const manifest = { ...m };
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const res = await io.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: lines[id], model_id: model }),
      });
      // A 200 can still carry a JSON error; only audio is audio.
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio/')) {
        failed.push(`${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      const file = `${id}.mp3`;
      await io.writeAudio(file, new Uint8Array(await res.arrayBuffer()));
      manifest[id] = { text: lines[id], model, voice: VOICE_ID, file };
      io.log(`ok  ${id}`);
    } catch (err) {
      failed.push(`${id}: ${String(err)}`);
    }
  }
  return { manifest, failed };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function run(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const manifest = await io.readManifest();

  if (argv.includes('--check')) {
    const stale = staleLines(io.lines, manifest, io.hasFile);
    if (stale.length === 0) {
      io.log(`All ${Object.keys(io.lines).length} lines have audio made from their current words.`);
      return 0;
    }
    for (const id of stale) io.log(`needs audio: ${id}`);
    io.log('Run `bun run voice:render` with ELEVENLABS_API_KEY set to make it.');
    return 1;
  }

  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    io.log('No key. In your own PowerShell window, set ELEVENLABS_API_KEY first, then run this again.');
    return 1;
  }

  const onlyArg = flag(argv, '--only');
  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const unknown = (only ?? []).filter((id) => !(id in io.lines));
  if (unknown.length) {
    io.log(`No such line: ${unknown.join(', ')}. Lines are: ${Object.keys(io.lines).join(', ')}`);
    return 1;
  }

  const model = flag(argv, '--model') ?? DEFAULT_MODEL;
  const ids = linesToRender(io.lines, manifest, model, VOICE_ID, only);
  if (ids.length === 0) {
    io.log('Nothing to render: every line already has audio from its current words.');
    return 0;
  }
  const chars = ids.reduce((n, id) => n + io.lines[id].length, 0);
  io.log(`Rendering ${ids.length} line(s) with ${model}, about ${chars} characters of the grant.`);

  const out = await render(ids, io.lines, manifest, model, key, io);
  // Save whatever worked, so a re-run after a dropped connection renders only the rest.
  if (out.failed.length < ids.length) await io.writeManifest(out.manifest);
  for (const f of out.failed) io.log(`FAILED ${f}`);
  io.log(out.failed.length ? `${out.failed.length} failed. Run again to retry just those.` : 'Done.');
  return out.failed.length ? 1 : 0;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = join(ROOT, 'src', 'assets', 'voice');
const MANIFEST = join(ROOT, 'src', 'voice', 'cubby-voice.json');

const diskIo: Io = {
  lines: CUBBY_LINES,
  log: (s) => console.log(s),
  readManifest: async () => JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest,
  writeManifest: async (m) => {
    const sorted = Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
  },
  writeAudio: async (file, bytes) => {
    await mkdir(AUDIO_DIR, { recursive: true });
    await writeFile(join(AUDIO_DIR, file), bytes);
  },
  hasFile: (file) => existsSync(join(AUDIO_DIR, file)),
  fetch: (...a) => fetch(...a),
};

// Bun sets import.meta.main for the file it was started with; under vitest it is undefined.
if ((import.meta as { main?: boolean }).main) {
  process.exit(await run(process.argv.slice(2), process.env, diskIo));
}
