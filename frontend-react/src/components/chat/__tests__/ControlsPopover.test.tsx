import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsPopover } from '@/components/chat/ControlsPopover';
import { useModel } from '@/stores/model';

vi.mock('@/stores/model', () => ({ useModel: vi.fn() }));

const mockUseModel = vi.mocked(useModel);
const mockSetModelContext = vi.fn().mockResolvedValue(undefined);

function setup(loaded: unknown = null, contextByModel: Record<string, number> = {}) {
  mockUseModel.mockImplementation((sel: any) =>
    sel({
      loaded,
      isLoading: false,
      contextByModel,
      setModelContext: mockSetModelContext,
      inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 4096 },
      setInferParams: vi.fn(),
    }),
  );
}

describe('ControlsPopover — context window', () => {
  beforeEach(() => { vi.clearAllMocks(); setup(); });

  it('shows an auto-managed note (no context slider) for cloud models', async () => {
    setup(null);
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    // Param sliders still render; only the context slider is gated on a load.
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    expect(screen.getByText(/auto-managed for cloud models/i)).toBeInTheDocument();
  });

  it('auto-detects the ceiling from the model n_ctx_train', async () => {
    setup({ path: '/m/qwen.gguf', name: 'qwen', ctx_len: 8192, n_ctx_train: 65536 });
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    const sliders = screen.getAllByRole('slider');
    const ctxSlider = sliders[sliders.length - 1] as HTMLInputElement;
    expect(ctxSlider.max).toBe('65536');
    expect(ctxSlider.value).toBe('8192'); // starts at the active ctx_len
  });

  it('Apply reloads the model at the chosen size', async () => {
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
