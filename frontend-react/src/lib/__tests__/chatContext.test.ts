import { describe, expect, it } from 'vitest';
import { chatContext, createChatContextReader } from '@/lib/chatContext';
import { finishActivity, startActivity, type ToolActivity } from '@/hooks/useLiveToolActivity';
import type { ChatMessage } from '@/stores/chat';

const done = (tool: string, args: Record<string, unknown>, over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ ...finishActivity(startActivity(tool, args), { ok: true }), ...over });

const hit = (url: string, title = '') => ({ title, url, host: new URL(url).hostname, snippet: '', crumbs: '' });

const art = (id: string) => ({ id, title: id, kind: 'document', version: 1, path: null });

const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: 0, ...m });

describe('chatContext', () => {
  it('does not reparse settled history for every streamed chunk', () => {
    let reads = 0;
    const history = Array.from({ length: 1000 }, () => msg({
      get content() { reads++; return 'A settled reply with [a source](https://a.com).'; },
    }));
    // Keep the getter: spreading a partial into msg would consume it.
    for (const m of history) Object.defineProperty(m, 'content', { get: () => { reads++; return 'A settled reply.'; } });
    const read = createChatContextReader();
    read([...history, msg({ content: 'Starting' })]);
    reads = 0;
    for (let i = 0; i < 20; i++) read([...history, msg({ content: `Starting ${i}` })]);
    expect(reads).toBe(0);
  });

  it('matches a full rebuild across appends, edits, removals and switches', () => {
    const read = createChatContextReader();
    const a = msg({ content: '[one](https://a.com)', memoryUsed: [{ kind: 'fact', text: 'first' }] });
    const b = msg({ toolActivity: [done('artifact', {}, { artifact: art('a') })] });
    const c = msg({ toolActivity: [done('artifact', {}, { artifact: art('b') }), done('artifact', {}, { artifact: art('a') })] });
    for (const messages of [[a], [a, b], [a, b, c], [a, b], [a], [c, b], [], [a, c]]) {
      expect(read(messages)).toEqual(chatContext(messages));
    }
  });

  it('is empty for a new chat', () => {
    expect(chatContext([])).toEqual({ files: [], sources: [], memories: [], artifactIds: [], tools: [] });
  });

  it('lists each attached file once, by kind and name', () => {
    const content = '[File: notes.txt]\nhello\n[/File: notes.txt]\n\n[Image attached: cat.png]\n\nlook';
    const ctx = chatContext([msg({ role: 'user', content }), msg({ role: 'user', content })]);
    expect(ctx.files).toEqual([{ name: 'notes.txt', kind: 'text' }, { name: 'cat.png', kind: 'image' }]);
  });

  it('keeps the results a reply cited and the pages the agent opened, never an uncited hit', () => {
    const search = done('web_search', { query: 'x' }, { hits: [hit('https://a.com/one', 'One'), hit('https://b.com/two', 'Two')] });
    const page = done('read_webpage', { url: 'https://c.com/page' }, { subject: 'https://c.com/page' });
    const ctx = chatContext([msg({ content: 'See [one](https://a.com/one/).', toolActivity: [search, page] })]);
    expect(ctx.sources.map((s) => s.url)).toEqual(['https://a.com/one', 'https://c.com/page']);
    // The tools stay listed after the reply: they are read from the saved steps.
    expect(ctx.tools).toEqual(['web_search', 'read_webpage']);
  });

  it('gathers memories from the injected block and recall lookups, once each', () => {
    const recall = done('recall', { query: 'pet' }, { facts: ['pet: Miso', 'city: Cluj'] });
    const ctx = chatContext([msg({ memoryUsed: [{ kind: 'fact', text: 'city: Cluj' }], toolActivity: [recall] })]);
    expect(ctx.memories.map((m) => m.text)).toEqual(['pet: Miso', 'city: Cluj']);
  });

  it('lists the artifacts newest first, and one changed again moves to the front', () => {
    const ctx = chatContext([
      msg({ toolActivity: [done('artifact', {}, { artifact: art('a') }), done('artifact', {}, { artifact: art('b') })] }),
      msg({ toolActivity: [done('artifact', {}, { artifact: art('a') })] }),
    ]);
    expect(ctx.artifactIds).toEqual(['a', 'b']);
  });

  it('ignores a failed tool', () => {
    const failed = { ...done('artifact', {}, { artifact: art('x') }), status: 'failed' as const };
    expect(chatContext([msg({ toolActivity: [failed] })]).artifactIds).toEqual([]);
  });
});
