import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LocalModelCard } from '@/components/models/LocalModelCard';
import { useModel } from '@/stores/model';
import type { ModelInfo } from '@/lib/tauri';

const model: ModelInfo = {
  id: 'test', name: 'llama3.Q4_K_M.gguf', path: '/models/llama3.Q4_K_M.gguf',
  size_bytes: 4_700_000_000, quant: 'Q4_K_M', ctx_len: 4096, loaded: false,
  is_embedding: false,
};

vi.mock('@/stores/model', () => ({
  useModel: vi.fn(),
}));

const mockUseModel = vi.mocked(useModel);

// The card links to the chat, so it lives inside a router.
const renderCard = (m: ModelInfo, onDelete = vi.fn()) =>
  render(<MemoryRouter><LocalModelCard model={m} onDelete={onDelete} /></MemoryRouter>);

/** Delete lives in the opened card, next to the details it would throw away. */
const openDetails = () => userEvent.click(screen.getByRole('button', { name: /show details/i }));

describe('LocalModelCard', () => {
  it('idle: shows Run and, opened, Delete; no progress bar', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    renderCard(model);
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await openDetails();
    expect(screen.getByRole('button', { name: /delete/i })).toBeEnabled();
  });

  it('loading: shows progress bar, hides Run', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: null, isLoading: true,
        loadProgress: { percentage: 75, statusText: 'Warming KV cache...' },
        load: vi.fn(), unload: vi.fn(),
      })
    );
    renderCard(model);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByText(/75/)).toBeInTheDocument();
    expect(screen.getByText(/Warming KV cache/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
  });

  it('loaded: shows Active badge and Stop, no Run', async () => {
    const unload = vi.fn();
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: { path: model.path, name: 'test', ctx_len: 4096 },
        isLoading: false, loadProgress: null,
        load: vi.fn(), unload,
      })
    );
    renderCard(model);
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(unload).toHaveBeenCalled();
    await openDetails();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('Run loads this model', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load, unload: vi.fn() })
    );
    renderCard(model);
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }));
    expect(load).toHaveBeenCalledWith(model.path);
  });

  it('delete asks for confirmation before calling onDelete', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderCard(model, onDelete);
    await openDetails();
    // Clicking Delete on the card opens a confirm dialog — no deletion yet.
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/delete this model/i)).toBeInTheDocument();
    // Confirming in the dialog performs the delete.
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalledWith(model.path);
  });

  it('deleting: confirm button shows progress and disables while in flight', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    // Never resolves — keeps isDeleting=true so we can assert the in-flight state
    const onDelete = vi.fn().mockImplementation(() => new Promise(() => {}));
    renderCard(model, onDelete);
    await openDetails();
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // The confirm button flips to a disabled "Deleting…" while onDelete is pending.
    expect(within(dialog).getByRole('button', { name: /deleting/i })).toBeDisabled();
  });
});

describe('an embedding model', () => {
  it('says what it is for and offers no Run button', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    renderCard({ ...model, id: 'bge', name: 'bge-m3-Q8_0.gguf', is_embedding: true });
    expect(screen.queryByRole('button', { name: /^run$/i })).toBeNull();
    expect(screen.getByText(/used for memory and search, not for chat/i)).toBeInTheDocument();
    await openDetails();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });
});
