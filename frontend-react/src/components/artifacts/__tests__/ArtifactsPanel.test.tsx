import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactsPanel } from '../ArtifactsPanel';
import { summaryOf } from '@/lib/artifactSections';
import { useArtifacts, resetArtifactRequests, googlePlan, shownKind, type ArtifactRow } from '@/stores/artifacts';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
import { tauri } from '@/lib/tauri';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useNotifications } from '@/stores/notifications';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { projectPrompt } from '@/lib/projectPrompt';

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
// The done toast's Open goes to the chat through the app router, which imports
// every page; the test only needs to know it was asked.
const navigate = vi.fn();
vi.mock('@/router', () => ({ router: { state: { location: { pathname: '/settings' } }, navigate } }));

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
    rows: [], loaded: false, open: null, busy: false, error: null, lastExport: null, panelTab: 'artifacts', showingArchived: false,
  });
  useChat.setState({ messages: [] });
});
afterEach(cleanup);

describe('the list', () => {
  it('does not say "nothing here" before the first read comes back', () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    // The mistake this pins: the fresh-install sentence shown to someone with a
    // dozen artifacts, because "empty" and "not asked yet" looked the same.
    expect(screen.queryByText(/land here/)).toBeNull();
  });

  it('says what to do about an empty workspace, not that it is empty', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: true, items: [] });
    expect(await screen.findByText(/Make me a one-page plan/)).toBeInTheDocument();
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
  it('runs an app with scripts but WITHOUT our origin', async () => {
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
    // The overview shows a drawn cover, so the app itself runs only once opened.
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    // No host in a test: the srcdoc fallback.
    const frame = await waitFor(() => { const el = container.querySelector('iframe'); if (!el) throw new Error('no frame yet'); return el; });
    expect(frame.getAttribute('sandbox')).toBe(APP_IFRAME_SANDBOX);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('chart');
  });

  // 2 Oct: a srcdoc frame inherits the window's CSP, and the installed app's
  // `script-src 'self'` blocked every chart. With a host, the page loads from
  // its own scheme, still in the same sandbox.
  it("loads an app from the host's frame scheme, not srcdoc, when there is a host", async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> });
    const before = internals.__TAURI_INTERNALS__;
    internals.__TAURI_INTERNALS__ = { ...before, convertFileSrc: (p: string, scheme: string) => `http://${scheme}.localhost/${p}` };
    (tauri.artifacts as unknown as Record<string, unknown>).frame = vi.fn().mockResolvedValue('tok123');
    try {
      useArtifacts.setState({
        loaded: true,
        open: { row: row({ kind: 'app', title: 'Revenue' }), content: '<p>chart</p>', showing: 2, versions: [] },
      });
      const { container } = render(<ArtifactsPanel onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      const frame = await waitFor(() => { const el = container.querySelector('iframe[src]'); if (!el) throw new Error('no frame yet'); return el; });
      expect(frame.getAttribute('src')).toBe('http://cinderpaw-frame.localhost/tok123');
      expect(frame.hasAttribute('srcdoc')).toBe(false);
      expect(frame.getAttribute('sandbox')).toBe(APP_IFRAME_SANDBOX);
      expect(tauri.artifacts.frame).toHaveBeenCalledWith('<p>chart</p>');
    } finally {
      delete (tauri.artifacts as unknown as Record<string, unknown>).frame;
      internals.__TAURI_INTERNALS__ = before;
    }
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

describe('resizing and the live frame', () => {
  it('the edge resizes with the keyboard, never squeezes the chat, and is remembered', async () => {
    const { ArtifactsPanel } = await import('../ArtifactsPanel');
    const { container } = render(<div><ArtifactsPanel onClose={() => {}} /></div>);
    // The row the panel shares with the chat: 1200px, so the panel may reach 1200 - 448.
    Object.defineProperty(container.firstElementChild!, 'clientWidth', { value: 1200, configurable: true });
    const edge = screen.getByRole('separator', { name: 'Resize artifacts panel' });
    const before = Number(edge.getAttribute('aria-valuenow'));
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(before + 24);
    expect(localStorage.getItem('cinderpaw.artifactsPanelWidth')).toBe(String(before + 24));
    for (let i = 0; i < 100; i++) fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(1200 - 448);
    for (let i = 0; i < 100; i++) fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(320);
  });
});

describe('live edits', () => {
  it('an edit to the artifact on screen shows its newest version, without being asked', async () => {
    useArtifacts.setState({
      loaded: true,
      open: { row: row({ version: 2 }), content: 'second draft', showing: 1, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    op.mockClear();

    useArtifacts.getState().onEvent({ id: 'a1', action: 'updated' });
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'get')).toBe(true));
    const get = op.mock.calls.find((c) => c[1] === 'get')!;
    // No version asked for: the newest one.
    expect(get[2]).toEqual({ artifactId: 'a1' });

    act(() => {
      useArtifacts.getState().onResult({ id: get[0] as string, ok: true, items: [row({ version: 3 })], content: 'third draft' });
    });
    expect(await screen.findByText('third draft')).toBeInTheDocument();
    expect(useArtifacts.getState().open?.showing).toBe(3);
  });

  it('an edit to a different artifact leaves the one on screen alone', async () => {
    useArtifacts.setState({
      loaded: true,
      open: { row: row(), content: 'mine', showing: 2, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    useArtifacts.getState().onEvent({ id: 'other', action: 'updated' });
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls.every((c) => c[1] === 'list')).toBe(true);
  });
});

describe('handing the work over', () => {
  beforeEach(() => useArtifacts.setState({ panelOpen: false }));

  it('an artifact made in the conversation on screen stays a card in the chat: the panel does not open by itself', async () => {
    useArtifacts.getState().onEvent({ id: 'new1', action: 'created', onScreen: true });
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(useArtifacts.getState().panelOpen).toBe(false);
    expect(op.mock.calls.every((c) => c[1] === 'list')).toBe(true);
  });

  it('one made anywhere else does not open the panel, and the done toast offers it', async () => {
    useNotifications.setState({ toasts: [] });
    useArtifacts.getState().onEvent({ id: 'tg1', action: 'created', onScreen: false, title: 'launch-week.pdf' });
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(useArtifacts.getState().panelOpen).toBe(false);
    expect(op.mock.calls.every((c) => c[1] === 'list')).toBe(true);

    const toast = useNotifications.getState().toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: 'success', title: 'launch-week.pdf is ready', message: 'Saved in Artifacts' });
    toast.action!.run();
    expect(useArtifacts.getState().panelOpen).toBe(true);
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'get' && c[2]?.artifactId === 'tg1')).toBe(true));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/chat'));
  });

  it('an update made elsewhere raises no toast', () => {
    useNotifications.setState({ toasts: [] });
    useArtifacts.getState().onEvent({ id: 'tg1', action: 'updated', onScreen: false, title: 'x' });
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

/**
 * A person's edit and an agent's edit, in one history.
 *
 * What these pin is the part nobody notices by clicking once: that a save
 * carries the version it was typed on, that an agent edit landing mid-typing
 * neither wipes the typing nor gets buried by it, and that going back is a new
 * version and never a rewind.
 */
describe('editing by hand', () => {
  const versions = [
    { version: 2, author: 'telegram:7:7', note: null, createdAt: 2 },
    { version: 1, author: 'user', note: null, createdAt: 1 },
  ];
  beforeEach(() => {
    useArtifacts.setState({
      loaded: true, editing: null, conflict: null, review: null,
      open: { row: row({ kind: 'markdown', version: 2 }), content: '# Q3', showing: 2, versions },
    });
  });

  it('saves the text as a new version, on the version it was typed on', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(await screen.findByLabelText('Content', {}, { timeout: 5000 }), { target: { value: '# Q3, revised' } });
    op.mockClear();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![1]).toBe('write');
    expect(op.mock.calls[0]![2]).toEqual({ artifactId: 'a1', content: '# Q3, revised', version: 2 });

    act(() => {
      useArtifacts.getState().onResult({
        id: idOfAction('write'), ok: true, content: '# Q3, revised',
        items: [row({ kind: 'markdown', version: 3, modifiedBy: 'user' })],
      });
    });
    expect(useArtifacts.getState().editing).toBeNull();
    expect(useArtifacts.getState().open?.showing).toBe(3);
  });

  it('a refused save keeps the typing and asks, and "mine" saves without the check', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(await screen.findByLabelText('Content', {}, { timeout: 5000 }), { target: { value: 'my words' } });
    op.mockClear();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    act(() => {
      useArtifacts.getState().onResult({ id: idOfAction('write'), ok: false, conflict: 3, error: 'stale' });
    });

    expect(await screen.findByText('Cinderpaw saved v3 while you were editing v2.')).toBeInTheDocument();
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('my words');

    op.mockClear();
    fireEvent.click(screen.getByText('Save mine as newest'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![2]).toEqual({ artifactId: 'a1', content: 'my words' });
  });

  it('an agent edit mid-typing is announced, not loaded over the typing', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(await screen.findByLabelText('Content', {}, { timeout: 5000 }), { target: { value: 'half a thought' } });
    op.mockClear();
    act(() => useArtifacts.getState().onEvent({ id: 'a1', action: 'updated', version: 3 }));

    expect(await screen.findByText('Cinderpaw saved v3 while you were editing v2.')).toBeInTheDocument();
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('half a thought');
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls.some((c) => c[1] === 'get')).toBe(false);
  });

  it('an older version is made current as a new version, not edited in place', async () => {
    useArtifacts.setState({
      open: { row: row({ kind: 'markdown', version: 2 }), content: 'v1 text', showing: 1, versions },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.queryByText('Edit')).toBeNull();
    op.mockClear();
    fireEvent.click(screen.getByText('Make v1 current'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![1]).toBe('restore');
    expect(op.mock.calls[0]![2]).toEqual({ artifactId: 'a1', version: 1 });
  });

  it('shows what the agent changed, and can put the previous version back', async () => {
    useArtifacts.setState({
      open: { row: row({ kind: 'markdown', version: 2 }), content: 'intro\nnew line', showing: 2, versions },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(screen.getByText('What changed'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![2]).toEqual({ artifactId: 'a1', version: 1 });
    act(() => {
      useArtifacts.getState().onResult({ id: op.mock.calls[0]![0] as string, ok: true, content: 'intro\nold line' });
    });

    expect(await screen.findByText('new line')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    op.mockClear();
    fireEvent.click(screen.getByText('Put v1 back'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![1]).toBe('restore');
    expect(op.mock.calls[0]![2]).toEqual({ artifactId: 'a1', version: 1 });
  });

  it('a document is edited as prose, and what the editor keeps has no script in it', async () => {
    useArtifacts.setState({
      open: {
        row: row({ kind: 'document', version: 2 }),
        content: '<h2>Plan</h2><p>Ship it</p><script>window.pwned = true</script><img src=x onerror="window.pwned = true">',
        showing: 2,
        versions,
      },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    const doc = await screen.findByLabelText('Document', {}, { timeout: 5000 });
    expect(doc.textContent).toContain('Ship it');
    expect(doc.querySelector('script, img, iframe')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
  });
});

/**
 * PDFs: the pages are drawn by pdf.js, which jsdom cannot run, so drawing is
 * replaced by a two-page stand-in. What is pinned is everything around it: that
 * a page action saves on the version shown, that placed text reaches the save as
 * an edit, and that a file picked from disk goes to the sidecar as an import.
 */
vi.mock('@/lib/pdfRender', () => ({
  openPdf: vi.fn().mockResolvedValue({ numPages: 2 }),
  renderPage: vi.fn().mockResolvedValue({ widthPt: 600, heightPt: 800 }),
  base64ToBytes: vi.fn(),
}));

describe('a PDF', () => {
  beforeEach(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    useArtifacts.setState({
      loaded: true, editing: null, conflict: null, review: null,
      open: {
        row: row({ kind: 'pdf', version: 3 }),
        content: 'JVBERi0=', encoding: 'base64',
        fields: [{ name: 'full_name', type: 'text', value: '' }],
        showing: 3, versions: [],
      },
    });
  });

  it('turning a page saves at once, on the version on screen', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    // First touch of the lazy PdfEditor chunk: the default 1s is not enough.
    const turn = await screen.findAllByText('Turn page', {}, { timeout: 5000 });
    op.mockClear();
    fireEvent.click(turn[1]!);
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op.mock.calls[0]![1]).toBe('write');
    expect(op.mock.calls[0]![2]).toEqual({
      artifactId: 'a1', version: 3,
      content: JSON.stringify({ edits: [{ type: 'rotate_page', page: 1, degrees: 90 }] }),
    });
  });

  it('text placed on a page and a filled field are what Save sends', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(await screen.findByDisplayValue(''), { target: { value: 'Ana Pop' } });

    fireEvent.click(screen.getByText('Add text'));
    const page = await screen.findByTestId('pdf-page-0');
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(page, { clientX: 50, clientY: 100 });
    fireEvent.change(await screen.findByLabelText('Text on page'), { target: { value: 'Semnat' } });

    op.mockClear();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(op).toHaveBeenCalled());
    const sent = JSON.parse(op.mock.calls[0]![2].content as string);
    expect(sent.edits).toEqual([
      { type: 'field', name: 'full_name', value: 'Ana Pop' },
      { type: 'text', page: 0, x: 0.25, y: 0.25, size: 12, text: 'Semnat' },
    ]);
    expect(op.mock.calls[0]![2].version).toBe(3);
  });

  it('a PDF picked from disk goes to the sidecar as an import, and nothing bigger than 20 MB is read', async () => {
    useArtifacts.setState({ open: null, rows: [] });
    render(<ArtifactsPanel onClose={() => {}} />);
    const input = screen.getByLabelText('PDF or Word file') as HTMLInputElement;
    op.mockClear();

    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/25 MB; the panel opens files up to 20 MB/)).toBeInTheDocument();

    const small = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'contract.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [small] } });
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'import')).toBe(true));
    const call = op.mock.calls.find((c) => c[1] === 'import')!;
    expect(JSON.parse(call[2].content as string)).toEqual({ name: 'contract.pdf', data: 'JVBERg==' });
  });
});

