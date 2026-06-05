import { describe, it, expect } from 'vitest';
import { splitThinking, looksLikeToolCall } from '@/lib/parseThink';

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

  // Regression: degraded models (e.g. Qwen3.5 uncensored merges) can emit a bare
  // <think> tag and stop. The answer must never carry the raw tag — it is the
  // exact input that previously leaked "<think>" into the chat via the
  // empty-answer fallback path.
  it('bare <think> with nothing after → empty answer, never the raw tag', () => {
    const r = splitThinking('<think>');
    expect(r.answer).toBe('');
    expect(r.thinkingComplete).toBe(false);
  });
});

describe('looksLikeToolCall', () => {
  it('empty / whitespace → false', () => {
    expect(looksLikeToolCall('')).toBe(false);
    expect(looksLikeToolCall('   \n ')).toBe(false);
  });

  it('plain prose → false', () => {
    expect(looksLikeToolCall('Bupropion is an antidepressant.')).toBe(false);
    expect(looksLikeToolCall('Here is what I found:')).toBe(false);
  });

  it('bare JSON tool call (partial, while streaming) → true', () => {
    expect(looksLikeToolCall('{')).toBe(true);
    expect(looksLikeToolCall('{"name": "deep_rese')).toBe(true);
    expect(looksLikeToolCall('{"name":"deep_research","args":{}}')).toBe(true);
  });

  it('fenced tool/json block → true', () => {
    expect(looksLikeToolCall('```json\n{"name"')).toBe(true);
    expect(looksLikeToolCall('```tool')).toBe(true);
    expect(looksLikeToolCall('```')).toBe(true);
  });

  it('native <tool_call> tag → true', () => {
    expect(looksLikeToolCall('<tool_call>{"name"')).toBe(true);
  });

  it('bracket format [tool(...)] → true', () => {
    expect(looksLikeToolCall('[deep_research(query=')).toBe(true);
  });

  it('language-tagged code fence (real answer) → false, not suppressed', () => {
    expect(looksLikeToolCall('```python\nprint(1)')).toBe(false);
    expect(looksLikeToolCall('```ts')).toBe(false);
  });

  it('markdown link starting with [ → false', () => {
    expect(looksLikeToolCall('[see here](http://x)')).toBe(false);
  });
});
