import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsPopover } from '@/components/chat/ControlsPopover';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useFeralStore } from '@/stores/feral';

vi.mock('@/stores/model', () => ({ useModel: vi.fn() }));
vi.mock('@/stores/ui', () => ({ useUI: vi.fn() }));
vi.mock('@/stores/feral', () => ({ useFeralStore: vi.fn() }));

const mockUseModel = vi.mocked(useModel);
const mockUseUI = vi.mocked(useUI);
const mockUseFeral = vi.mocked(useFeralStore);
const mockSetModelContext = vi.fn().mockResolvedValue(undefined);

/**
 * @param loaded       the resident local GGUF (or null)
 * @param cloudModel   the selected cloud target (or null). When set, it is the
 *                     ACTIVE target even if a local GGUF is still resident.
 */
function setup(
  loaded: unknown = null,
  cloudModel: unknown = null,
  contextByModel: Record<string, number> = {},
) {
  mockUseModel.mockImplementation((sel: any) =>
    sel({
      loaded,
      cloudModel,
      isLoading: false,
      contextByModel,
      setModelContext: mockSetModelContext,
      inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 4096 },
      setInferParams: vi.fn(),
    }),
  );
  mockUseUI.mockImplementation((sel: any) => sel({ inputMode: 'chat' }));
  mockUseFeral.mockImplementation((sel: any) => sel({ modelConfig: null }));
}

describe('ControlsPopover — context window', () => {
  beforeEach(() => { vi.clearAllMocks(); setup(); });

  it('cloud target: temperature only, no Top-P, no context slider', async () => {
    setup(null, { providerId: 'minimax', providerName: 'MiniMax', modelId: 'MiniMax-M3' });
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    // Only Temperature — Top-P (localOnly) and the context slider are gone.
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByText(/auto-managed for cloud models/i)).toBeInTheDocument();
    expect(screen.queryByText('Top-P')).not.toBeInTheDocument();
  });

  it('a resident local GGUF must not expose its context slider while a cloud model is active', async () => {
    // The exact trap: MiniMax selected (active) but Qwythos still resident as
    // the offline fallback. The old gate keyed on `loaded` and showed a 17k
    // slider that reloaded the local model at 1024k — freezing the machine.
    setup(
      { path: '/m/qwythos.gguf', name: 'qwythos', ctx_len: 17408, n_ctx_train: 1048576 },
      { providerId: 'minimax', providerName: 'MiniMax', modelId: 'MiniMax-M3' },
    );
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/auto-managed for cloud models/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply.*reload/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(1); // temperature only
  });

  it('local target: auto-detects the ceiling from the model n_ctx_train', async () => {
    setup({ path: '/m/qwen.gguf', name: 'qwen', ctx_len: 8192, n_ctx_train: 65536 });
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    const sliders = screen.getAllByRole('slider');
    const ctxSlider = sliders[sliders.length - 1] as HTMLInputElement;
    expect(ctxSlider.max).toBe('65536');
    expect(ctxSlider.value).toBe('8192'); // starts at the active ctx_len
  });

  it('local target: Apply reloads the model at the chosen size', async () => {
    setup({ path: '/m/qwen.gguf', name: 'qwen', ctx_len: 8192, n_ctx_train: 65536 });
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    const sliders = screen.getAllByRole('slider');
    const ctxSlider = sliders[sliders.length - 1] as HTMLInputElement;
    fireEvent.change(ctxSlider, { target: { value: '32768' } });
    const apply = await screen.findByRole('button', { name: /apply.*reload/i });
    await userEvent.click(apply);
    expect(mockSetModelContext).toHaveBeenCalledWith('/m/qwen.gguf', 32768);
  });
});
