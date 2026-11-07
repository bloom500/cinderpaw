import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import userEvent from '@testing-library/user-event';
import { ModelPickerPopover } from '@/components/chat/ModelPickerPopover';
import { CinderpawModelSelector } from '@/components/agents/CinderpawModelSelector';
import { tauri } from '@/lib/tauri';

// The download store subscribes to host events when it is imported; there is no host here.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

/**
 * An embedding model cannot hold a conversation. It turns text into vectors and
 * that is all it does, so offering it where somebody picks who they are about
 * to talk to is offering a choice that can only go wrong.
 *
 * It is not hypothetical ordering, either: `bge-m3-Q8_0.gguf` sorts before
 * `Qwen3.8-4B-Q6_K.gguf`, so on a normal install it is the FIRST row, and a
 * menu autofocuses its first row the instant it opens. Opening the picker
 * highlighted the one model that cannot answer, before the person had chosen
 * anything.
 */

const ON_DISK = [
  {
    id: 'bge-m3-Q8_0.gguf',
    name: 'bge-m3-Q8_0.gguf',
    path: 'C:/models/bge-m3-Q8_0.gguf',
    size_bytes: 600_000_000,
    quant: 'Q8_0',
    ctx_len: null,
    loaded: false,
    modelfile: null,
    is_embedding: true,
  },
  {
    id: 'Qwen3.8-4B-Q6_K.gguf',
    name: 'Qwen3.8-4B-Q6_K.gguf',
    path: 'C:/models/Qwen3.8-4B-Q6_K.gguf',
    size_bytes: 3_500_000_000,
    quant: 'Q6_K',
    ctx_len: 8192,
    loaded: false,
    modelfile: null,
    is_embedding: false,
  },
];

beforeEach(() => {
  vi.spyOn(tauri.models, 'list').mockResolvedValue(ON_DISK as never);
  vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([] as never);
  useCinderpawStore.setState({ automatic: true });
});

/** The full list sits one step under the short one (4 Nov, mockup C). */
async function openAll() {
  await userEvent.click(screen.getByRole('button'));
  await userEvent.click(await screen.findByRole('menuitem', { name: /All models/ }));
}

describe('the chat model picker', () => {
  it('does not offer the embedding model', async () => {
    render(<ModelPickerPopover />);
    await openAll();
    await userEvent.click(screen.getByRole('tab', { name: /This computer/ }));

    expect(await screen.findByText('Qwen3.8-4B-Q6_K.gguf')).toBeInTheDocument();
    expect(screen.queryByText('bge-m3-Q8_0.gguf')).toBeNull();
  });

  it('highlights something that can answer when it opens', async () => {
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));
    await screen.findByRole('menuitemcheckbox', { name: /Let Cinderpaw choose/ });

    // A menu focuses its first item on open, and that focus is what a person
    // reads as "it picked one for me". Whatever it lands on must at least be a
    // model that can hold a conversation.
    const focused = document.activeElement;
    expect(focused?.textContent ?? '').not.toContain('bge');
  });

  // Reading a size while drawing forces the browser to lay out the whole page
  // first. The closed button redraws with every chat, and it did: 150 ms of a
  // chat opening went to this one read (production build, 30 Oct).
  it('reads no sizes while it is closed', () => {
    const read = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get');
    const { rerender } = render(<ModelPickerPopover />);
    rerender(<ModelPickerPopover />);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});

