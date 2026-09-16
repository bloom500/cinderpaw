import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CallTranscript, ProviderToggle, chooseSpeechEngine, compactCallTranscript, keyOwner } from '../CallOverlay';
import type { TtsProviderInfo } from '@/lib/tauri';

describe('compactCallTranscript', () => {
  it('keeps complete trailing words within 280 characters', () => {
    const fiveLines = [
      'primul rând conține context care trebuie eliminat',
      'al doilea rând împinge frontiera în mijlocul unui cuvânt',
      'al treilea rând continuă promptul foarte lung',
      'al patrulea rând păstrează cuvintele întregi',
      'ultimul rând este partea pe care apelul trebuie să o arate',
    ].join('\n').repeat(3);

    const compact = compactCallTranscript(fiveLines);

    expect(compact.startsWith('… ')).toBe(true);
    expect(compact.length).toBeLessThanOrEqual(280);
    expect(fiveLines.replace(/\s+/g, ' ').trim().endsWith(compact.slice(2))).toBe(true);
    expect(compactCallTranscript('x'.repeat(300))).toBe('…');
  });
});

describe('CallTranscript', () => {
  it('renders every appended fragment immediately and animates only the new text', () => {
    const { rerender } = render(<CallTranscript text="Bună" fallback="Spune ceva" />);
    expect(screen.getByTestId('call-transcript')).toHaveTextContent('“Bună”');

    rerender(<CallTranscript text="Bună lume" fallback="Spune ceva" />);

    expect(screen.getByTestId('call-transcript')).toHaveTextContent('“Bună lume”');
    expect(screen.getByTestId('call-transcript-new')).toHaveTextContent('lume');
    expect(screen.getByTestId('call-transcript-new')).toHaveClass('duration-20');
  });

  it('bounds visible text to three lines but keeps the full accessible transcript', () => {
    const text = `început ${'cuvânt '.repeat(2_000)}sfârșit`;
    render(<CallTranscript text={text} fallback="Spune ceva" />);

    const transcript = screen.getByTestId('call-transcript');
    expect(transcript).toHaveClass('line-clamp-3', 'overflow-hidden');
    expect(transcript).toHaveAttribute('aria-label', text);
    expect(transcript.textContent?.length).toBeLessThanOrEqual(282);
  });
});

describe('whose key the call screen asks for', () => {
  const openai = { id: 'openai', label: 'OpenAI Realtime', pipeline: false };
  const google = { id: 'google', label: 'Gemini Live', pipeline: false };
  const pipeline = { id: 'pipeline', label: 'On this machine', pipeline: true };
  const eleven = { id: 'elevenlabs', label: 'ElevenLabs' };

  it('asks for the vendor that is actually selected', () => {
    // It used to ask for Google whichever vendor was picked, because it
    // branched on "is this a LiveKit call" and every realtime call is one.
    expect(keyOwner(openai, null)).toEqual({ id: 'openai', label: 'OpenAI Realtime' });
    expect(keyOwner(google, null)).toEqual({ id: 'google', label: 'Gemini Live' });
  });

  it('asks for the speaking engine when the call is assembled locally', () => {
    // The pipeline row holds no key of its own. Asking for one under its name,
    // or under Google's, sends the key to the wrong keychain entry.
    expect(keyOwner(pipeline, eleven)).toEqual(eleven);
  });

  it('asks for nobody when there is nobody to ask for', () => {
    expect(keyOwner(null, null)).toBeNull();
    expect(keyOwner(pipeline, null)).toBeNull();
  });
});

