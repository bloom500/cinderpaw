import { describe, it, expect } from 'vitest';
import { splitThinking, looksLikeToolCall, stripStreamingToolCalls } from '@/lib/parseThink';

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

  it('orphan close with empty prefix → answer carries through unchanged', () => {
    expect(splitThinking('</think>orphan close')).toEqual({
      thinking: null, answer: '</think>orphan close', thinkingComplete: true,
    });
  });

  // Regression: MiniMax-M2 / DeepSeek-R1-style chat templates bake the opening
  // <think> into the prompt, so the completion arrives as
  // "reasoning…</think>answer" with no opening tag. The reasoning prose must
  // land in the thinking block, never in the chat answer.
  it('orphan close with reasoning prefix → prefix is thinking, rest is answer', () => {
    expect(splitThinking('Let me reason about this.</think>Hello!')).toEqual({
      thinking: 'Let me reason about this.', answer: 'Hello!', thinkingComplete: true,
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

describe('stripStreamingToolCalls', () => {
  it('text that is entirely a tool call → empty', () => {
    expect(stripStreamingToolCalls('<tool_call>{"name"')).toBe('');
    expect(stripStreamingToolCalls('{"name": "memory_graph"')).toBe('');
  });

  it('prose followed by mid-text <tool_call> → keeps prose, cuts the call', () => {
    expect(
      stripStreamingToolCalls('Let me check my memory.\n<tool_call>{"name="memory_graph">'),
    ).toBe('Let me check my memory.');
    // Partial opener while streaming token-by-token is cut too.
    expect(stripStreamingToolCalls('Checking now. <tool_c')).toBe('Checking now.');
  });

  it('prose followed by a bare JSON call on its own line → cuts at the call', () => {
    expect(
      stripStreamingToolCalls('I will search.\n{"name": "web_search", "args": {"query": "x"}}'),
    ).toBe('I will search.');
    // Corrupted variant with = instead of :
    expect(stripStreamingToolCalls('I will search.\n{"name="web_search">')).toBe('I will search.');
  });

  it('prose followed by a ```tool fence → cuts at the fence', () => {
    expect(stripStreamingToolCalls('On it.\n```tool\n{"name"')).toBe('On it.');
  });

  it('plain prose and real answers pass through untouched', () => {
    expect(stripStreamingToolCalls('Bupropion is an antidepressant.')).toBe(
      'Bupropion is an antidepressant.',
    );
    const code = 'Here is the config:\n```python\nprint({"port": 8080})\n```';
    expect(stripStreamingToolCalls(code)).toBe(code);
    // JSON inline in prose (not at line start) is not a tool call.
    expect(stripStreamingToolCalls('Use {"name": value} syntax carefully')).toBe(
      'Use {"name": value} syntax carefully',
    );
  });
});
