import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { settings: { usage_sharing: true } as { usage_sharing: boolean | null } | null },
}));
vi.mock('@/stores/settings', () => ({ useSettings: (sel: (s: typeof state) => unknown) => sel(state) }));

import { PayIntentCard } from '../PayIntentCard';
import { recordRealTask, shouldAskPayIntent } from '@/lib/payIntent';

const sent = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

function realUse(tasks = 5) {
  for (let i = 0; i < tasks; i++) recordRealTask();
}

describe('the paid-extra question', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    state.settings = { usage_sharing: true };
  });

  it('is not asked on a fresh install, only after 5 real tasks or 7 days', () => {
    const day0 = Date.parse('2026-10-18T10:00:00Z');
    expect(shouldAskPayIntent(day0)).toBe(false);
    expect(shouldAskPayIntent(day0 + 6 * 86_400_000)).toBe(false);
    expect(shouldAskPayIntent(day0 + 7 * 86_400_000)).toBe(true);
    localStorage.clear();
    realUse(4);
    expect(shouldAskPayIntent()).toBe(false);
    recordRealTask();
    expect(shouldAskPayIntent()).toBe(true);
  });

  it('waits while the usage question is still open, so nobody gets two at once', () => {
    realUse();
    state.settings = { usage_sharing: null };
    const { container } = render(<PayIntentCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says Cinderpaw stays free first, shows no price until an extra is picked, then sends one answer', () => {
    realUse();
    render(<PayIntentCard />);
    expect(screen.getByText('Cinderpaw stays free')).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gets better at your job every week' }));
    expect(screen.getByText(/Would you pay \$10 a month for it\?/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    expect(sent()).toEqual([{ extra: 'packs', price: '10', answer: 'maybe' }]);
    expect(screen.getByText('Thank you!')).toBeTruthy();
    expect(shouldAskPayIntent()).toBe(false);
  });

  it('No thanks is an answer too, and is sent as none', () => {
    realUse();
    render(<PayIntentCard />);
    fireEvent.click(screen.getByRole('button', { name: "No thanks, I'll stay on free" }));
    expect(sent()).toEqual([{ extra: 'none', price: '0', answer: 'none' }]);
  });

  it('closing sends nothing and never asks again', () => {
    realUse();
    const { container } = render(<PayIntentCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Works while your PC is off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shouldAskPayIntent()).toBe(false);
  });
});