describe('the Model Switcher, in the 21st.dev shape (2 Nov, his pick)', () => {
  // Every cloud model sits under its provider's name in All, one tap away; the
  // 1 Nov version made a person open a provider's page first.
  it('All models: every model under its provider, and one tap switches to it', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([
      { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', enabled: true, has_api_key: true, base_url: null, default_model: 'claude-opus-5-5' },
    ] as never);
    const list = vi.spyOn(tauri.raw, 'providerModels').mockResolvedValue([
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
    ]);
    const setModel = vi.fn().mockResolvedValue(undefined);
    useCinderpawStore.setState({ setModel, modelConfig: null });
    render(<ModelPickerPopover />);
    await openAll();

    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
    expect(list).toHaveBeenCalledWith('anthropic');
    await userEvent.click(await screen.findByRole('menuitem', { name: /Haiku 5\.5/ }));
    expect(setModel).toHaveBeenCalledWith({ source: 'byok', providerId: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('lists the ChatGPT plan first, Anthropic next, the OpenAI key last', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([
      { id: 'openai', name: 'OpenAI', provider: 'openai', enabled: true, has_api_key: true, base_url: null, default_model: 'gpt-4o' },
      { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', enabled: true, has_api_key: true, base_url: null, default_model: 'claude-haiku-5-5' },
      { id: 'chatgpt', name: 'OpenAI Subscription', provider: 'openai', enabled: true, has_api_key: true, base_url: null, default_model: 'gpt-6.1-sol' },
    ] as never);
    vi.spyOn(tauri.raw, 'providerModels').mockResolvedValue([]);
    useCinderpawStore.setState({ modelConfig: null });
    render(<ModelPickerPopover />);
    await openAll();
    await screen.findByRole('group', { name: 'OpenAI' });
    // The name heading each provider's models, in the order they are drawn.
    const names = [...document.querySelectorAll('[data-provider-header] .font-medium')].map((h) => h.textContent);
    expect(names).toEqual(['OpenAI Subscription', 'Anthropic', 'OpenAI']);
  });

  // Their menu's Effort beside each model, kept per model (his pick, 2 Nov):
  // Opus stays on High while Haiku answers on its own Auto, and back again.
  it('a model keeps its own Effort, and the one it is left with', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([
      { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', enabled: true, has_api_key: true, base_url: null, default_model: 'claude-opus-5-5' },
    ] as never);
    vi.spyOn(tauri.raw, 'providerModels').mockResolvedValue([
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
    ]);
    const setModel = vi.fn(async (s: { providerId?: string; model: string }) => {
      useCinderpawStore.setState({ modelConfig: { provider: s.providerId ?? '', model: s.model, base_url: '' } as never });
    });
    useCinderpawStore.setState({ setModel: setModel as never, modelConfig: { provider: 'anthropic', model: 'claude-opus-5-5', base_url: '' } as never });
    useModel.setState({ effort: 'high', effortByModel: {} });
    render(<ModelPickerPopover />);

    await openAll();
    await userEvent.click(await screen.findByRole('menuitem', { name: /Haiku 5\.5/ }));
    await waitFor(() => expect(useModel.getState().effort).toBe('auto'));
    expect(useModel.getState().effortByModel['anthropic/claude-opus-5-5']).toBe('high');

    // Effort chosen beside a model picks that model with it.
    await userEvent.click(screen.getByRole('button', { name: /Haiku/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /All models/ }));
    const opus = await screen.findByRole('menuitem', { name: /Opus 5\.5/ });
    opus.focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Low' }));
    await waitFor(() => expect(useModel.getState().effort).toBe('low'));
    expect(setModel).toHaveBeenLastCalledWith({ source: 'byok', providerId: 'anthropic', model: 'claude-opus-5-5' });
    expect(useModel.getState().effortByModel['anthropic/claude-opus-5-5']).toBe('low');
  });

  it('a model on this computer is on its own tab, one tap away', async () => {
    const load = vi.spyOn(useModel.getState(), 'load').mockResolvedValue(undefined);
    render(<ModelPickerPopover />);
    await openAll();
    await userEvent.click(screen.getByRole('tab', { name: /This computer/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Qwen3\.8-4B-Q6_K\.gguf/ }));
    expect(load).toHaveBeenCalledWith('C:/models/Qwen3.8-4B-Q6_K.gguf');
    load.mockRestore();
  });

  // 26 Oct, Darius's pick from the mockups (C, Dynamic Island): the menu grows
  // out of its own button, which stays in place as the island's last row.
  it('opens as an island over its own button, and that last row closes it', async () => {
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveClass('model-island');
    await userEvent.click(within(menu).getByRole('button', { name: /close the list/ }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('the agent model picker', () => {
  it('does not offer the embedding model either', async () => {
    // Same list, same mistake, second surface. The flag exists on ModelInfo
    // precisely so each caller decides; these two both have to filter.
    render(<CinderpawModelSelector />);
    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/Qwen3\.8-4B/)).toBeInTheDocument();
    expect(screen.queryByText(/bge-m3/)).toBeNull();
  });
});

// Last: providerModels is cached per session in the module, and these fill it.
describe('Let Cinderpaw choose (4 Nov, his pick: mockup C)', () => {
  const KEYS = [
    { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', enabled: true, has_api_key: true, base_url: null, default_model: 'claude-haiku-5-5' },
    { id: 'chatgpt', name: 'OpenAI Subscription', provider: 'openai', enabled: true, has_api_key: true, base_url: null, default_model: 'gpt-6.1-sol' },
  ];

  it('opens on one switch, on by default, over the models it picks from', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue(KEYS as never);
    vi.spyOn(tauri.raw, 'providerModels').mockResolvedValue([]);
    useCinderpawStore.setState({ isReady: true, offline: false, modelConfig: { provider: 'anthropic', model: 'claude-haiku-5-5', base_url: '' } as never });
    render(<ModelPickerPopover />);
    expect(await screen.findByRole('button', { name: /Automatic/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('menuitemcheckbox', { name: /Let Cinderpaw choose/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('It picks from')).toBeInTheDocument();
    // On, one line of what it picks from, not rows nobody can press; never the embedding model.
    expect(screen.queryByRole('menuitem', { name: /your Anthropic key/ })).toBeNull();
    expect(screen.getByText(/and 1 more/)).toBeInTheDocument();
    expect(screen.queryByText(/bge/i)).toBeNull();
  });

  it('switched off, a row is picked and always used', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue(KEYS as never);
    vi.spyOn(tauri.raw, 'providerModels').mockResolvedValue([]);
    const setModel = vi.fn().mockResolvedValue(undefined);
    useCinderpawStore.setState({ setModel, modelConfig: null });
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Let Cinderpaw choose/ }));
    expect(useCinderpawStore.getState().automatic).toBe(false);
    expect(await screen.findByText('Always use')).toBeInTheDocument();
    // Off, the rows: named by the job first, the model and who pays under it.
    expect(screen.getByRole('menuitem', { name: /Fast.*your Anthropic key/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Private.*on this computer/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Smart.*your ChatGPT plan/ }));
    expect(setModel).toHaveBeenCalledWith({ source: 'byok', providerId: 'chatgpt', model: 'gpt-6.1-sol' });
  });
});
