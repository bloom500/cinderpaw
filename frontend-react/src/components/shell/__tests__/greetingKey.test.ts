import { describe, it, expect } from 'vitest';
import { greetingKey } from '../HomeGreeting';

describe('greetingKey', () => {
  it('follows the local hour, with the night owl past 23:00 and before 5:00', () => {
    expect(greetingKey(7)).toBe('home.morning');
    expect(greetingKey(13)).toBe('home.afternoon');
    expect(greetingKey(22)).toBe('home.evening');
    expect(greetingKey(23, 2)).toBe('home.night.1');
    expect(greetingKey(2, 3)).toBe('home.night.2');
    expect(greetingKey(5)).toBe('home.morning');
  });
});
