import { describe, expect, it } from 'vitest';
import { timeline } from '../timeline';
import { startActivity } from '@/hooks/useLiveToolActivity';

const tool = (name: string, at?: number) => ({ ...startActivity(name, {}), ...(at === undefined ? {} : { at }) });
const shape = (p: ReturnType<typeof timeline>) =>
  p?.map((x) => (x.kind === 'text' ? x.text : x.tools.map((t) => t.tool).join('+')));

// The 26 Sep space-bunny reply, as the stream builds it: segments joined with
// a blank line, each tool's `at` the text length when it was called.
describe('timeline', () => {
  it('puts each tool where it was called: text, tool, text, tool, text', () => {
    const a = 'Hai să verific ce e real.';
    const b = 'Cer lista direct:';
    const content = `${a}\n\n${b}\n\nIată ce e real acum.`;
    const p = timeline(content, [tool('notebook', a.length), tool('list_skills', a.length + 2 + b.length)]);
    expect(shape(p)).toEqual([a, 'notebook', b, 'list_skills', 'Iată ce e real acum.']);
  });

  it('groups tools called back to back, and one called before any text comes first', () => {
    const p = timeline('Gata.', [tool('web_search', 0), tool('fetch_url', 0)]);
    expect(shape(p)).toEqual(['web_search+fetch_url', 'Gata.']);
  });

  it('keeps the old layout for a reply saved without positions', () => {
    expect(timeline('Salut', [tool('web_search')])).toBeNull();
    expect(timeline('Salut', [])).toBeNull();
  });

  it('survives a final text shorter than the offsets it was cut at', () => {
    expect(shape(timeline('Scurt.', [tool('web_search', 40)]))).toEqual(['Scurt.', 'web_search']);
  });
});
