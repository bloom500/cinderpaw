/**
 * Phase 4 S1 — Search is where the sidebar's conversation list AND project
 * tree are moving. A field that finds only chats cannot replace a rail that
 * contains both, so these cover the widened surface.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SearchOverlay } from '../SearchOverlay';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { useUI } from '@/stores/ui';

/**
 * The rows highlight the matched substring by wrapping it in <mark>, so the
 * visible label is split across elements and an exact text query never
 * matches. Read the row's own textContent instead — which is also what the
 * user actually perceives.
 */
async function rows(): Promise<string[]> {
  const found = await screen.findAllByRole('option');
  return found.map((el) => el.textContent ?? '');
}

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    tauri: {
      conversations: {
        // No message bodies: these tests are about which KINDS of thing are
        // findable, not about snippet extraction.
        load: vi.fn(async (id: string) => ({ id, title: '', messages: [] })),
      },
    },
  };
});

// Distinct timestamps on purpose: with the browse list sorted by recency, two
// identical ones make the order a coin flip and the test passes or fails by
// luck. c1 is the newer.
const CONVS = [
  { id: 'c1', title: 'Refactor the router', updated_at: new Date(Date.now() - 60_000).toISOString() },
  { id: 'c2', title: 'Dinner ideas', updated_at: new Date(Date.now() - 3_600_000).toISOString() },
];

const PROJECTS = [
  { id: 'p1', name: 'Bloom Media', conversation_ids: ['c1'] },
  { id: 'p2', name: 'Feral', conversation_ids: [] },
];

function setup() {
  useConversations.setState({ list: CONVS as never, open: vi.fn() as never });
  useProjects.setState({ list: PROJECTS as never });
  useUI.setState({ searchOpen: true } as never);
  return render(
    <MemoryRouter>
      <SearchOverlay />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SearchOverlay', () => {
  it('finds a conversation by title', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'refactor');
    await waitFor(async () =>
      expect((await rows()).join(' ')).toContain('Refactor the router'),
    );
  });

  it('finds a project by name, and says it is a project', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'bloom');
    await waitFor(async () => {
      const all = (await rows()).join(' ');
      expect(all).toContain('Bloom Media');
      expect(all).toContain('Project · 1 chat');
    });
  });

  it('lists projects above conversations', async () => {
    // A project is the coarser answer — the container before its contents.
    useConversations.setState({
      list: [{ id: 'c9', title: 'Feral notes', updated_at: new Date().toISOString() }] as never,
      open: vi.fn() as never,
    });
    useProjects.setState({ list: PROJECTS as never });
    useUI.setState({ searchOpen: true } as never);
    render(
      <MemoryRouter>
        <SearchOverlay />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole('combobox'), 'feral');
    await waitFor(async () => expect((await rows()).length).toBeGreaterThan(1));
    const [first] = await rows();
    expect(first).toContain('Feral');
    expect(first).toContain('Project');
  });

  it('selecting a project narrows the search instead of navigating', async () => {
    // There is no project page to go to; showing what is inside is the honest
    // answer to picking a container.
    const open = vi.fn();
    useConversations.setState({ list: CONVS as never, open: open as never });
    useProjects.setState({ list: PROJECTS as never });
    useUI.setState({ searchOpen: true } as never);
    render(
      <MemoryRouter>
        <SearchOverlay />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole('combobox'), 'bloom');
    await waitFor(async () => expect((await rows()).join(' ')).toContain('Bloom Media'));
    const [projectRow] = await screen.findAllByRole('option');
    await userEvent.click(projectRow);

    // Scoped, not closed, and no conversation was opened.
    expect(open).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByLabelText(/Search everything instead of Bloom Media/i))
        .toBeInTheDocument(),
    );
  });

  it('the empty state names what was searched', async () => {
    // "No matches" alone leaves the user guessing whether the thing they want
    // is even searchable here.
    setup();
    await userEvent.type(screen.getByRole('combobox'), 'zzzznothing');
    await waitFor(() =>
      expect(screen.getByText(/No conversations or projects match/i)).toBeInTheDocument(),
    );
  });
});

describe('with nothing typed', () => {
  /**
   * Phase 5. The rail is deleted, so this list is the ONLY place a person can
   * see their own history without already knowing what they are looking for.
   * A search field that shows nothing until you name the thing you want is not
   * a list, it is a quiz.
   */
  it('shows everything, projects first and newest chat first', async () => {
    setup();
    expect(await rows()).toEqual([
      expect.stringContaining('Bloom Media'),
      expect.stringContaining('Feral'),
      expect.stringContaining('Refactor the router'),
      expect.stringContaining('Dinner ideas'),
    ]);
  });

  it('says so on a fresh install rather than showing an empty box', async () => {
    useConversations.setState({ list: [] as never, open: vi.fn() as never });
    useProjects.setState({ list: [] as never });
    useUI.setState({ searchOpen: true } as never);
    render(<MemoryRouter><SearchOverlay /></MemoryRouter>);
    expect(await screen.findByText(/No conversations yet/i)).toBeTruthy();
  });
});

describe('opened already narrowed to a project', () => {
  it('lists what the project contains instead of reporting no matches', async () => {
    useConversations.setState({
      list: [
        { id: 'c1', title: 'Route planning', updated_at: new Date().toISOString() },
        { id: 'c2', title: 'Unrelated chat', updated_at: new Date().toISOString() },
      ],
    });
    useProjects.setState({ list: [{ id: 'p1', name: 'Routier', conversation_ids: ['c1'] }] });
    // How a Home project card opens it: scoped, with nothing typed.
    useUI.setState({ searchOpen: true, searchScopeId: 'p1' });

    render(<MemoryRouter><SearchOverlay /></MemoryRouter>);

    const listed = await rows();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('Route planning');
  });
});
