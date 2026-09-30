import { describe, expect, it } from 'vitest';
import { resolveRole, sameModel, type RoleModel } from '../modelRoles';

const haiku: RoleModel = { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'anthropic/claude-haiku' };
const opus: RoleModel = { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'anthropic/claude-opus' };
const qwen: RoleModel = { kind: 'local', path: 'C:/m/qwen.gguf', name: 'qwen.gguf' };

describe('model roles', () => {
  it('a fresh install: Primary is what answers now, Local the first download, Fast and Deep empty', () => {
    expect(resolveRole('primary', {}, haiku, qwen)).toBe(haiku);
    expect(resolveRole('local', {}, haiku, qwen)).toBe(qwen);
    expect(resolveRole('fast', {}, haiku, qwen)).toBeNull();
    expect(resolveRole('deep', {}, haiku, qwen)).toBeNull();
    // Nothing installed at all: nothing to name.
    expect(resolveRole('primary', {}, null, null)).toBeNull();
  });

  it('a chosen model wins over the default', () => {
    expect(resolveRole('primary', { primary: opus }, haiku, qwen)).toBe(opus);
    expect(resolveRole('deep', { deep: opus }, haiku, qwen)).toBe(opus);
  });

  it('knows the model answering now, by route and id, or by file', () => {
    expect(sameModel(haiku, { ...haiku })).toBe(true);
    expect(sameModel(haiku, opus)).toBe(false);
    // Agent mode knows a local model only by its name.
    expect(sameModel(qwen, { kind: 'local', path: '', name: 'qwen.gguf' })).toBe(true);
    expect(sameModel(qwen, haiku)).toBe(false);
    expect(sameModel(null, haiku)).toBe(false);
  });
});
