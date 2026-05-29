import { describe, it, expect } from 'vitest';
import { splitThinking } from '@/lib/parseThink';

describe('splitThinking', () => {
  it('no tag → all content is answer, thinkingComplete true', () => {
    expect(splitThinking('hello world')).toEqual({
      thinking: null, answer: 'hello world', thinkingComplete: true,
    });
  });

  it('open tag only (streaming) → thinking partial, answer empty, not complete', () => {
    expect(splitThinking('<think>partial reasoning so far')).toEqual({
      thinking: 'partial reasoning so far', answer: '', thinkingComplete: false,
    });
  });

  it('open + close → thinking and answer separated, complete', () => {
    expect(splitThinking('<think>I should respond politely</think>Hello!')).toEqual({
      thinking: 'I should respond politely', answer: 'Hello!', thinkingComplete: true,
    });
  });

  it('whitespace after </think> is trimmed', () => {
    expect(splitThinking('<think>x</think>\n\nHi')).toEqual({
      thinking: 'x', answer: 'Hi', thinkingComplete: true,
    });
  });

  it('no open tag → answer carries through unchanged', () => {
    expect(splitThinking('</think>orphan close')).toEqual({
      thinking: null, answer: '</think>orphan close', thinkingComplete: true,
    });
  });
});
