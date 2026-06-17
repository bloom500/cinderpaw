import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceRecorder } from '../useVoiceRecorder';

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  (globalThis as any).MediaRecorder = FakeRecorder;
  (globalThis as any).navigator.mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  };
});

describe('useVoiceRecorder', () => {
  it('goes idle → recording → preview with a blob', async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    expect(result.current.state).toBe('idle');
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe('recording');
    act(() => { result.current.stop(); });
    expect(result.current.state).toBe('preview');
    expect(result.current.blob).toBeInstanceOf(Blob);
  });

  it('sets error=denied when permission is refused', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(new Error('no'));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBe('denied');
    expect(result.current.state).toBe('idle');
  });
});
