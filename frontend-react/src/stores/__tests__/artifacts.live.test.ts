import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ op: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { artifacts: { op: mocks.op } } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
import { useArtifacts, resetArtifactRequests } from '../artifacts';

/**
 * Live writing (17 Oct): the panel opens the moment Cinderpaw starts a
 * document, fills in as it writes, becomes the saved version without a jump,
 * and says so in a sentence when the document never gets saved.
 */
const draft = (append: string, more: Partial<{ draft: string; kind: string; title: string; onScreen: boolean; id: string }> = {}) =>
  useArtifacts.getState().onDraft({ id: 'turn-1', sessionId: 's1', draft: '0:0', append, onScreen: true, ...more });
const idOf = (action: string) => mocks.op.mock.calls.find((c) => c[1] === action)![0] as string;
const saved = { id: 'art-1', kind: 'markdown', title: 'Plan', version: 1, bytes: 12, updatedAt: 0, modifiedBy: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  resetArtifactRequests();
  mocks.op.mockResolvedValue(undefined);
  useArtifacts.setState({ panelOpen: false, open: null, rows: [], busy: false, error: null, editing: null, conflict: null, review: null });
});

describe('a document being written', () => {
  it('opens the panel on an empty document with its title', () => {
    draft('', { title: 'Plan' });
    const s = useArtifacts.getState();
    expect(s.panelOpen).toBe(true);
    expect(s.panelTab).toBe('artifacts');
    expect(s.open?.row.title).toBe('Plan');
    expect(s.open?.content).toBe('');
    expect(s.open?.live?.writing).toBeTruthy();
  });

  it('keeps the same row while only the text grows, so the panel header is not redrawn', () => {
    draft('# Pl', { title: 'Plan' });
    const row = useArtifacts.getState().open!.row;
    draft('an');
    expect(useArtifacts.getState().open!.row).toBe(row);
    draft('', { title: 'Plan B' });
    expect(useArtifacts.getState().open!.row).not.toBe(row);
    expect(useArtifacts.getState().open!.row.title).toBe('Plan B');
  });

  it('adds each piece where the last one ended, as its own run', () => {
    draft('# Pl', { title: 'Plan' });
    draft('an\nDay one.');
    const open = useArtifacts.getState().open!;
    expect(open.content).toBe('# Plan\nDay one.');
    expect(open.live!.runs.at(-1)).toMatchObject({ from: 4, to: 15 });
  });

  it('ignores a document written in a chat that is not on screen', () => {
    draft('Hello', { onScreen: false });
    expect(useArtifacts.getState().open).toBeNull();
    expect(useArtifacts.getState().panelOpen).toBe(false);
  });

  it('leaves the person typing in another artifact alone', () => {
    const other = { row: { ...saved, id: 'mine' }, content: 'my words', showing: 1, versions: [] };
    useArtifacts.setState({ open: other, editing: { draft: 'my words and more', base: 1 } });
    draft('Hello');
    expect(useArtifacts.getState().open).toBe(other);
    expect(useArtifacts.getState().editing?.draft).toBe('my words and more');
  });

  it('does not come back after the person went back to the list', () => {
    draft('Hello');
    useArtifacts.getState().close();
    draft(' world');
    expect(useArtifacts.getState().open).toBeNull();
  });

  it('stays shut after the person closed the panel', () => {
    draft('Hello');
    useArtifacts.setState({ panelOpen: false });
    draft(' world');
    expect(useArtifacts.getState().panelOpen).toBe(false);
    expect(useArtifacts.getState().open?.content).toBe('Hello world');
  });

  it('takes the content before the title, and an app', () => {
    draft('<html>', { kind: 'app' });
    draft('', { kind: 'app', title: 'Timer' });
    const open = useArtifacts.getState().open!;
    expect(open.row).toMatchObject({ kind: 'app', title: 'Timer' });
    expect(open.content).toBe('<html>');
  });

  it('a second draft in the same turn starts a new document', () => {
    draft('First');
    draft('Second', { draft: '1:0' });
    expect(useArtifacts.getState().open?.content).toBe('Second');
  });
});

