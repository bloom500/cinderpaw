import { describe, it, expect } from 'vitest';
import { cleanTitle } from '../chatTitle';

describe('cleanTitle', () => {
  it('keeps the words and drops what models wrap them in', () => {
    expect(cleanTitle('"Zbor spre Lisabona în octombrie."')).toBe('Zbor spre Lisabona în octombrie');
    expect(cleanTitle('Title: Quarterly report draft')).toBe('Quarterly report draft');
    expect(cleanTitle('<think>the user wants a flight</think>\nLisbon flight search')).toBe('Lisbon flight search');
  });

  it('never returns a title longer than a sidebar row', () => {
    expect(cleanTitle('a'.repeat(80)).length).toBeLessThanOrEqual(48);
  });
});