describe('which engine speaks on a machine nobody has configured', () => {
  const engine = (over: Partial<TtsProviderInfo> & { id: string }): TtsProviderInfo => ({
    label: over.id,
    isLocal: false,
    needsKey: false,
    needsBaseUrl: false,
    needsModel: false,
    needsDownload: false,
    consoleUrl: null,
    note: '',
    available: true,
    ...over,
  });

  const piper = engine({ id: 'piper', isLocal: true, needsDownload: true });
  const kokoro = engine({ id: 'kokoro', isLocal: true, available: false });
  const eleven = engine({ id: 'elevenlabs', needsKey: true });

  it('uses what the person chose, when they chose', () => {
    const { engine: chosen, source } = chooseSpeechEngine([piper, eleven], 'elevenlabs');
    expect(chosen?.id).toBe('elevenlabs');
    expect(source).toBe('explicit');
  });

  it('falls back to a keyless engine this build can actually run', () => {
    // The fresh-install state: nothing picked. Kokoro is catalogued but not
    // built into this binary, ElevenLabs needs a key — Piper is the only row
    // that can speak, so it is the default nobody had to set.
    const { engine: chosen, source } = chooseSpeechEngine([kokoro, piper, eleven], null);
    expect(chosen?.id).toBe('piper');
    expect(source).toBe('default');
  });

  it('never defaults to an engine that needs a key', () => {
    // A default that quietly picked a hosted engine is a default that quietly
    // starts uploading somebody's voice.
    const { engine: chosen, source } = chooseSpeechEngine([eleven], null);
    expect(chosen).toBeNull();
    expect(source).toBe('none');
  });

  it('never defaults to an engine this build does not contain', () => {
    // Every Linux build and the Vulkan desktop build are here: ONNX Runtime's
    // glibc floor keeps Piper and Kokoro out on purpose.
    const { engine: chosen, source } = chooseSpeechEngine(
      [kokoro, engine({ id: 'piper', available: false })],
      null,
    );
    expect(chosen).toBeNull();
    expect(source).toBe('none');
  });

  it("'none' is a fact, and an empty catalogue is the same fact", () => {
    // The whole defect was collapsing this into the `null` that means "the
    // check failed", which left the Call button enabled and turned a missing
    // engine into twenty seconds of provisioning and then bad advice about
    // the network.
    expect(chooseSpeechEngine([], null).source).toBe('none');
  });

  it('a selection that no longer exists in the catalogue falls back rather than sticking', () => {
    // An engine can leave the build between releases. Holding the stale id
    // would report "none" on a machine that has a perfectly good local engine.
    const { engine: chosen, source } = chooseSpeechEngine([piper], 'an-engine-that-was-removed');
    expect(chosen?.id).toBe('piper');
    expect(source).toBe('default');
  });
});

describe('CallTranscript', () => {
  // The gap this closes: on a native-audio model the transcript lands after
  // the turn, so between the first word spoken and the words appearing there
  // was nothing moving on screen at all. The dots are driven by the caller's
  // own microphone, so they are true the instant they show.
  it('shows that it is hearing you before any transcript exists', () => {
    const { rerender } = render(<CallTranscript text="" fallback="Say something" speaking={false} />);
    expect(screen.getByTestId('call-transcript')).toHaveTextContent('Say something');

    rerender(<CallTranscript text="" fallback="Say something" speaking />);
    expect(screen.getByTestId('call-transcript-listening')).toBeInTheDocument();
    expect(screen.getByTestId('call-transcript')).not.toHaveTextContent('Say something');
  });

  it('the words win over the dots the moment they land', () => {
    render(<CallTranscript text="how much did we spend" fallback="Say something" speaking />);
    expect(screen.queryByTestId('call-transcript-listening')).toBeNull();
    expect(screen.getByTestId('call-transcript')).toHaveTextContent('how much did we spend');
  });
});

describe('ProviderToggle', () => {
  const providers = [
    { id: 'google', label: 'Gemini Realtime', pipeline: false, connected: false, voices: [], defaultVoice: '' },
    { id: 'openai', label: 'OpenAI Realtime', pipeline: false, connected: true, voices: [], defaultVoice: '' },
    { id: 'pipeline', label: 'Transcribe → answer → speak', pipeline: true, connected: true, voices: [], defaultVoice: '' },
  ] as never[];
  const t = (k: string) => ({ 'call.groupPipeline': 'STT + TTS', 'call.groupS2s': 'Speech to speech' }[k] ?? k);

  it('shows two kinds of call, and the vendors only under speech to speech', () => {
    const { rerender } = render(
      <ProviderToggle providers={providers} effective="pipeline" willEcho={false} onChange={() => {}} t={t as never} />,
    );
    expect(screen.getByRole('button', { name: 'STT + TTS' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Gemini Realtime')).toBeNull();

    rerender(<ProviderToggle providers={providers} effective="google" willEcho={false} onChange={() => {}} t={t as never} />);
    expect(screen.getByRole('button', { name: 'Speech to speech' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Gemini Realtime')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Realtime')).toBeInTheDocument();
  });

  it('switching to speech to speech lands on a vendor that has a key', () => {
    const picked: string[] = [];
    render(<ProviderToggle providers={providers} effective="pipeline" willEcho={false} onChange={(id: string) => picked.push(id)} t={t as never} />);
    screen.getByRole('button', { name: 'Speech to speech' }).click();
    expect(picked).toEqual(['openai']);
  });

  it('with STT + TTS parked, shows the vendors directly, even before any key exists', () => {
    const s2sOnly = providers.slice(0, 2).map((p: never) => ({ ...(p as object), connected: false })) as never[];
    render(<ProviderToggle providers={s2sOnly} effective={null} willEcho={false} onChange={() => {}} t={t as never} />);
    expect(screen.queryByRole('button', { name: 'Speech to speech' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'STT + TTS' })).toBeNull();
    expect(screen.getByText('Gemini Realtime')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Realtime')).toBeInTheDocument();
  });
});
