import { describe, expect, it } from 'vitest';
import { chatContext } from '@/lib/chatContext';
import { finishActivity, startActivity, type ToolActivity } from '@/hooks/useLiveToolActivity';
import type { ChatMessage } from '@/stores/chat';

const done = (tool: string, args: Record<string, unknown>, over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ ...finishActivity(startActivity(tool, args), { ok: true }), ...over });

const hit = (url: string, title = '') => ({ title, url, host: new URL(url).hostname, snippet: '', crumbs: '' });

const art = (id: string) => ({ id, title: id, kind: 'document', version: 1, path: null });

const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: 0, ...m });

describe('chatContext', () => {
  it('is empty for a new chat', () => {
    expect(chatContext([])).toEqual({ files: [], sources: [], memories: [], artifactIds: [] });
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
