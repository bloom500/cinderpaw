import { describe, it, expect } from 'vitest';
import {
  contextWindowFor,
  estimateTokens,
  estimateRemaining,
  LOCAL_DEFAULT_CONTEXT,
  CLOUD_DEFAULT_CONTEXT,
} from '../contextWindow';

describe('contextWindowFor', () => {
  it('returns 1_000_000 for minimax', () => {
    expect(contextWindowFor('minimax-text-01', false)).toBe(1_000_000);
  });
  it('returns 200_000 for claude', () => {
    expect(contextWindowFor('claude-3-opus', false)).toBe(200_000);
  });
  it('returns LOCAL_DEFAULT_CONTEXT for unknown local model', () => {
    expect(contextWindowFor('unknown-gguf', true)).toBe(LOCAL_DEFAULT_CONTEXT);
  });
  it('returns CLOUD_DEFAULT_CONTEXT for unknown cloud model', () => {
    expect(contextWindowFor(undefined, false)).toBe(CLOUD_DEFAULT_CONTEXT);
  });
});

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateRemaining', () => {
  it('calculates freeTokens as window - used', () => {
    const r = estimateRemaining(8192, 1000, 5);
    expect(r.freeTokens).toBe(7192);
  });

  it('calculates msgsRemaining using avg tokens per message', () => {
    // avg = 1000 / 5 = 200 tokens/msg, free = 7192, msgs = floor(7192/200) = 35
    const r = estimateRemaining(8192, 1000, 5);
    expect(r.msgsRemaining).toBe(35);
    expect(r.showAsTokens).toBe(false);
  });

  it('uses fallback of 200 tokens/msg when messageCount is 0', () => {
    // free = 8192, avg = 200 (fallback), msgs = floor(8192/200) = 40
    const r = estimateRemaining(8192, 0, 0);
    expect(r.msgsRemaining).toBe(40);
    expect(r.showAsTokens).toBe(false);
  });

  it('sets showAsTokens when less than 1 message remains', () => {
    // avg = 500/1 = 500, free = 8192 - 8100 = 92, msgs = floor(92/500) = 0
    const r = estimateRemaining(8192, 8100, 1);
    expect(r.msgsRemaining).toBe(0);
    expect(r.showAsTokens).toBe(true);
    expect(r.freeTokens).toBe(92);
  });

  it('clamps freeTokens to 0 when over limit', () => {
    const r = estimateRemaining(1000, 1500, 10);
    expect(r.freeTokens).toBe(0);
    expect(r.msgsRemaining).toBe(0);
    expect(r.showAsTokens).toBe(true);
  });
});
