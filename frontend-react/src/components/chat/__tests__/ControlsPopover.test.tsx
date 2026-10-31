import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsPopover } from '@/components/chat/ControlsPopover';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';

vi.mock('@/stores/model', () => ({ useModel: vi.fn() }));
vi.mock('@/stores/cinderpaw', () => ({ useCinderpawStore: vi.fn() }));

const mockUseModel = vi.mocked(useModel);
const mockUseCinderpaw = vi.mocked(useCinderpawStore);
const mockSetModelContext = vi.fn().mockResolvedValue(undefined);
const mockSetEffort = vi.fn();
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5', base_url: 'https://api.anthropic.com' };

const MINIMAX = { provider: 'minimax', model: 'MiniMax-M3', base_url: 'https://api.minimax.io/v1' };
const LOCAL_ENGINE = { provider: 'cinderpaw-local', model: 'qwen', base_url: 'http://localhost:11435' };

/**
 * @param loaded       the resident local GGUF (or null)
 * @param agentTarget  the agent's model config. A cloud target is the ACTIVE
 *                     one even if a local GGUF is still resident.
 */
function setup(
  loaded: unknown = null,
  agentTarget: unknown = null,
  contextByModel: Record<string, number> = {},
) {
  mockUseModel.mockImplementation((sel: any) =>
    sel({
      loaded,
      isLoading: false,
      contextByModel,
      setModelContext: mockSetModelContext,
      inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 4096 },
      setInferParams: vi.fn(),
      effort: 'auto',
      setEffort: mockSetEffort,
    }),
  );
  mockUseCinderpaw.mockImplementation((sel: any) => sel({ modelConfig: agentTarget }));
}

describe('ControlsPopover — context window', () => {
  beforeEach(() => { vi.clearAllMocks(); setup(); });

  it('cloud target: no sliders; a model without effort says so', async () => {
    setup(null, MINIMAX);
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    // Cloud gets Effort in place of Temperature; MiniMax takes no effort.
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.getByText(/no effort setting/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-managed for cloud models/i)).toBeInTheDocument();
    expect(screen.queryByText('Top-P')).not.toBeInTheDocument();
  });

  it('a Claude model gets Effort, and a pick is saved', async () => {
    setup(null, HAIKU);
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button', { name: 'Reply settings' }));
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(mockSetEffort).toHaveBeenCalledWith('high');
    expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
  });

  it('a resident local GGUF must not expose its context slider while a cloud model is active', async () => {
    // The exact trap: MiniMax selected (active) but Qwythos still resident as
    // the offline fallback. The old gate keyed on `loaded` and showed a 17k
    // slider that reloaded the local model at 1024k — freezing the machine.
    setup(
      { path: '/m/qwythos.gguf', name: 'qwythos', ctx_len: 17408, n_ctx_train: 1048576 },
      MINIMAX,
    );
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/auto-managed for cloud models/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply.*reload/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('slider')).toHaveLength(0); // cloud: Effort, no sliders
  });

  it('local target: auto-detects the ceiling from the model n_ctx_train', async () => {
    setup({ path: '/m/qwen.gguf', name: 'qwen', ctx_len: 8192, n_ctx_train: 65536 }, LOCAL_ENGINE);
    render(<ControlsPopover />);
    await userEvent.click(screen.getByRole('button'));
    const sliders = screen.getAllByRole('slider');
    const ctxSlider = sliders[sliders.length - 1] as HTMLInputElement;
    expect(ctxSlider.max).toBe('65536');
    expect(ctxSlider.value).toBe('8192'); // starts at the active ctx_len
  });

  it('local target: Apply reloads the model at the chosen size', async () => {
    setup({ path: '/m/qwen.gguf', name: 'qwen', ctx_len: 8192, n_ctx_train: 65536 }, LOCAL_ENGINE);
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
