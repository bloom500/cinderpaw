import { describe, it, expect } from 'vitest';
import { isStale, lookupLimit, modelLabel, parseCatalog } from '../modelCatalog';

// One real row per shape, copied from https://openrouter.ai/api/v1/models
// (fetched 2026-09-16) so the parser is tested against what the endpoint sends.
const payload = {
  data: [
    { id: 'z-ai/glm-4.6', context_length: 204800, name: 'Z.AI: GLM 4.6' },
    { id: 'google/gemini-2.5-pro', context_length: 1048576, name: 'Google: Gemini 2.5 Pro' },
    { id: 'openai/gpt-4o', context_length: 128000 },
    { id: 'gpt-4o', context_length: 8192 },
    { id: 'broken/no-length' },
    { context_length: 4096 },
  ],
};

describe('parseCatalog', () => {
  it('keeps the rows that carry a length and drops the rest', () => {
    const limits = parseCatalog(payload);
    expect(limits['z-ai/glm-4.6']).toEqual({ limit: 204800, name: 'Z.AI: GLM 4.6' });
    expect(limits['google/gemini-2.5-pro']?.limit).toBe(1048576);
    // A row with no `name` still counts: the limit is the part the ring needs,
    // and `modelLabel` tidies the id up rather than refusing to draw.
    expect(limits['gpt-4o']).toEqual({ limit: 8192, name: '' });
    expect(limits['broken/no-length']).toBeUndefined();
    expect(Object.keys(limits)).toHaveLength(4);
  });

  it('survives a payload that is not the catalog at all', () => {
    expect(parseCatalog(null)).toEqual({});
    expect(parseCatalog({ error: 'rate limited' })).toEqual({});
  });
});

describe('lookupLimit', () => {
  const limits = parseCatalog(payload);

  it('finds a model however the user spelled the provider prefix', () => {
    expect(lookupLimit(limits, 'z-ai/glm-4.6')).toBe(204800);
    expect(lookupLimit(limits, 'GLM-4.6')).toBe(204800);
    expect(lookupLimit(limits, 'openrouter/z-ai/glm-4.6')).toBe(204800);
  });

  it('prefers an exact id over a suffix that also matches', () => {
    // Both `openai/gpt-4o` and a bare `gpt-4o` are in this catalog on purpose.
    expect(lookupLimit(limits, 'gpt-4o')).toBe(8192);
    expect(lookupLimit(limits, 'openai/gpt-4o')).toBe(128000);
  });

  it('says null rather than guessing', () => {
    expect(lookupLimit(limits, 'some-model-nobody-published')).toBeNull();
    expect(lookupLimit(limits, '')).toBeNull();
  });
});

describe('modelLabel', () => {
  // No catalogue on disk here, which is the case that has to stay readable: a
  // fresh install, or a machine that has never been online, still puts a name
  // on the pill instead of a truncated address.
  it('tidies an id when the catalogue has never been fetched', () => {
    expect(modelLabel('z-ai/glm-4.6')).toBe('Glm 4.6');
    expect(modelLabel('openai/gpt-4o')).toBe('Gpt 4o');
    expect(modelLabel('Qwen3-4B-Instruct.gguf')).toBe('Qwen3 4B Instruct');
  });

  it('says nothing rather than something when there is no id', () => {
    expect(modelLabel(undefined)).toBe('');
    expect(modelLabel('')).toBe('');
  });
});

describe('isStale', () => {
  const now = 1_800_000_000_000;
  it('a missing cache is stale', () => {
    expect(isStale(null, now)).toBe(true);
  });
  it('one day old is stale, one hour old is not', () => {
    expect(isStale({ fetchedAt: now - 25 * 3600_000, limits: {} }, now)).toBe(true);
    expect(isStale({ fetchedAt: now - 3600_000, limits: {} }, now)).toBe(false);
  });
});