describe('when the call ends', () => {
  it('writes in the date and name the engine put under the title', async () => {
    draft('# Plan\n\nDay one.', { title: 'Plan' });
    useArtifacts.getState().endDraft('turn-1', { artifactId: 'art-1' });
    await Promise.resolve();
    const dated = '# Plan\n\n_20 octombrie 2026 la 16:20 · Darius_\n\nDay one.';
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved }], content: dated });
    const open = useArtifacts.getState().open!;
    expect(open.content).toBe(dated);
    const line = dated.indexOf('_20');
    // The draft's own letters are paced, so they may still be arriving: they
    // keep going beside the date line.
    const dateRun = open.live!.runs.find((r) => r.from === line)!;
    expect(dateRun).toBeTruthy();
    expect(dated.slice(dateRun.from, dateRun.to)).toContain('Darius');
  });

  it('text the save adds after the draft is written after it, not all at once ahead of it', async () => {
    draft('# Plan\n\nSection one is being written slowly.', { title: 'Plan' });
    useArtifacts.getState().endDraft('turn-1', { artifactId: 'art-1' });
    await Promise.resolve();
    const full = '# Plan\n\nSection one is being written slowly.\n\n## Two\n\nSection two came only with the save.';
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved }], content: full });
    const runs = useArtifacts.getState().open!.live!.runs;
    const two = runs.find((r) => full.slice(r.from, r.to).includes('Section two'))!;
    const one = runs.find((r) => full.slice(r.from, r.to).includes('Section one'))!;
    // Section two starts where section one's letters stop.
    expect(two.at).toBeGreaterThanOrEqual(one.at + Math.round((one.to - one.from) * one.per) - 1);
  });

  it('becomes the saved artifact and keeps the letters still arriving', async () => {
    draft('Hello', { title: 'Plan' });
    const runs = useArtifacts.getState().open!.live!.runs;
    useArtifacts.getState().endDraft('turn-1', { artifactId: 'art-1' });
    await Promise.resolve();
    expect(mocks.op).toHaveBeenCalledWith(expect.any(String), 'get', { artifactId: 'art-1' });
    // The draft stays on screen until the saved one arrives: no blank.
    expect(useArtifacts.getState().open?.content).toBe('Hello');
    useArtifacts.getState().endDraft('turn-1', { reason: 'Cinderpaw stopped before saving this.' });
    expect(useArtifacts.getState().open?.live?.stopped).toBeUndefined();
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved }], content: 'Hello' });
    const open = useArtifacts.getState().open!;
    expect(open.row.id).toBe('art-1');
    expect(open.live?.runs).toEqual(runs);
    expect(open.live?.writing).toBeUndefined();
  });

  it('brings in the whole text at once when none of it could be shown while written', async () => {
    draft('');
    useArtifacts.getState().endDraft('turn-1', { artifactId: 'art-1' });
    await Promise.resolve();
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved }], content: 'All of it' });
    expect(useArtifacts.getState().open?.live?.runs).toEqual([expect.objectContaining({ from: 0, to: 9 })]);
  });

  it('says so in a sentence when the save was refused, and keeps the text', () => {
    draft('Hello');
    useArtifacts.getState().endDraft('turn-1', { reason: "Not saved. artifact_create: 'title' is required." });
    const open = useArtifacts.getState().open!;
    expect(open.live?.stopped).toMatch(/^Not saved/);
    expect(open.live?.writing).toBeUndefined();
    expect(open.content).toBe('Hello');
  });

  it('says so when the turn ends before anything was saved', () => {
    draft('Hello');
    useArtifacts.getState().endDraft('turn-1', { reason: 'Cinderpaw stopped before saving this.' });
    expect(useArtifacts.getState().open?.live?.stopped).toBe('Cinderpaw stopped before saving this.');
  });

  it('ignores the end of another turn', () => {
    draft('Hello');
    useArtifacts.getState().endDraft('turn-2', { reason: 'x' });
    expect(useArtifacts.getState().open?.live?.writing).toBeTruthy();
  });
});

