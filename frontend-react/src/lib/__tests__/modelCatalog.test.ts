import { describe, it, expect } from 'vitest';
import { isStale, lookupLimit, parseCatalog } from '../modelCatalog';

// One real row per shape, copied from https://openrouter.ai/api/v1/models
// (fetched 2026-09-16) so the parser is tested against what the endpoint sends.
const payload = {
  data: [
    { id: 'z-ai/glm-4.6', context_length: 204800 },
    { id: 'google/gemini-2.5-pro', context_length: 1048576 },
    { id: 'openai/gpt-4o', context_length: 128000 },
    { id: 'gpt-4o', context_length: 8192 },
    { id: 'broken/no-length' },
    { context_length: 4096 },
  ],
};

describe('parseCatalog', () => {
  it('keeps the rows that carry a length and drops the rest', () => {
    const limits = parseCatalog(payload);
    expect(limits['z-ai/glm-4.6']).toBe(204800);
    expect(limits['google/gemini-2.5-pro']).toBe(1048576);
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
