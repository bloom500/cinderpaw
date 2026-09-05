import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CallTranscript, compactCallTranscript, keyOwner } from '../CallOverlay';

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
    expect(screen.getByTestId('call-transcript-new')).toHaveClass('duration-[20ms]');
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
