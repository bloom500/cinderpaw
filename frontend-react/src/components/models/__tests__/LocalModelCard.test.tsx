import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('LocalModelCard', () => {
  it('idle: shows Load + Delete, no progress bar', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    const onDelete = vi.fn();
    render(<LocalModelCard model={model} onDelete={onDelete} />);
    expect(screen.getByRole('button', { name: /load/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /delete/i })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('loading: shows progress bar, hides Load + Delete', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: null, isLoading: true,
        loadProgress: { percentage: 75, statusText: 'Warming KV cache...' },
        load: vi.fn(), unload: vi.fn(),
      })
    );
    render(<LocalModelCard model={model} onDelete={vi.fn()} />);
    expect(screen.getByText(/75/)).toBeInTheDocument();
    expect(screen.getByText(/Warming KV cache/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^load$/i })).not.toBeInTheDocument();
  });

  it('loaded: shows Active badge, Unload + Delete', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: { path: model.path, name: 'test', ctx_len: 4096 },
        isLoading: false, loadProgress: null,
        load: vi.fn(), unload: vi.fn(),
      })
    );
    render(<LocalModelCard model={model} onDelete={vi.fn()} />);
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unload/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^load$/i })).not.toBeInTheDocument();
  });

  it('delete asks for confirmation before calling onDelete', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<LocalModelCard model={model} onDelete={onDelete} />);
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
    render(<LocalModelCard model={model} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // The confirm button flips to a disabled "Deleting…" while onDelete is pending.
    expect(within(dialog).getByRole('button', { name: /deleting/i })).toBeDisabled();
  });
});