describe('rename, archive and delete in the list', () => {
  beforeEach(() => {
    useArtifacts.setState({ open: null, showingArchived: false, rows: [row()], loaded: true });
  });

  it('renames in place, shows the new name at once, and sends it', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(await screen.findByLabelText('Rename'));
    const input = screen.getByLabelText('New name');
    fireEvent.change(input, { target: { value: 'Q3 report, final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Q3 report, final')).toBeInTheDocument();
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'rename')).toBe(true));
    expect(op.mock.calls.find((c) => c[1] === 'rename')![2]).toEqual({ artifactId: 'a1', content: 'Q3 report, final' });
  });

  it('Escape leaves the name as it was and sends nothing', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(await screen.findByLabelText('Rename'));
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'oops' } });
    fireEvent.keyDown(screen.getByLabelText('New name'), { key: 'Escape' });
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(op.mock.calls.some((c) => c[1] === 'rename')).toBe(false);
  });

  it('archive takes the row out of the list and sends archive', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(await screen.findByLabelText('Archive'));
    expect(screen.queryByText('Q3 report')).toBeNull();
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'archive')).toBe(true));
  });

  it('delete asks first, and only a yes sends it', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(await screen.findByLabelText('Delete'));
    expect(screen.getByText(/for good\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(op.mock.calls.some((c) => c[1] === 'delete')).toBe(false);
    fireEvent.click(screen.getByLabelText('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'delete')).toBe(true));
  });

  it('the archive is its own list, asked for by name', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    op.mockClear();
    fireEvent.click(screen.getByText('Archived'));
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'list' && c[2]?.content === 'archived')).toBe(true));
  });
});

