import { describe, it, expect } from 'vitest';
import { jevRoute } from '../JevKeyRow';

describe('jevRoute: one field, any provider', () => {
  it('an OpenRouter key goes through OpenRouter', () => {
    expect(jevRoute('  sk-or-v1-abc ')).toEqual({ baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', via: 'OpenRouter' });
  });
  it('anything else is a TypeSafe console key', () => {
    expect(jevRoute('ts_live_xyz').via).toBe('TypeSafe');
    expect(jevRoute('ts_live_xyz').baseUrl).toBe('https://api.typesafe.ai');
  });
});
