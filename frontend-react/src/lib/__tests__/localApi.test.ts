import { describe, expect, it, vi } from 'vitest';
import { tauri } from '@/lib/tauri';
import { isLocalEngineUrl, localApiBase } from '../localApi';

describe('the local API address', () => {
  it('is the port the host really bound, and both ports count as the engine', async () => {
    // 11435 was taken at launch, so the API took 51234 (boot.rs).
    vi.spyOn(tauri.raw, 'getLocalApiPort').mockResolvedValue(51234);
    expect(await localApiBase()).toBe('http://localhost:51234');
    expect(isLocalEngineUrl('http://127.0.0.1:51234/v1')).toBe(true);
    expect(isLocalEngineUrl('http://localhost:11435')).toBe(true);
    expect(isLocalEngineUrl('http://localhost:1234/v1')).toBe(false);
    expect(isLocalEngineUrl(null)).toBe(false);
  });
});
