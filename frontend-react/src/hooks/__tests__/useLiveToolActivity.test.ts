import { act, cleanup, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { events } from '@/lib/tauri/events';
import * as artifacts from '@/lib/callArtifacts';
import { useLiveToolActivity, hitsOf, subjectOf, kindOf, filesOf, factsOf } from '../useLiveToolActivity';

describe('chat tool activity', () => {
  let emit: (line: unknown) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(events.cinderpawAgentOutputEvent, 'listen').mockImplementation((cb) => {
      emit = (line) => cb({ payload: { data: JSON.stringify(line) } } as Parameters<typeof cb>[0]);
      return Promise.resolve(vi.fn());
    });
    vi.spyOn(events.liveStatusEvent, 'listen').mockResolvedValue(vi.fn());
    vi.spyOn(events.liveKitEvent, 'listen').mockResolvedValue(vi.fn());
    vi.spyOn(artifacts, 'recordArtifact').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('shows only scoped tool events, keeps completed results, and leaves call artifacts alone', () => {
    const { result } = renderHook(() => useLiveToolActivity(true, 'chat-a'));
    act(() => {
      emit({ type: 'tool_start', tool: 'web_search', sessionId: 'chat-b', args: { query: 'other chat' } });
      emit({ type: 'tool_start', tool: 'web_search', args: { query: 'unattributed' } });
      emit(null);
    });
    expect(result.current).toEqual([]);
    act(() => emit({ type: 'tool_start', tool: 'web_search', sessionId: 'chat-a', args: { query: 'Bucharest' } }));
    expect(result.current[0]).toMatchObject({ kind: 'browser', subject: 'Bucharest', status: 'running' });
    act(() => emit({ type: 'tool_progress', tool: 'web_search', sessionId: 'chat-a', message: 'Fetching results' }));
    expect(result.current[0].note).toBe('Fetching results');
    act(() => emit({ type: 'tool_done', tool: 'web_search', sessionId: 'chat-b', result: { ok: false } }));
    expect(result.current[0].status).toBe('running');
    act(() => emit({ type: 'tool_done', tool: 'web_search', sessionId: 'chat-a', result: {
      ok: true, data: [{ text: 'Bucharest — city guide', url: 'https://example.com/guide' }],
    } }));
    expect(result.current[0]).toMatchObject({ status: 'done', hits: [{ title: 'Bucharest', url: 'https://example.com/guide' }] });
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current).toHaveLength(1);
    expect(artifacts.recordArtifact).not.toHaveBeenCalled();
    expect(events.liveStatusEvent.listen).not.toHaveBeenCalled();
    expect(events.liveKitEvent.listen).not.toHaveBeenCalled();
  });

  it('clears activity on session switches and ignores callbacks from the old subscription', () => {
    const { result, rerender } = renderHook(({ session }) => useLiveToolActivity(true, session), { initialProps: { session: 'a' } });
    act(() => emit({ type: 'tool_start', sessionId: 'a', tool: 'read_file', args: { path: 'a.txt' } }));
    const stale = emit;
    rerender({ session: 'b' });
    expect(result.current).toEqual([]);
    act(() => stale({ type: 'tool_start', sessionId: 'a', tool: 'read_file', args: { path: 'old.txt' } }));
    expect(result.current).toEqual([]);
  });

  it('retains the voice subscriptions, artifact recording and six-second expiry', async () => {
    const { result } = renderHook(() => useLiveToolActivity(true));
    await act(async () => {});
    act(() => emit({ type: 'tool_start', tool: 'read_file', args: { path: 'voice.txt' } }));
    act(() => emit({ type: 'tool_done', tool: 'read_file', result: { ok: true, data: { path: 'voice.txt' } } }));
    expect(artifacts.recordArtifact).toHaveBeenCalled();
    expect(events.liveStatusEvent.listen).toHaveBeenCalledOnce();
    expect(events.liveKitEvent.listen).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(7000));
    expect(result.current).toEqual([]);
  });

  it('caps retained chat cards at six and releases late subscriptions', async () => {
    const { result, unmount } = renderHook(() => useLiveToolActivity(true, 'chat'));
    act(() => {
      for (let i = 0; i < 8; i++) emit({ type: 'tool_start', sessionId: 'chat', tool: `tool_${i}` });
    });
    expect(result.current).toHaveLength(6);
    expect(result.current[0].tool).toBe('tool_2');
    unmount();
    let resolve!: (off: () => void) => void;
    vi.mocked(events.cinderpawAgentOutputEvent.listen).mockReturnValue(new Promise((r) => { resolve = r; }));
    const late = renderHook(() => useLiveToolActivity(true, 'next'));
    late.unmount();
    const off = vi.fn();
    await act(async () => resolve(off));
    expect(off).toHaveBeenCalledOnce();
  });
});

