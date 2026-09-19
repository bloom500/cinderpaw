import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ op: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { artifacts: { op: mocks.op } } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
import { useArtifacts, resetArtifactRequests } from '../artifacts';

/**
 * Three defects from Astra's pre-release review of 19 Sep 2026, each with
 * the reply order or the state that produced it. The panel talks to the
 * sidecar through numbered requests whose answers arrive whenever they
 * arrive, so every one of these is about an answer landing at the wrong
 * moment.
 */
const row = { id: 'report-a', kind: 'markdown' as const, title: 'Report', version: 2, bytes: 10, updatedAt: 0, modifiedBy: 'user' as const };
const idOf = (action: string) => mocks.op.mock.calls.find((c) => c[1] === action)![0] as string;

beforeEach(() => {
  vi.clearAllMocks();
  resetArtifactRequests();
  mocks.op.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue('D:/somewhere/Report.md');
  useArtifacts.setState({ open: null, rows: [row], busy: false, error: null, editing: null, conflict: null, review: null, google: null });
});

describe('answers that arrive at the wrong moment', () => {
  it('exports the version on screen, not the newest one', async () => {
    useArtifacts.setState({ open: { row, content: 'OLD V1', showing: 1, versions: [] } });
    await useArtifacts.getState().exportArtifact(row.id);
    expect(mocks.op).toHaveBeenCalledWith(expect.any(String), 'export', { artifactId: row.id, version: 1, dest: 'D:/somewhere/Report.md' });
    // Looking at the newest version sends no version: the current one it is.
    mocks.op.mockClear();
    useArtifacts.setState({ open: { row, content: 'NEW V2', showing: 2, versions: [] } });
    await useArtifacts.getState().exportArtifact(row.id);
    expect(mocks.op.mock.calls[0][2]).not.toHaveProperty('version');
  });

  it('a get that answers after close does not reopen the document', async () => {
    await useArtifacts.getState().openArtifact(row.id);
    const getId = idOf('get');
    useArtifacts.getState().close();
    useArtifacts.getState().onResult({ id: getId, ok: true, items: [row], content: 'LATE' });
    expect(useArtifacts.getState().open).toBeNull();
    expect(useArtifacts.getState().busy).toBe(false);
  });

  it('keeps a history that arrived before the content', async () => {
    await useArtifacts.getState().openArtifact(row.id);
    const versions = [{ version: 1, author: 'user', note: null, createdAt: 0 }];
    // A PDF's `get` waits for field parsing; `versions` does not, and used to
    // be thrown away for landing first.
    useArtifacts.getState().onResult({ id: idOf('versions'), ok: true, versions });
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [row], content: 'LATEST' });
    expect(useArtifacts.getState().open?.versions).toEqual(versions);
  });

  it('and the usual order still works', async () => {
    await useArtifacts.getState().openArtifact(row.id);
    const versions = [{ version: 1, author: 'user', note: null, createdAt: 0 }];
    useArtifacts.getState().onResult({ id: idOf('get'), ok: true, items: [row], content: 'LATEST' });
    useArtifacts.getState().onResult({ id: idOf('versions'), ok: true, versions });
    expect(useArtifacts.getState().open?.versions).toEqual(versions);
  });
});
