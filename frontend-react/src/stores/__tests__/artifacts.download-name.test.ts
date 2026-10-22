import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ op: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { artifacts: { op: mocks.op } } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
import { useArtifacts, resetArtifactRequests } from '../artifacts';

/**
 * 6 Oct: four takes of a job-application video, and the CSV the agent made
 * kept arriving as job-application-workflow-test.csv.bin, or as a PDF when it
 * was a table. The save dialog's suggested name is what a person keeps.
 */
const suggested = () => mocks.save.mock.calls[0][0] as { defaultPath: string; filters: { name: string; extensions: string[] }[] };

beforeEach(() => {
  vi.clearAllMocks();
  resetArtifactRequests();
  mocks.op.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(null);
  useArtifacts.setState({ open: null, rows: [], busy: false, error: null });
});

describe('the name the save dialog suggests', () => {
  it('a CSV file keeps .csv instead of turning into .csv.bin', async () => {
    await useArtifacts.getState().exportArtifact('f1', { row: { title: 'job-application-workflow-test.csv', kind: 'file' } });
    expect(suggested().defaultPath).toBe('job-application-workflow-test.csv');
    expect(suggested().filters[0].extensions).toEqual(['csv']);
  });

  it('a table leaves as an Excel sheet, not as a PDF or raw JSON', async () => {
    await useArtifacts.getState().exportArtifact('t1', { row: { title: 'Roofers in Manchester', kind: 'table' } });
    expect(suggested().defaultPath).toBe('Roofers in Manchester.xlsx');
    expect(suggested().filters).toEqual([{ name: 'Excel', extensions: ['xlsx'] }]);
  });

  it('writing leaves as a PDF first, with Word and its own format still offered', async () => {
    await useArtifacts.getState().exportArtifact('m1', { row: { title: 'Week plan', kind: 'markdown' } });
    expect(suggested().defaultPath).toBe('Week plan.pdf');
    expect(suggested().filters.map((f) => f.name)).toEqual(['PDF', 'Word', 'Markdown text']);
  });

  it('a script keeps its own type', async () => {
    await useArtifacts.getState().exportArtifact('c1', { row: { title: 'scrape.py', kind: 'code' } });
    expect(suggested().defaultPath).toBe('scrape.py');
  });
});
