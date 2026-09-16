import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactsPanel } from '../ArtifactsPanel';
import { useArtifacts, resetArtifactRequests, type ArtifactRow } from '@/stores/artifacts';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
import { tauri } from '@/lib/tauri';

/**
 * The panel is where the store stops being a capability of the agent's and
 * starts being a place of the user's. These pin the parts that are easy to get
 * wrong in a way nobody notices by clicking around: the sandbox flags, the
 * three-state list, and two replies racing each other.
 */

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauri: { ...actual.tauri, artifacts: { op: vi.fn().mockResolvedValue(undefined) } },
  };
});

const op = tauri.artifacts.op as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 'a1', kind: 'markdown', title: 'Q3 report', version: 2,
    bytes: 120, updatedAt: Date.now(), modifiedBy: 'chat', ...over,
  };
}

/** The request id the store minted for the Nth call, so a test can answer it. */
const idOfCall = (n: number) => op.mock.calls[n]![0] as string;

/**
 * The id of the request for a given action.
 *
 * By index is a trap: mounting the panel fires a `list` of its own, so the
 * export a test just triggered is never call 0. Asking by action says what the
 * test means and does not move when the component's mount changes.
 */
function idOfAction(action: string): string {
  const call = op.mock.calls.find((c) => c[1] === action);
  if (!call) throw new Error(`no ${action} request was made`);
  return call[0] as string;
}

beforeEach(() => {
  resetArtifactRequests();
  op.mockClear();
  useArtifacts.setState({
    rows: [], loaded: false, open: null, busy: false, error: null, lastExport: null,
  });
});
afterEach(cleanup);

describe('the list', () => {
  it('does not say "nothing here" before the first read comes back', () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    // The mistake this pins: the fresh-install sentence shown to someone with a
    // dozen artifacts, because "empty" and "not asked yet" looked the same.
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  it('says what to do about an empty workspace, not that it is empty', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: true, items: [] });
    expect(await screen.findByText(/Ask Cinderpaw to write something up/)).toBeInTheDocument();
  });

  it('lists what exists and opens one on click', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: true, items: [row()] });

    fireEvent.click(await screen.findByText('Q3 report'));
    await waitFor(() => expect(op).toHaveBeenCalledTimes(3)); // list, get, versions
    expect(op.mock.calls[1]![1]).toBe('get');
    expect(op.mock.calls[2]![1]).toBe('versions');
  });
});

describe('the viewer', () => {
  it('runs an app with scripts but WITHOUT our origin', () => {
    // The security boundary. This webview can call invoke(); an artifact that
    // shared our origin would be a stored-XSS primitive pointed at the Tauri
    // command surface, and the HTML is model-written, sometimes from a page the
    // agent read or a file a stranger sent on a chat platform.
    useArtifacts.setState({
      loaded: true,
      open: {
        row: row({ kind: 'app', title: 'Revenue' }),
        content: '<html><body>chart</body></html>',
        showing: 2,
        versions: [],
      },
    });
    const { container } = render(<ArtifactsPanel onClose={() => {}} />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe(APP_IFRAME_SANDBOX);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('chart');
  });

  it('says out loud when an older version is on screen', () => {
    useArtifacts.setState({
      loaded: true,
      open: {
        row: row({ version: 5 }),
        content: 'old text',
        showing: 2,
        versions: [
          { version: 5, author: 'chat', note: null, createdAt: 2 },
          { version: 2, author: 'user', note: null, createdAt: 1 },
        ],
      },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    // An old version looks exactly like the current one, and acting on it is
    // acting on the wrong thing.
    expect(screen.getByText(/Showing v2\. The current version is v5\./)).toBeInTheDocument();
  });

  it('exports and reports where the file went', async () => {
    useArtifacts.setState({
      loaded: true,
      open: { row: row(), content: 'text', showing: 2, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(op).toHaveBeenCalled());

    useArtifacts.getState().onResult({
      id: idOfAction('export'), ok: true, path: 'D:/work/Q3 report.md', note: '',
    });
    expect(await screen.findByText(/D:\/work\/Q3 report\.md/)).toBeInTheDocument();
  });
});

describe('the request pairing', () => {
  it('a stale reply cannot overwrite what the panel is showing', async () => {
    // Two requests in flight, answered out of order. Without ids, the list's
    // empty `content` would land on top of the open document — intermittently,
    // and only on machines slow enough to interleave them.
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    const listId = idOfCall(0);

    useArtifacts.getState().onResult({ id: listId, ok: true, items: [row()] });
    fireEvent.click(await screen.findByText('Q3 report'));
    await waitFor(() => expect(op).toHaveBeenCalledTimes(3));

    useArtifacts.getState().onResult({
      id: idOfCall(1), ok: true, items: [row()], content: 'the document',
    });
    // The list reply arrives late, carrying no content at all.
    useArtifacts.getState().onResult({ id: listId, ok: true, items: [] });

    expect(useArtifacts.getState().open?.content).toBe('the document');
  });

  it('an error is shown rather than left as a spinner', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: false, error: 'no workspace folder' });
    expect(await screen.findByText('no workspace folder')).toBeInTheDocument();
    // `loaded` flips even on failure, or the panel says "loading" forever.
    expect(useArtifacts.getState().loaded).toBe(true);
  });
});
