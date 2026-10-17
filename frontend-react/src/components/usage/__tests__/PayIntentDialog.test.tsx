import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    settings: { usage_sharing: true } as { usage_sharing: boolean | null } | null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    wizard: false,
  },
}));
vi.mock('@/stores/settings', () => ({ useSettings: (sel: (s: typeof state) => unknown) => sel(state) }));
vi.mock('@/stores/onboarding', () => ({
  useOnboarding: Object.assign((sel: (s: { active: boolean }) => unknown) => sel({ active: state.wizard }), {
    getState: () => ({ loadPersisted: async () => true }),
  }),
}));

import { PayIntentDialog } from '../PayIntentDialog';
import { useWhatsNew } from '@/components/WhatsNew';
import { recordRealTask, shouldAskPayIntent } from '@/lib/payIntent';

const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
const sent = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

function realUse(tasks = 5) {
  for (let i = 0; i < tasks; i++) recordRealTask();
}

describe('the paid-extra question', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    state.settings = { usage_sharing: true };
    state.wizard = false;
    useWhatsNew.setState({ open: false });
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

  it('never opens over the usage question, What\'s new or the setup wizard', () => {
    realUse();
    state.settings = { usage_sharing: null };
    const a = render(<PayIntentDialog />);
    expect(screen.queryByText('Cinderpaw stays free')).toBeNull();
    a.unmount();
    state.settings = { usage_sharing: false };
    useWhatsNew.setState({ open: true });
    const b = render(<PayIntentDialog />);
    expect(screen.queryByText('Cinderpaw stays free')).toBeNull();
    b.unmount();
    useWhatsNew.setState({ open: false });
    state.wizard = true;
    render(<PayIntentDialog />);
    expect(screen.queryByText('Cinderpaw stays free')).toBeNull();
  });

  it('says Cinderpaw stays free first, shows no price until an extra is picked, then sends one answer', () => {
    realUse();
    render(<PayIntentDialog />);
    expect(screen.getByText('Cinderpaw stays free')).toBeTruthy();
    expect(screen.queryByText('$35')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Gets better at your job every week/ }));
    expect(screen.getByText('Would you pay this for it?')).toBeTruthy();
    for (const p of ['$35', '$25', '$17']) expect(screen.getByText(p)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
    expect(sent()).toEqual([{ extra: 'packs', price: '352517', answer: 'maybe' }]);
    expect(screen.getByText('Thank you!')).toBeTruthy();
    expect(shouldAskPayIntent()).toBe(false);
  });

  it('No thanks is an answer too, and is sent as none', () => {
    realUse();
    render(<PayIntentDialog />);
    fireEvent.click(screen.getByRole('button', { name: "No thanks, I'll stay on free" }));
    expect(sent()).toEqual([{ extra: 'none', price: '0', answer: 'none' }]);
  });

  it('Don\'t ask again sends nothing and never asks again', () => {
    realUse();
    render(<PayIntentDialog />);
    fireEvent.click(screen.getByRole('button', { name: "Don't ask again" }));
    expect(screen.queryByText('Cinderpaw stays free')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shouldAskPayIntent()).toBe(false);
  });
});
