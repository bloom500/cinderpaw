import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { ChatSpendControl } from '../ChatSpendControl';

const { chatSpend } = vi.hoisted(() => ({ chatSpend: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { cinderpawAgent: { chatSpend } } }));

const openRouter = { provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'test', display_name: 'OpenRouter' };
const chatGpt = { provider: 'chatgpt', base_url: 'http://127.0.0.1:1234/chatgpt', model: 'test', display_name: 'ChatGPT' };

beforeEach(() => {
  chatSpend.mockReset();
  useCinderpawStore.setState({ isReady: true, modelConfig: openRouter });
});

it('loads and saves a spending limit for the current chat and displays tracked usage on reopening', async () => {
  const user = userEvent.setup();
  chatSpend.mockResolvedValueOnce({ limitUsd: null, usedUsd: 0 });
  chatSpend.mockResolvedValueOnce({ limitUsd: 2, usedUsd: 0 });
  chatSpend.mockResolvedValueOnce({ limitUsd: 2, usedUsd: 0.38 });
  chatSpend.mockResolvedValueOnce({ limitUsd: null, usedUsd: 0.38 });
  render(<ChatSpendControl sessionId="cowork:scout" />);
  const button = screen.getByRole('button', { name: 'Chat spending limit' });
  await user.click(button);
  await user.type(await screen.findByRole('spinbutton', { name: 'Limit in USD' }), '2');
  await user.click(screen.getByRole('button', { name: 'Save limit' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(chatSpend).toHaveBeenCalledWith('cowork:scout', 2);
  await user.click(button);
  expect(await screen.findByText('$0.38 of $2.00 used or reserved')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Remove limit' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(chatSpend).toHaveBeenCalledWith('cowork:scout', null);
});

it('hides the spending limit when using a ChatGPT plan without a saved limit', async () => {
  useCinderpawStore.setState({ modelConfig: chatGpt });
  chatSpend.mockResolvedValue({ limitUsd: null, usedUsd: 0 });
  render(<ChatSpendControl sessionId="chatgpt-chat" />);
  await waitFor(() => expect(chatSpend).toHaveBeenCalledWith('chatgpt-chat'));
  expect(screen.queryByRole('button', { name: 'Chat spending limit' })).toBeNull();
});

it('lets a ChatGPT chat remove a saved OpenRouter limit', async () => {
  useCinderpawStore.setState({ modelConfig: chatGpt });
  chatSpend.mockResolvedValue({ limitUsd: 2, usedUsd: 0.38 });
  render(<ChatSpendControl sessionId="existing-limit" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Chat spending limit' }));
  const remove = await screen.findByRole('button', { name: 'Remove limit' });
  expect(screen.queryByRole('button', { name: 'Save limit' })).toBeNull();
  chatSpend.mockResolvedValue({ limitUsd: null, usedUsd: 0.38 });
  await user.click(remove);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Chat spending limit' })).toBeNull());
  expect(chatSpend).toHaveBeenCalledWith('existing-limit', null);
});
