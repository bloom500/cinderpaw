import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { useModel } from '@/stores/model';
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
});

describe('the chat model picker', () => {
  it('does not offer the embedding model', async () => {
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Qwen3.8-4B-Q6_K.gguf')).toBeInTheDocument();
    expect(screen.queryByText('bge-m3-Q8_0.gguf')).toBeNull();
  });

  it('highlights something that can answer when it opens', async () => {
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));
    await screen.findByText('Qwen3.8-4B-Q6_K.gguf');

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

describe('the Model Switcher (spec 8)', () => {
  it('offers roles: Local is the model on disk, Fast asks to be chosen, and picking a role switches to it', async () => {
    useModel.setState({ roles: {}, cloudModel: null, loaded: null });
    const load = vi.spyOn(useModel.getState(), 'load').mockResolvedValue(undefined);
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Model Switcher')).toBeInTheDocument();
    const local = (await screen.findByText('Local')).closest('[role="menuitem"]')!;
    await waitFor(() => expect(local).toHaveTextContent('Qwen3.8-4B-Q6_K.gguf'));
    const fast = screen.getByText('Fast').closest('[role="menuitem"]')!;
    expect(fast).toHaveTextContent('Choose a model');

    await userEvent.click(local);
    expect(load).toHaveBeenCalledWith('C:/models/Qwen3.8-4B-Q6_K.gguf');
    load.mockRestore();
  });

  // 29 Oct, Darius: "if I want to select the model I use, it takes me to the
  // Models tab". An empty role chooses in place, from the models already here.
  it('an empty role chooses its model in the switcher, without leaving the chat', async () => {
    useModel.setState({ roles: {}, cloudModel: null, loaded: null });
    const load = vi.spyOn(useModel.getState(), 'load').mockResolvedValue(undefined);
    const at = window.location.pathname;
    render(<ModelPickerPopover />);
    await userEvent.click(screen.getByRole('button'));

    const fast = (await screen.findByText('Fast')).closest('[role="menuitem"]')!;
    await userEvent.click(within(fast as HTMLElement).getByRole('button', { name: 'Choose a model' }));
    expect(window.location.pathname).toBe(at);
    const option = await screen.findByRole('menuitem', { name: /Qwen3\.8-4B-Q6_K\.gguf.*On this computer/ });
    await userEvent.click(option);

    expect(useModel.getState().roles.fast).toMatchObject({ kind: 'local', path: 'C:/models/Qwen3.8-4B-Q6_K.gguf' });
    expect(load).toHaveBeenCalledWith('C:/models/Qwen3.8-4B-Q6_K.gguf');
    load.mockRestore();
    useModel.setState({ roles: {} });
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