describe('kindOf', () => {
  it('routes each tool to the widget for its category, not its name', () => {
    expect(kindOf('web_search')).toBe('browser');
    expect(kindOf('read_webpage')).toBe('browser');
    expect(kindOf('write_file')).toBe('files');
    expect(kindOf('shell_exec')).toBe('terminal');
    expect(kindOf('recall')).toBe('memory');
  });

  it('matches suffixed variants, so a new tool joins its family for free', () => {
    expect(kindOf('web_search_news')).toBe('browser');
  });

  it('falls back rather than guessing a widget for an unknown tool', () => {
    expect(kindOf('capture_lead')).toBe('generic');
  });
});

describe('filesOf', () => {
  it('reads the single-file shape read_file and write_file return', () => {
    expect(filesOf({ data: { path: 'D:/a/b.ts', lines: 42, bytes: 900 } })).toEqual([
      { path: 'D:/a/b.ts', lines: 42, bytes: 900 },
    ]);
  });

  it('reads the array shape list_directory returns', () => {
    const files = filesOf({ data: [{ name: 'x.ts', size: 10 }, { path: 'y.ts' }] });
    expect(files.map((f) => f.path)).toEqual(['x.ts', 'y.ts']);
    expect(files[0].bytes).toBe(10);
    expect(files[1].lines).toBeNull();
  });
});

describe('factsOf', () => {
  it('reads memory facts whether they are strings or objects', () => {
    expect(factsOf({ data: { facts: ['speaks Romanian', { text: 'builds Cinderpaw' }] } })).toEqual([
      'speaks Romanian',
      'builds Cinderpaw',
    ]);
  });

  it('falls back to hits when there are no facts', () => {
    expect(factsOf({ data: { hits: [{ text: 'a note' }] } })).toEqual(['a note']);
  });

  it('is empty for a tool with no memory in it', () => {
    expect(factsOf({ data: { path: 'x' } })).toEqual([]);
  });
});

/**
 * These two parse another process's output, which is the only reason they are
 * worth testing: the sidecar can change a field name in a release and this must
 * dim the panel, never throw inside an event handler during a live call.
 */
describe('subjectOf', () => {
  it('prefers the query, because that is what proves the search is real', () => {
    expect(subjectOf({ path: '/tmp/x', query: 'ce este Cinderpaw' })).toBe('ce este Cinderpaw');
  });

  it('falls back through the other argument names', () => {
    expect(subjectOf({ url: 'https://example.com' })).toBe('https://example.com');
    expect(subjectOf({ command: 'ls -la' })).toBe('ls -la');
  });

  it('is empty rather than wrong when there is nothing to show', () => {
    expect(subjectOf(undefined)).toBe('');
    expect(subjectOf({ depth: 3 })).toBe('');
    expect(subjectOf({ query: '   ' })).toBe('');
  });
});

describe('hitsOf', () => {
  it('reads the DuckDuckGo shape, splitting the title off the snippet', () => {
    const hits = hitsOf({
      ok: true,
      data: [{ text: 'Cinderpaw AI — a local agent runtime', url: 'https://www.example.com/docs/cinderpaw' }],
    });
    expect(hits).toEqual([
      {
        title: 'Cinderpaw AI',
        url: 'https://www.example.com/docs/cinderpaw',
        host: 'example.com',
        snippet: 'a local agent runtime',
        crumbs: 'docs › cinderpaw',
      },
    ]);
  });

  it('keeps an em-dash inside the snippet instead of losing the tail', () => {
    // "a — b — c" is one title and a snippet that itself contains a dash, not
    // three fields. Splitting on every dash silently truncated abstracts.
    const [hit] = hitsOf({ data: [{ text: 'T — one — two', url: 'https://x.dev' }] });
    expect(hit.title).toBe('T');
    expect(hit.snippet).toBe('one — two');
  });

  it('reads the SearXNG shape too', () => {
    const hits = hitsOf({ data: [{ title: 'Docs', url: 'https://docs.rs/x' }] });
    expect(hits[0]).toMatchObject({ title: 'Docs', host: 'docs.rs' });
  });

  it('drops rows it cannot use instead of rendering blanks', () => {
    const hits = hitsOf({
      data: [
        { text: 'no url here' },
        { url: 'https://ok.dev/a', text: 'Kept' },
        null,
        'not an object',
        { url: 'not a url', text: 'Bad host' },
      ],
    });
    // The malformed URL is kept — the title is real and useful — but with no
    // host, which is what the panel renders as a title-only row.
    expect(hits.map((h) => h.title)).toEqual(['Kept', 'Bad host']);
    expect(hits[1].host).toBe('');
  });

  it('returns nothing for a tool that has no results at all', () => {
    expect(hitsOf({ ok: true, content: 'wrote 12 lines' })).toEqual([]);
    expect(hitsOf(null)).toEqual([]);
    expect(hitsOf({ data: 'not an array' })).toEqual([]);
  });
});
