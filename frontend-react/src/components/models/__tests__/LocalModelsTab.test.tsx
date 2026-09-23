import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalModelsTab } from '../LocalModelsTab';
import { tauri, type ModelInfo } from '@/lib/tauri';

// The real download store subscribes to host events at import time.
vi.mock('@/stores/download', () => ({
  useDownload: (sel: (s: { done: boolean }) => unknown) => sel({ done: false }),
}));

/**
 * A fresh install has exactly one model on disk: the memory model, which
 * downloads by itself and cannot chat. That must read as "no chat model yet",
 * with the ways forward, not as a list of one card nobody can talk to.
 */
describe('LocalModelsTab', () => {
  it('treats a disk with only the memory model as empty and offers sign-in', async () => {
    vi.spyOn(tauri.models, 'list').mockResolvedValue([
      { name: 'bge-m3-q8_0', path: 'C:/m/bge.gguf', is_embedding: true } as unknown as ModelInfo,
    ]);
    render(<MemoryRouter><LocalModelsTab onBrowse={() => {}} /></MemoryRouter>);
    expect(await screen.findByText('No chat models on this computer yet.')).toBeTruthy();
    expect(screen.getByText('Sign in with OpenRouter')).toBeTruthy();
    expect(screen.getByText(/memory model Cinderpaw uses/)).toBeTruthy();
    vi.restoreAllMocks();
  });
});
