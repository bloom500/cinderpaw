import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '../SettingsPage';

/**
 * Settings has four doors that open it on a specific category: the redirects
 * for `/extensions`, `/connectors`, `/memory-layers` and `/memory-graph`, all
 * of which land on `/settings?cat=…`.
 *
 * Coming through one of them used to lock the sidebar. The open category lived
 * in `useState` AND in the URL, with an effect copying the URL onto the state
 * on `[searchParams, cat]` — so the click that changed the category re-ran the
 * effect and put the old one straight back. Every entry in the sidebar looked
 * clickable and did nothing. This is the assertion that says it does not.
 */

// The heavy tabs are not what this is about: it asserts navigation, so each
// category renders a nameplate instead of its real screen.
vi.mock('@/stores/settings', () => ({
  useSettings: (sel: (s: unknown) => unknown) =>
    sel({ fetchSettings: vi.fn(), fetchByok: vi.fn() }),
}));
vi.mock('@/components/settings/GeneralTab',    () => ({ GeneralTab:    () => <div>general pane</div> }));
vi.mock('@/components/settings/AppearanceTab', () => ({ AppearanceTab: () => <div>appearance pane</div> }));
vi.mock('@/components/settings/HardwareTab',   () => ({ HardwareTab:   () => <div>hardware pane</div> }));
vi.mock('@/components/settings/ApiServerTab',  () => ({ ApiServerTab:  () => <div>api pane</div> }));
vi.mock('@/components/settings/ByokTab',       () => ({ ByokTab:       () => <div>byok pane</div> }));
vi.mock('@/components/settings/AgentSettingsTab', () => ({ AgentSettingsTab: () => <div>agent pane</div> }));
vi.mock('@/components/settings/PrivacyTab',    () => ({ PrivacyTab:    () => <div>privacy pane</div> }));
vi.mock('@/components/settings/AboutTab',      () => ({ AboutTab:      () => <div>about pane</div> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage category navigation', () => {
  it('opens on the category the deep link names', () => {
    renderAt('/settings?cat=privacy');
    expect(screen.getByText('privacy pane')).toBeTruthy();
  });

  it('lets you leave the category you arrived on', async () => {
    renderAt('/settings?cat=privacy');
    await userEvent.click(screen.getByRole('button', { name: /About/ }));
    expect(screen.getByText('about pane')).toBeTruthy();
    expect(screen.queryByText('privacy pane')).toBeNull();
  });

  it('and keeps moving, click after click', async () => {
    renderAt('/settings?cat=privacy');
    await userEvent.click(screen.getByRole('button', { name: /Hardware/ }));
    expect(screen.getByText('hardware pane')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /General/ }));
    expect(screen.getByText('general pane')).toBeTruthy();
  });

  it('falls back to General when the URL names a category that does not exist', () => {
    renderAt('/settings?cat=nonsense');
    expect(screen.getByText('general pane')).toBeTruthy();
  });

  it('says which category is open, not only in colour', async () => {
    renderAt('/settings?cat=hardware');
    expect(screen.getByRole('button', { name: /Hardware/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /General/ })).not.toHaveAttribute('aria-current');
  });
});
