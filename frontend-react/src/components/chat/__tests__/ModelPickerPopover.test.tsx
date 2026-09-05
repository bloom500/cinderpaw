import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPickerPopover } from '@/components/chat/ModelPickerPopover';
import { CinderpawModelSelector } from '@/components/agents/CinderpawModelSelector';
import { tauri } from '@/lib/tauri';

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