describe('Send to Google Docs', () => {
  it('logs in first when not connected, then uploads a document as a Google Doc', async () => {
    const { tauri: t } = await import('@/lib/tauri');
    const g = t.google as unknown as Record<string, ReturnType<typeof vi.fn>>;
    g.status = vi.fn().mockResolvedValue(false);
    g.connect = vi.fn().mockResolvedValue(undefined);
    g.upload = vi.fn().mockResolvedValue('https://docs.google.com/document/d/abc/edit');
    useArtifacts.setState({
      loaded: true, editing: null, google: null,
      open: { row: row({ kind: 'document', title: 'Q3: report' }), content: '<p>hi</p>', showing: 2, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('Send to Google Docs'));
    await waitFor(() => expect(g.upload).toHaveBeenCalled());
    expect(g.connect).toHaveBeenCalledTimes(1);
    expect(g.upload).toHaveBeenCalledWith('Q3- report', 'text/html', '<p>hi</p>', null, true);
    expect(await screen.findByText('open it')).toHaveAttribute('href', 'https://docs.google.com/document/d/abc/edit');
  });

  it('a build not registered with Google shows no button at all', async () => {
    const { tauri: t } = await import('@/lib/tauri');
    const g = t.google as unknown as Record<string, ReturnType<typeof vi.fn>>;
    g.status = vi.fn().mockResolvedValue(null);
    useArtifacts.setState({
      loaded: true, editing: null, google: null,
      open: { row: row({ kind: 'document', title: 'Q3: report' }), content: '<p>hi</p>', showing: 2, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(g.status).toHaveBeenCalled());
    // Let the answer land: before it, the button is hidden whatever it says.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByLabelText('Send to Google Docs')).toBeNull();
  });

  it('a PDF goes as a PDF, and a Word file has no button', () => {
    expect(googlePlan('pdf')).toEqual({ mime: 'application/pdf', convert: false });
    expect(googlePlan('docx')).toBeNull();
  });
});

describe('the Artifact Dock', () => {
  it("puts this chat's artifacts first as cards, with type and size, and the rest below", async () => {
    useChat.setState({ messages: [{
      id: 'm1', role: 'assistant', content: '', createdAt: 0,
      toolActivity: [{ id: 't', tool: 'artifact', kind: 'artifact', subject: '', status: 'done', startedAt: 0, endedAt: 1,
        note: null, hits: [], files: [], output: '', cwd: '', facts: [], desktop: null, error: null,
        artifact: { id: 'mine', title: 'Launch plan', kind: 'document', version: 1, path: null } }],
    } as ChatMessage] });
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: true, items: [
      row({ id: 'other', title: 'Old notes' }),
      row({ id: 'mine', title: 'Launch plan', kind: 'document', bytes: 12 * 1024 }),
    ] });
    const dock = (await screen.findByText('In this chat')).closest('section')!;
    expect(dock).toHaveTextContent('Launch plan');
    expect(dock).toHaveTextContent('Document, 12 KB');
    expect(dock).not.toHaveTextContent('Old notes');
    expect(screen.getByText('Everything else')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export Launch plan' }));
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'export')).toBe(true));
  });

  it('shows no dock for a chat that made nothing', async () => {
    render(<ArtifactsPanel onClose={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalled());
    useArtifacts.getState().onResult({ id: idOfCall(0), ok: true, items: [row()] });
    expect(await screen.findByText('Q3 report')).toBeInTheDocument();
    expect(screen.queryByText('In this chat')).toBeNull();
  });
});

describe('the Context tab', () => {
  it('says what will show up in a new chat, and lists the Chat mode tools as switches', async () => {
    useUI.setState({ inputMode: 'chat', enabledTools: [] });
    // Opened from the chat's Context button; the panel has no tab strip.
    useArtifacts.setState({ panelTab: 'context' });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.getByText(/Nothing here yet. Files you add/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Web search/ }));
    expect(useUI.getState().enabledTools).toContain('web_search');
  });

  it("lists the chat's files, and says Agent mode picks its own tools", () => {
    useUI.setState({ inputMode: 'agent' });
    useChat.setState({ messages: [{ id: 'u', role: 'user', content: '[Image attached: cat.png]\n\nhi', createdAt: 0 }] });
    useArtifacts.setState({ panelTab: 'context' });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.getByRole('region', { name: 'Files' })).toHaveTextContent('cat.png');
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
    expect(screen.getByText(/In Agent mode Cinderpaw picks/)).toBeInTheDocument();
  });

  it('says what the chat is about, folds each kind of context, and Add fills the composer', () => {
    useChat.setState({ streamStatus: 'streaming', messages: [
      { id: 'u', role: 'user', content: '[Image attached: cat.png]\n\nPlan the launch week', createdAt: 0 },
      { id: 'a', role: 'assistant', content: '', createdAt: 1, memoryUsed: [{ kind: 'fact', text: 'likes: ramen' }] } as ChatMessage,
    ] });
    useArtifacts.setState({ panelTab: 'context' });
    const onCompose = vi.fn();
    render(<ArtifactsPanel onClose={() => {}} onCompose={onCompose} />);
    expect(screen.getByText('Current task')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan the launch week' })).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Memory' })).toHaveTextContent('likes: ramen');
    expect(screen.getByText('Recent memory')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a memory' }));
    expect(onCompose).toHaveBeenCalledWith('Remember that ');
    useChat.setState({ streamStatus: 'idle' });
  });
});

