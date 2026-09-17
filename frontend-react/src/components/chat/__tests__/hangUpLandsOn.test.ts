import { describe, expect, it } from 'vitest';
import { hangUpLandsOn } from '../ChatInput';

describe('the red X in a call', () => {
  it('ends a live call and stays on the call screen', () => {
    for (const phase of ['connecting', 'listening', 'thinking', 'speaking', 'reconnecting']) {
      expect(hangUpLandsOn(phase)).toBe('ready');
    }
  });

  it('on the call screen itself, leaves for the chat', () => {
    expect(hangUpLandsOn('ready')).toBe('idle');
  });
});
