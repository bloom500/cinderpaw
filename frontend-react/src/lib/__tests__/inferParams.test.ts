import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: {
      get: vi.fn().mockResolvedValue({
        models_dir: '',
        default_gpu_layers: 0,
        api_server_enabled: false,
        api_port: 8080,
        version: '0.1.0',
        desktop_control_enabled: false,
        desktop_control_yolo: false,
      }),
    },
  },
}));

import { currentInferParams } from '@/lib/inferParams';

beforeEach(() => {
  vi.resetModules();
});

describe('currentInferParams reasoning', () => {
  it('mode=on always returns enableThinking true', async () => {
    const params = await currentInferParams({ reasoningMode: 'on', modelName: 'llama.gguf' });
    expect(params.system_prompt).toContain('<think>');
  });

  it('mode=off always returns no thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'off', modelName: 'qwq.gguf' });
    expect(params.system_prompt ?? '').not.toContain('<think>');
  });

  it('mode=auto with thinking model returns thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'auto', modelName: 'QwQ-32B.gguf' });
    expect(params.system_prompt).toContain('<think>');
  });

  it('mode=auto with non-thinking model returns no thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'auto', modelName: 'llama-3b.gguf' });
    expect(params.system_prompt ?? '').not.toContain('<think>');
  });

  it('no opts returns params without thinking prompt', async () => {
    const params = await currentInferParams();
    expect(params.system_prompt).toBeNull();
  });
});
