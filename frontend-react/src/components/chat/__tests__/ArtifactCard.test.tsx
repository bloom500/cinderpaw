/**
 * ArtifactCard — what a reply made is a card in the chat, and only once it is
 * finished; while it is being made it stays a tool row with its progress.
 *
 * Finished, it shows the thing itself: a plan as its sections, a chart or
 * diagram as the live page, anything else as a cover. Drawing it must never
 * change what the side panel has open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtifactCard, artifactLine } from '../ArtifactCard';
import { MessageToolWidgets } from '../MessageToolWidgets';
import { useArtifacts, resetArtifactRequests } from '@/stores/artifacts';
import { startActivity, finishActivity } from '@/hooks/useLiveToolActivity';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
import { tauri } from '@/lib/tauri';

// The download store subscribes to host events when it is imported; there is no host here.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauri: { ...actual.tauri, artifacts: { op: vi.fn() }, google: { status: vi.fn().mockResolvedValue(null) } },
  };
});

const op = tauri.artifacts.op as unknown as ReturnType<typeof vi.fn>;

const PLAN = { id: 'a1', title: 'Launch week', kind: 'markdown', version: 1, path: null };
const CHART = { id: 'c1', title: 'Sales by month', kind: 'app', version: 1, path: null };
const ROW = { id: 'a1', kind: 'markdown', title: 'Launch week', version: 1, bytes: 10, updatedAt: 0, modifiedBy: 'chat' };

const PLAN_MD = `# Launch week

## Summary
We launch on Monday.

## Day 1
![Harbour](https://example.com/harbour.jpg)
Press day.

## Budget
Ten thousand.`;

/** The engine answers a `get` with this text, the way the sidecar would. */
function engineReturns(content: string, row = ROW) {
  op.mockImplementation(async (id: string, action: string) => {
    if (action === 'get') queueMicrotask(() => useArtifacts.getState().onResult({ id, ok: true, items: [row], content }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetArtifactRequests();
  op.mockReset();
  useArtifacts.setState({ panelOpen: false, open: null, openArtifact: vi.fn(async () => {}), exportArtifact: vi.fn(async () => {}) });
});

describe('artifactLine', () => {
  it('names the kind, and the version once there is more than one', () => {
    expect(artifactLine({ kind: 'document', version: 1 })).toBe('Document');
    expect(artifactLine({ kind: 'app', version: 3 })).toBe('Interactive, v3');
    expect(artifactLine({ kind: 'something-new', version: 1 })).toBe('File');
  });
});

describe('ArtifactCard', () => {
  it('shows a plan as its sections: a list, and the one chosen with its picture', async () => {
    engineReturns(PLAN_MD);
    render(<ArtifactCard f={PLAN} />);
    const tabs = await screen.findByRole('tablist', { name: 'Sections' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Summary', 'Day 1', 'Budget']);
    expect(screen.getByText('We launch on Monday.')).toBeTruthy();

    await userEvent.click(within(tabs).getByRole('tab', { name: 'Day 1' }));
    expect(screen.getByText('Press day.')).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://example.com/harbour.jpg');
  });

  it('draws a chart as the live page, in the same sandbox as the panel', async () => {
    engineReturns('<html><body><canvas></canvas></body></html>', { ...ROW, id: 'c1', kind: 'app' });
    render(<ArtifactCard f={CHART} />);
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(frame.getAttribute('sandbox')).toBe(APP_IFRAME_SANDBOX);
  });

  it('reading the text never changes what the panel has open', async () => {
    engineReturns(PLAN_MD);
    render(<ArtifactCard f={PLAN} />);
    await screen.findByRole('tablist');
    expect(useArtifacts.getState().open).toBeNull();
    expect(useArtifacts.getState().panelOpen).toBe(false);
  });

  it('opens the artifact in the side panel from Open in Editor', async () => {
    engineReturns(PLAN_MD);
    render(<ArtifactCard f={PLAN} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Launch week' }));
    expect(useArtifacts.getState().panelOpen).toBe(true);
    expect(useArtifacts.getState().openArtifact).toHaveBeenCalledWith('a1');
  });

  it('offers a PDF for a plan, and the page itself for a chart', async () => {
    engineReturns(PLAN_MD);
    const { unmount } = render(<ArtifactCard f={PLAN} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(useArtifacts.getState().exportArtifact).toHaveBeenCalledWith('a1', { as: 'pdf', row: { title: 'Launch week', kind: 'markdown' } });
    unmount();

    engineReturns('<canvas></canvas>', { ...ROW, id: 'c1', kind: 'app' });
    render(<ArtifactCard f={CHART} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(useArtifacts.getState().exportArtifact).toHaveBeenLastCalledWith('c1', { as: undefined, row: { title: 'Sales by month', kind: 'app' } });
  });

  it('with no Google connected there is no Share button', async () => {
    engineReturns(PLAN_MD);
    render(<ArtifactCard f={PLAN} />);
    await screen.findByRole('tablist');
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('when the text cannot be read it is still a card with a cover and Open', async () => {
    op.mockImplementation(async (id: string, action: string) => {
      if (action === 'get') queueMicrotask(() => useArtifacts.getState().onResult({ id, ok: false, error: 'gone' }));
    });
    render(<ArtifactCard f={PLAN} />);
    await waitFor(() => expect(screen.queryByLabelText('Loading')).toBeNull());
    expect(screen.getAllByText('Launch week').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open Launch week' })).toBeTruthy();
  });

  it('an export receipt stays a small row: Open only', () => {
    render(<ArtifactCard f={{ ...PLAN, path: 'D:/x/Launch week.pdf' }} />);
    expect(screen.getByRole('button', { name: 'Open Launch week' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(op).not.toHaveBeenCalled();
  });

  it('is drawn for a finished artifact tool, not for one still running', () => {
    engineReturns(PLAN_MD);
    const running = startActivity('artifact_create', { title: 'Launch week' });
    const { rerender } = render(<MessageToolWidgets activity={[running]} streaming />);
    expect(screen.queryByRole('button', { name: 'Open Launch week' })).toBeNull();

    const done = finishActivity(running, { ok: true, data: PLAN });
    rerender(<MessageToolWidgets activity={[done]} streaming={false} />);
    expect(screen.getByRole('button', { name: 'Open Launch week' })).toBeTruthy();
  });
});
