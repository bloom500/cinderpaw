import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CallTranscript, compactCallTranscript } from '../CallOverlay';

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
