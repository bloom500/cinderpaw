import { describe, it, expect } from 'vitest';
import {
  activeContextWindow,
  contextWindowFor,
  estimateTokens,
  estimateRemaining,
  isLocalBaseUrl,
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

describe('activeContextWindow', () => {
  const localGguf = { name: 'Qwythos-9B.gguf', ctx_len: 8192 };

  // The reported bug: MiniMax M3 active (1M window), a local GGUF still
  // resident as the offline fallback → the ring showed 8192.
  it('a resident local GGUF does not shrink the window of an active cloud model', () => {
    const { ctxWindow, isLocal } = activeContextWindow({
      isAgentMode: true,
      cinderpawConfig: { model: 'MiniMax-M3', base_url: 'https://api.minimax.io/v1' },
      loaded: localGguf,
    });
    expect(isLocal).toBe(false);
    expect(ctxWindow).toBe(1_000_000);
  });

  it('uses the loaded engine real KV cache when the local model is the active one', () => {
    const { ctxWindow, isLocal } = activeContextWindow({
      isAgentMode: true,
      cinderpawConfig: { model: 'Qwythos-9B.gguf', base_url: 'http://127.0.0.1:11435/v1' },
      loaded: localGguf,
    });
    expect(isLocal).toBe(true);
    // ctx_len wins over the model name (which advertises 1M but loads at 8192).
    expect(ctxWindow).toBe(8192);
  });

  it('falls back to the local default when nothing is loaded', () => {
    const { ctxWindow } = activeContextWindow({
      isAgentMode: true,
      cinderpawConfig: { model: 'mystery.gguf', base_url: 'http://localhost:11435/v1' },
      loaded: null,
    });
    expect(ctxWindow).toBe(LOCAL_DEFAULT_CONTEXT);
  });

  it('chat mode with a cloud model ignores the loaded GGUF too', () => {
    const { ctxWindow } = activeContextWindow({
      isAgentMode: false,
      cloudModel: { modelId: 'claude-3-opus' },
      loaded: localGguf,
    });
    expect(ctxWindow).toBe(200_000);
  });
});

describe('isLocalBaseUrl', () => {
  it('treats loopback as local', () => {
    expect(isLocalBaseUrl('http://127.0.0.1:11435/v1')).toBe(true);
    expect(isLocalBaseUrl('http://localhost:1337/v1')).toBe(true);
  });

  // The regression: MiniMax BYOK is wired through the `openai_compatible`
  // provider, so a provider-name test called it local and the ring sized
  // itself to the local GGUF's 8192 KV cache instead of MiniMax's 1M window.
  it('treats a BYOK cloud URL as cloud even on an openai_compatible provider', () => {
    expect(isLocalBaseUrl('https://api.minimax.io/v1')).toBe(false);
  });

  it('is false for a missing or malformed URL', () => {
    expect(isLocalBaseUrl(undefined)).toBe(false);
    expect(isLocalBaseUrl('not a url')).toBe(false);
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
