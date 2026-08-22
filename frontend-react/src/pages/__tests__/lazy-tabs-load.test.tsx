import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ExtensionsPage } from '../ExtensionsPage';
import { ConnectorsPage } from '../ConnectorsPage';
import { tauri } from '@/lib/tauri';

/**
 * Both of these pages guard every `setState` behind an `alive` ref, so that
 * leaving mid-fetch does not update a component that is gone. The guard was
 * cleared on unmount and never re-armed on mount — and React's strict mode
 * mounts, unmounts and mounts again with the SAME refs. The data arrived in
 * milliseconds and was thrown away by a flag left over from a lifetime that
 * had already ended: skeletons forever, nothing in the console, backend
 * blameless.
 *
 * These render under `StrictMode` on purpose. Without it the bug does not
 * reproduce, which is exactly why it survived a suite of 576 passing tests.
 */

afterEach(() => vi.restoreAllMocks());

describe('settings tabs finish loading under strict mode', () => {
  it('Capabilities shows the catalog', async () => {
    vi.spyOn(tauri.mcp, 'list').mockResolvedValue([]);
    vi.spyOn(tauri.mcp, 'catalog').mockResolvedValue([
      {
        id: 'files',
        name: 'File Access',
        description: 'Let the assistant read files.',
        category: 'Files',
        icon: '📁',
        fields: [],
      },
    ] as unknown as Awaited<ReturnType<typeof tauri.mcp.catalog>>);

    render(<StrictMode><ExtensionsPage /></StrictMode>);

    await waitFor(() => expect(screen.getByText('File Access')).toBeTruthy());
  });

  it('Accounts shows the connector catalog', async () => {
    vi.spyOn(tauri.connectors, 'list').mockResolvedValue([]);
    vi.spyOn(tauri.connectors, 'accounts').mockResolvedValue([]);
    vi.spyOn(tauri.connectors, 'catalog').mockResolvedValue([
      {
        id: 'discord',
        name: 'Discord',
        description: 'Chat with your assistant from Discord.',
        icon: '🎮',
        // `fields`, not `pairing_fields`: the card calls `.every` on it, and a
        // mock shaped like the API's other name for it fails as a crash rather
        // than as a missing card.
        fields: [],
        pairing_fields: [],
        coming_soon: false,
      },
    ] as unknown as Awaited<ReturnType<typeof tauri.connectors.catalog>>);

    render(<StrictMode><ConnectorsPage /></StrictMode>);

    await waitFor(() => expect(screen.getByText('Discord')).toBeTruthy());
  });
});
