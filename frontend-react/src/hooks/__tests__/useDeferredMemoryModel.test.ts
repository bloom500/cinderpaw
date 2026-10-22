import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const download = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/lib/tauri', () => ({ tauri: { raw: { downloadEmbeddingModel: download } } }));
import { useChat } from '@/stores/chat';
import { MEMORY_MODEL_DELAY_MS, useDeferredMemoryModel } from '../useDeferredMemoryModel';

beforeEach(() => { vi.useFakeTimers(); download.mockClear(); useChat.setState({ streamStatus: 'idle' }); });
afterEach(() => { vi.useRealTimers(); });

describe('the memory model download', () => {
  it('does not start at launch, starts after the first finished reply, once', () => {
    renderHook(() => useDeferredMemoryModel());
    expect(download).not.toHaveBeenCalled();
    useChat.setState({ streamStatus: 'streaming' });
    expect(download).not.toHaveBeenCalled();
    useChat.setState({ streamStatus: 'done' });
    useChat.setState({ streamStatus: 'idle' });
    useChat.setState({ streamStatus: 'done' });
    vi.advanceTimersByTime(MEMORY_MODEL_DELAY_MS);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('starts anyway a few minutes in, for someone who never types', () => {
    renderHook(() => useDeferredMemoryModel());
    vi.advanceTimersByTime(MEMORY_MODEL_DELAY_MS - 1);
    expect(download).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