describe('an edit by Cinderpaw to the document on screen', () => {
  const v1 = { row: { ...saved }, content: 'Seven days, one clear message.', showing: 1, versions: [] };

  it('takes the old words out, then brings the new ones in', async () => {
    useArtifacts.setState({ open: v1 });
    useArtifacts.getState().onEvent({ id: 'art-1', action: 'updated', version: 2, onScreen: true });
    await Promise.resolve();
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved, version: 2 }], content: 'Fourteen days, one clear message.' });
    const live = useArtifacts.getState().open!.live!;
    expect(live.out?.content).toBe(v1.content);
    expect(live.out?.ranges).toEqual([[0, 5]]);
    expect(live.runs).toEqual([expect.objectContaining({ from: 0, to: 8 })]);
    expect(live.runs[0]!.at).toBe(live.out!.until);
  });

  it('a save the person made does not animate', async () => {
    useArtifacts.setState({ open: v1 });
    useArtifacts.getState().startEdit();
    useArtifacts.getState().setDraft('Mine now.');
    await useArtifacts.getState().save();
    useArtifacts.getState().onResult({ id: idOf('write'), ok: true, items: [{ ...saved, version: 2 }], content: 'Mine now.' });
    expect(useArtifacts.getState().open?.live).toBeUndefined();
  });
});

describe('a part written in place over its placeholder (drafted in parts)', () => {
  const outline = '# Dinners\n\n## Pasta\n\n[[Pasta: 3 ingredients]]\n\n## Soup\n\n[[Soup: 2 steps]]';
  const v1 = { row: { ...saved }, content: outline, showing: 1, versions: [] };
  const part = (append: string, draft = '1:0') =>
    useArtifacts.getState().onDraft({ id: 'turn-2', sessionId: 's1', draft, append, editOf: 'art-1', find: '[[Pasta: 3 ingredients]]', onScreen: true });

  it('takes the placeholder out, then writes the part where it was, letter by letter', () => {
    useArtifacts.setState({ open: v1 });
    part('Garlic, oil');
    part(', chili.');
    const open = useArtifacts.getState().open!;
    const at = outline.indexOf('[[Pasta');
    expect(open.content).toBe(outline.replace('[[Pasta: 3 ingredients]]', 'Garlic, oil, chili.'));
    expect(open.live!.out).toMatchObject({ content: outline, ranges: [[at, at + 24]] });
    expect(open.live!.runs.at(-1)).toMatchObject({ from: at + 11, to: at + 19 });
    expect(open.live!.writing).toBeTruthy();
  });

  it('keeps the part when the save of the part before it arrives meanwhile', async () => {
    useArtifacts.setState({ open: v1 });
    part('Garlic');
    useArtifacts.getState().onEvent({ id: 'art-1', action: 'updated', version: 1, onScreen: true });
    await Promise.resolve();
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved }], content: outline });
    expect(useArtifacts.getState().open!.content).toContain('Garlic');
  });

  it('keeps the part on top of a save whose text above it differs from what was shown', async () => {
    useArtifacts.setState({ open: v1 });
    part('Garlic');
    part(', oil');
    useArtifacts.getState().onEvent({ id: 'art-1', action: 'updated', version: 2, onScreen: true });
    await Promise.resolve();
    // The part before it was saved a few letters longer than it was shown.
    const saved2 = outline.replace('# Dinners', '# Dinners for two');
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved, version: 2 }], content: saved2 });
    const open = useArtifacts.getState().open!;
    expect(open.content).toBe(saved2.replace('[[Pasta: 3 ingredients]]', 'Garlic, oil'));
    expect(open.row.version).toBe(2);
    part(', chili.');
    expect(useArtifacts.getState().open!.content).toBe(saved2.replace('[[Pasta: 3 ingredients]]', 'Garlic, oil, chili.'));
  });

  it('goes back to the saved document when the part was never saved', () => {
    useArtifacts.setState({ open: v1 });
    part('Garlic');
    useArtifacts.getState().endDraft('turn-2', { reason: 'Not saved.' });
    expect(useArtifacts.getState().open!.content).toBe(outline);
    expect(useArtifacts.getState().open!.live).toBeUndefined();
  });

  it('becomes the saved version without a jump', async () => {
    useArtifacts.setState({ open: v1 });
    part('Garlic, oil, chili.');
    useArtifacts.getState().endDraft('turn-2', { artifactId: 'art-1' });
    useArtifacts.getState().onEvent({ id: 'art-1', action: 'updated', version: 2, onScreen: true });
    await Promise.resolve();
    const final = outline.replace('[[Pasta: 3 ingredients]]', 'Garlic, oil, chili.');
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [{ ...saved, version: 2 }], content: final });
    const open = useArtifacts.getState().open!;
    expect(open.content).toBe(final);
    expect(open.live?.out).toBeUndefined();
  });
});