describe('a chat in a project (spec 9)', () => {
  const TRIP = { id: 'p1', name: 'Trip', conversation_ids: ['c1'], instructions: '', files: [] };

  it('shows the project above the chat, and saves the instructions when you leave the box', async () => {
    useChat.setState({ messages: [] });
    useConversations.setState({ currentId: 'c1' } as never);
    useProjects.setState({ list: [TRIP] });
    const save = vi.spyOn(tauri.projects, 'save').mockResolvedValue(undefined);
    vi.spyOn(tauri.projects, 'list').mockResolvedValue([{ ...TRIP, instructions: 'Answer in Romanian.' }]);
    useArtifacts.setState({ panelTab: 'context' });
    render(<ArtifactsPanel onClose={() => {}} />);

    const box = screen.getByLabelText('Instructions for every chat in this project');
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('For example'));
    expect(screen.getByText(/No files yet/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'Answer in Romanian.' } });
    fireEvent.blur(box);
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', 'Trip', ['c1'], { instructions: 'Answer in Romanian.' }));
    save.mockRestore();
  });

  it('a chat outside any project shows no project', () => {
    useConversations.setState({ currentId: 'c9' } as never);
    useProjects.setState({ list: [TRIP] });
    useArtifacts.setState({ panelTab: 'context' });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.queryByLabelText('Instructions for every chat in this project')).toBeNull();
  });

  it('Chat mode gets the same project block the engine adds', () => {
    expect(projectPrompt(undefined)).toBe('');
    expect(projectPrompt(TRIP)).toBe('');
    const text = projectPrompt({ ...TRIP, instructions: 'Budget 2000 EUR.', files: [{ name: 'a.pdf', path: 'C:/p/a.pdf' }] });
    expect(text).toContain('## Project: Trip');
    expect(text).toContain('Budget 2000 EUR.');
    expect(text).toContain('- a.pdf: C:/p/a.pdf');
  });
});

