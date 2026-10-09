// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { linesToRender, staleLines, render, run, VOICE_ID, type Io, type Manifest } from './render-cubby-voice';

const LINES = { a: 'Hello.', b: 'Bye.' };
const KEY = 'sk_test_secret';
const audio = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

function fakeIo(over: Partial<Io> = {}): Io & { logs: string[]; written: Record<string, Uint8Array>; manifestOut: Manifest | null } {
  const io = {
    logs: [] as string[],
    written: {} as Record<string, Uint8Array>,
    manifestOut: null as Manifest | null,
    lines: LINES,
    log: (s: string) => { io.logs.push(s); },
    readManifest: async () => ({}) as Manifest,
    writeManifest: async (m: Manifest) => { io.manifestOut = m; },
    writeAudio: async (file: string, bytes: Uint8Array) => { io.written[file] = bytes; },
    hasFile: (file: string) => file in io.written,
    fetch: vi.fn(async () => audio()) as unknown as typeof fetch,
    ...over,
  };
  return io;
}

describe('linesToRender', () => {
  const m: Manifest = { a: { text: 'Hello.', model: 'eleven_v3', voice: VOICE_ID, file: 'a.mp3' } };
  it('skips a line whose words, model and voice are unchanged', () => {
    expect(linesToRender(LINES, m, 'eleven_v3', VOICE_ID)).toEqual(['b']);
  });
  it('re-renders every line when the model changes', () => {
    expect(linesToRender(LINES, m, 'eleven_v4', VOICE_ID)).toEqual(['a', 'b']);
  });
  it('keeps to --only', () => {
    expect(linesToRender(LINES, {}, 'eleven_v3', VOICE_ID, ['a'])).toEqual(['a']);
  });
});

describe('staleLines', () => {
  it('lists lines with no audio, changed words, or a missing file', () => {
    const m: Manifest = {
      a: { text: 'Hello.', model: 'm', voice: 'v', file: 'a.mp3' },
      b: { text: 'Old words.', model: 'm', voice: 'v', file: 'b.mp3' },
    };
    expect(staleLines(LINES, m, (f) => f === 'a.mp3')).toEqual(['b']);
    expect(staleLines(LINES, m, () => false)).toEqual(['a', 'b']);
  });
});

describe('render', () => {
  it('saves audio and records the exact words, model and voice', async () => {
    const io = fakeIo();
    const out = await render(['a'], LINES, {}, 'eleven_v3', KEY, io);
    expect(out.failed).toEqual([]);
    expect(io.written['a.mp3']).toEqual(new Uint8Array([1, 2, 3]));
    expect(out.manifest.a).toEqual({ text: 'Hello.', model: 'eleven_v3', voice: VOICE_ID, file: 'a.mp3' });
    const [url, init] = (io.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain(`/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`);
    expect((init as RequestInit).headers).toMatchObject({ 'xi-api-key': KEY });
  });

  it('treats a 200 that is not audio as a failure and saves nothing', async () => {
    const io = fakeIo({
      fetch: (async () => new Response('{"detail":"quota"}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    const out = await render(['a'], LINES, {}, 'eleven_v3', KEY, io);
    expect(out.failed).toHaveLength(1);
    expect(io.written).toEqual({});
    expect(out.manifest.a).toBeUndefined();
  });

  it('keeps what worked when the network drops halfway', async () => {
    let n = 0;
    const io = fakeIo({
      fetch: (async () => {
        if (n++ === 1) throw new TypeError('network down');
        return audio();
      }) as unknown as typeof fetch,
    });
    const out = await render(['a', 'b'], LINES, {}, 'eleven_v3', KEY, io);
    expect(Object.keys(out.manifest)).toEqual(['a']);
    expect(out.failed[0]).toContain('b');
  });
});

describe('run', () => {
  it('says how to set the key when there is none, and calls nothing', async () => {
    const io = fakeIo();
    expect(await run([], {}, io)).toBe(1);
    expect(io.logs.join('\n')).toContain('ELEVENLABS_API_KEY');
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('trims a pasted key with a newline', async () => {
    const io = fakeIo();
    expect(await run([], { ELEVENLABS_API_KEY: `  ${KEY}\n` }, io)).toBe(0);
    const [, init] = (io.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'xi-api-key': KEY });
  });

  it('refuses an --only id that does not exist, before any call', async () => {
    const io = fakeIo();
    expect(await run(['--only', 'a,typo'], { ELEVENLABS_API_KEY: KEY }, io)).toBe(1);
    expect(io.logs.join('\n')).toContain('typo');
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('never writes or prints the key', async () => {
    const io = fakeIo();
    await run([], { ELEVENLABS_API_KEY: KEY }, io);
    expect(io.logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(io.manifestOut)).not.toContain(KEY);
  });

  it('--check exits 1 on a stale line and 0 when all are current, with no calls', async () => {
    const stale = fakeIo();
    expect(await run(['--check'], {}, stale)).toBe(1);
    expect(stale.logs.join('\n')).toContain('a');

    const current: Manifest = {
      a: { text: 'Hello.', model: 'm', voice: 'v', file: 'a.mp3' },
      b: { text: 'Bye.', model: 'm', voice: 'v', file: 'b.mp3' },
    };
    const ok = fakeIo({ readManifest: async () => current, hasFile: () => true });
    expect(await run(['--check'], {}, ok)).toBe(0);
    expect(ok.fetch).not.toHaveBeenCalled();
  });

  it('does nothing and spends nothing when every line is current', async () => {
    const current: Manifest = {
      a: { text: 'Hello.', model: 'eleven_v3', voice: VOICE_ID, file: 'a.mp3' },
      b: { text: 'Bye.', model: 'eleven_v3', voice: VOICE_ID, file: 'b.mp3' },
    };
    const io = fakeIo({ readManifest: async () => current });
    expect(await run(['--model', 'eleven_v3'], { ELEVENLABS_API_KEY: KEY }, io)).toBe(0);
    expect(io.fetch).not.toHaveBeenCalled();
  });
});
