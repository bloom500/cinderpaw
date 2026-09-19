import { act, cleanup, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { events } from '@/lib/tauri/events';
import * as artifacts from '@/lib/callArtifacts';
import { useLiveToolActivity, hitsOf, subjectOf, kindOf, filesOf, factsOf, startActivity, finishActivity } from '../useLiveToolActivity';

describe('voice tool activity', () => {
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

  it('subscribes to both call channels, records artifacts and expires rows after six seconds', async () => {
    const { result } = renderHook(() => useLiveToolActivity(true));
    await act(async () => {});
    act(() => emit({ type: 'tool_start', tool: 'read_file', args: { path: 'voice.txt' } }));
    expect(result.current[0]).toMatchObject({ kind: 'files', subject: 'voice.txt', status: 'running' });
    act(() => emit({ type: 'tool_done', tool: 'read_file', result: { ok: true, data: { path: 'voice.txt' } } }));
    expect(artifacts.recordArtifact).toHaveBeenCalled();
    expect(events.liveStatusEvent.listen).toHaveBeenCalledOnce();
    expect(events.liveKitEvent.listen).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(7000));
    expect(result.current).toEqual([]);
  });

  it('closes the row a result belongs to, and ignores tools from another conversation', async () => {
    let worker: (e: unknown) => void = () => {};
    vi.mocked(events.liveKitEvent.listen).mockImplementation((cb) => {
      worker = cb as (e: unknown) => void;
      return Promise.resolve(vi.fn());
    });
    const { result } = renderHook(() => useLiveToolActivity(true, 'chat-1'));
    await act(async () => {});
    // Astra, 19 Sep 2026: rows matched results by tool NAME, and the panel
    // showed every tool the sidecar ran for anyone.
    act(() => worker({ kind: 'toolCall', id: 'v-1', session: 'v', text: 'weather' }));
    act(() => worker({ kind: 'toolResult', id: 'v-0', session: 'v', text: '' }));
    expect(result.current[0]).toMatchObject({ id: 'v-1', status: 'running' });
    act(() => worker({ kind: 'toolResult', id: 'v-1', session: 'v', pending: true, text: '' }));
    expect(result.current[0]).toMatchObject({ status: 'running', note: 'taking longer than usual' });
    act(() => worker({ kind: 'toolLate', id: 'v-1', session: 'v', text: 'sunny' }));
    expect(result.current[0]).toMatchObject({ id: 'v-1', status: 'done' });

    act(() => emit({ type: 'tool_start', tool: 'shell', sessionId: 'cron-9' }));
    expect(result.current.some((a) => a.tool === 'shell')).toBe(false);
    act(() => emit({ type: 'tool_start', tool: 'shell', sessionId: 'chat-1' }));
    expect(result.current.some((a) => a.tool === 'shell')).toBe(true);
  });

  it('caps rows at six and releases a subscription that resolves after unmount', async () => {
    const { result, unmount } = renderHook(() => useLiveToolActivity(true));
    act(() => {
      for (let i = 0; i < 8; i++) emit({ type: 'tool_start', tool: `tool_${i}` });
    });
    expect(result.current).toHaveLength(6);
    expect(result.current[0].tool).toBe('tool_2');
    unmount();
    let resolve!: (off: () => void) => void;
    vi.mocked(events.cinderpawAgentOutputEvent.listen).mockReturnValue(new Promise((r) => { resolve = r; }));
    const late = renderHook(() => useLiveToolActivity(true));
    late.unmount();
    const off = vi.fn();
    await act(async () => resolve(off));
    expect(off).toHaveBeenCalledOnce();
  });
});

describe('desktop activity', () => {
  const button = { id: 'el-save', role: 'Button', name: 'Save', bounding_rect: { x: 10, y: 40, width: 80, height: 24 } };
  const field = { id: 'el-text', role: 'Edit', name: 'Text Editor', bounding_rect: { x: 0, y: 70, width: 400, height: 300 } };

  it('names the app behind a pid from an earlier list_windows, and lights the clicked element on the last tree', () => {
    const list = finishActivity(startActivity('computer_use', { action: 'list_windows' }), {
      ok: true, data: [{ pid: 42, title: 'Untitled - Notepad', app_name: 'notepad.exe' }, { pid: 7, title: '', app_name: 'explorer.exe' }],
    });
    expect(list.kind).toBe('desktop');
    expect(list.desktop).toMatchObject({ action: 'list_windows', windows: [{ pid: 42, app: 'notepad.exe' }, { pid: 7 }] });

    const tree = finishActivity(startActivity('computer_use', { action: 'get_tree', pid: 42 }), {
      ok: true, data: { id: 'root', role: 'Window', name: 'Untitled - Notepad', bounding_rect: { x: 0, y: 0, width: 400, height: 370 }, children: [button, field] },
    });
    expect(tree.desktop).toMatchObject({ app: 'notepad.exe', windowTitle: 'Untitled - Notepad' });
    expect(tree.desktop?.elements.map((e) => e.id)).toEqual(['root', 'el-save', 'el-text']);

    const click = startActivity('control_app', { action: 'click', pid: 42, element_id: 'el-save' });
    expect(click.desktop).toMatchObject({ app: 'notepad.exe', target: { name: 'Save', x: 10, w: 80 } });
    expect(click.desktop?.elements).toHaveLength(3);
  });

  it('never carries the typed text, because it may be a password', () => {
    const typed = startActivity('computer_use', { action: 'type', pid: 42, element_id: 'el-text', text: 'hunter2' });
    expect(JSON.stringify(typed)).not.toContain('hunter2');
    expect(typed.subject).toBe('');
  });

  it('shows the app being launched, and survives a result with no data', () => {
    const a = finishActivity(startActivity('computer_use', { action: 'launch', app: 'calc.exe' }), { ok: true });
    expect(a.desktop).toMatchObject({ action: 'launch', app: 'calc.exe', windows: [], elements: [] });
    expect(a.subject).toBe('calc.exe');
    expect(startActivity('computer_use', undefined).desktop).toBeNull();
  });

  it('ends a failed step with the reason, not an empty layout', () => {
    const a = finishActivity(startActivity('computer_use', { action: 'click', pid: 1, element_id: 'nope' }), { ok: false, content: 'element not found' });
    expect(a).toMatchObject({ status: 'failed', error: 'element not found' });
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