// 30 Sep: a report the agent wrote in Markdown but saved as a 'document' showed
// as one run-on line of #, | and **, because a document is framed as HTML.
describe('a document written in Markdown', () => {
  it('reads as formatted text, with its headings, not as raw symbols', async () => {
    useArtifacts.setState({
      loaded: true, editing: null, google: null,
      open: { row: row({ kind: 'document', title: 'Rețete' }), content: '# Trei rețete\n\n**Verdict:** chili-ul.', showing: 1, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'Trei rețete' })).toBeInTheDocument();
  });

  it('goes to Google Docs as text, not as a web page', () => {
    expect(googlePlan(shownKind('document', '# Trei rețete'))).toEqual({ mime: 'text/plain', convert: true });
    expect(shownKind('document', '<p>hi</p>')).toBe('document');
  });
});

// Darius's Artifact board (30 Sep): an open artifact starts as an overview.
describe('the artifact overview', () => {
  it('shows what it is, that it is ready, its history, and opens in full', async () => {
    useArtifacts.setState({
      loaded: true, editing: null, google: null,
      open: {
        row: row({ kind: 'document', version: 2 }), content: '<h1>Q3</h1><p>Revenue grew in every region.</p>', showing: 2,
        versions: [
          { version: 2, author: 'user', note: null, createdAt: Date.now() },
          { version: 1, author: 'chat', note: 'First draft', createdAt: Date.now() - 3_600_000 },
        ],
      },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Q3 report' })).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Revenue grew in every region.')).toBeInTheDocument();
    expect(screen.getByText('Edited by you')).toBeInTheDocument();
    expect(screen.getByText('First draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('button', { name: 'Overview' })).toBeInTheDocument();
  });

  it('a deep dive from a chat card skips the overview, scrolls to the section, then forgets it', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    useArtifacts.setState({
      loaded: true, editing: null, google: null, focus: { id: 'a1', section: 'Budget' },
      open: { row: row({ kind: 'markdown', version: 1 }), content: '# Trip\n\n## Day 1\nWalk.\n\n## Budget\nTen.', showing: 1, versions: [] },
    });
    render(<ArtifactsPanel onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    await waitFor(() => expect(useArtifacts.getState().focus).toBeNull());
    expect((scrolled.mock.instances[0] as unknown as HTMLElement).textContent).toBe('Budget');
  });

  it('openArtifact with a section remembers it for the viewer', async () => {
    await useArtifacts.getState().openArtifact('a1', 'Day 2');
    expect(useArtifacts.getState().focus).toEqual({ id: 'a1', section: 'Day 2' });
    await useArtifacts.getState().openArtifact('a1');
    expect(useArtifacts.getState().focus).toBeNull();
  });

  // 2 Oct review: the focus was consumed by whatever was on screen while the
  // asked-for artifact was still loading, and a chip on the card of the
  // artifact whose overview was already open did nothing at all.
  it('a deep dive waits for its own artifact, and works from an open overview', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const doc = (id: string, title: string) => ({ row: row({ id, title, kind: 'markdown', version: 1 }), content: `# ${title}\n\n## Day 1\nWalk.\n\n## Budget\nTen.`, showing: 1, versions: [] });
    useArtifacts.setState({ loaded: true, editing: null, google: null, focus: null, open: doc('a1', 'Trip') });
    render(<ArtifactsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' })); // a1 in full, with its own "Budget"
    act(() => useArtifacts.setState({ focus: { id: 'b2', section: 'Budget' } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(useArtifacts.getState().focus).not.toBeNull(); // not spent on a1
    expect(scrolled).not.toHaveBeenCalled();
    act(() => useArtifacts.setState({ open: doc('b2', 'Other') }));
    await waitFor(() => expect(useArtifacts.getState().focus).toBeNull());
    expect(scrolled).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Overview' })); // back to b2's overview
    act(() => useArtifacts.setState({ focus: { id: 'b2', section: 'Day 1' } }));
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2));
  });

  it('summaryOf reads the words of a page, not its tags or its title', () => {
    expect(summaryOf('document', '<h1>Q3</h1><p>Up <b>12%</b>.</p>')).toBe('Up 12% .');
    expect(summaryOf('markdown', '# T\n\ntext')).toBe('');
  });
});
