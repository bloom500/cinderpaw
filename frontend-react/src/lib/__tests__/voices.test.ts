import { describe, it, expect } from 'vitest';
import {
  looksLikeACommonName,
  looksLikeAName,
  preferredVoice,
  shortlistVoices,
  VOICE_SHORTLIST,
} from '../voices';
import type { TtsVoice } from '../tauri';

const v = (id: string, label: string, locale = ''): TtsVoice => ({ id, label, locale });

describe('looksLikeAName', () => {
  it('accepts names a person would actually choose', () => {
    for (const name of ['Alina', 'Ava · English (US)', 'Jean-Luc', 'María José', 'Emil']) {
      expect(looksLikeAName(name), name).toBe(true);
    }
  });

  it('rejects the community-upload junk Fish returns', () => {
    // Real examples from the library: generated handles, duplicated words, and
    // labels in scripts the user cannot read.
    for (const junk of ['a2ksi', 'voice_01', 'adam adam', 'AB', '好听的声音', 'Голос']) {
      expect(looksLikeAName(junk), junk).toBe(false);
    }
  });
});

describe('looksLikeACommonName', () => {
  it('accepts a plain first name, with or without decorations after it', () => {
    for (const label of ['Alina', 'alloy', 'Emil · Romanian (Romania)', 'Jean-Luc · french']) {
      expect(looksLikeACommonName(label), label).toBe(true);
    }
  });

  it('rejects descriptions dressed up as names', () => {
    for (const label of ['Energetic podcast host', 'Narrator v2', 'Wang Wei']) {
      expect(looksLikeACommonName(label), label).toBe(false);
    }
  });
});

describe('preferredVoice', () => {
  it('always returns something to pin when any voice exists', () => {
    // There is no "let the vendor decide" any more: unspecified meant Fish chose
    // per request, so one reply spoke in one voice and the next in another.
    const list = [v('x', 'Energetic podcast host'), v('ro1', 'Alina', 'ro-RO')];
    expect(preferredVoice(list, 'ro')?.id).toBe('ro1');
    expect(preferredVoice([v('only', 'Whatever description here')], null)?.id).toBe('only');
    expect(preferredVoice([], 'ro')).toBeNull();
  });
});

describe('shortlistVoices', () => {
  const catalogue = [
    v('zh1', 'Wang', 'zh-CN'),
    v('ru1', 'Ivan', 'ru-RU'),
    v('ro1', 'Alina', 'ro-RO'),
    v('multi', 'Aurora'),
    v('en1', 'Ava', 'en-US'),
    v('ro2', 'Emil', 'ro-RO'),
    v('ja1', 'Nanami', 'ja-JP'),
  ];

  it('drops junk labels and languages the user does not speak', () => {
    // What Fish's public library actually looks like next to the useful rows.
    const messy = [
      ...catalogue,
      v('junk1', 'a2ksi'),
      v('junk2', 'adam adam'),
      v('ar1', 'AboFlah', 'ar-SA'),
    ];
    const ids = shortlistVoices(messy, 'ro').map((x) => x.id);
    expect(ids).not.toContain('junk1');
    expect(ids).not.toContain('junk2');
    expect(ids).not.toContain('ar1'); // Arabic: readable label, unusable language
    expect(ids).not.toContain('zh1');
    expect(ids).toContain('ro1');
  });

  it('never offers more than the shortlist limit', () => {
    // Fish returns a hundred; a hundred-row dropdown is a wall, not a choice.
    // Fewer than the limit is fine and expected — the filters come first, so a
    // catalogue with little in the user's languages simply yields a short list.
    const many = [
      ...catalogue,
      v('en2', 'Brian', 'en-GB'),
      v('en3', 'Clara', 'en-US'),
      v('en4', 'Daniel', 'en-AU'),
      v('multi2', 'Ember'),
    ];
    expect(shortlistVoices(many, 'ro')).toHaveLength(VOICE_SHORTLIST);
    expect(shortlistVoices(catalogue, 'ro').length).toBeLessThanOrEqual(VOICE_SHORTLIST);
  });

  it('puts the spoken language first, then multilingual voices', () => {
    const ids = shortlistVoices(catalogue, 'ro').map((x) => x.id);
    expect(ids.slice(0, 2).sort()).toEqual(['ro1', 'ro2']);
    expect(ids[2]).toBe('multi');
  });

  it('falls back to multilingual first when no language is known', () => {
    expect(shortlistVoices(catalogue, null)[0].id).toBe('multi');
  });

  it('keeps the chosen voice even when it ranks below the cut', () => {
    // A shortlist that drops the voice currently speaking looks like a reset.
    const ids = shortlistVoices(catalogue, 'ro', 'ja1').map((x) => x.id);
    expect(ids).toContain('ja1');
    expect(ids).toHaveLength(VOICE_SHORTLIST);
  });

  it('does not duplicate the chosen voice when it already ranks high', () => {
    const ids = shortlistVoices(catalogue, 'ro', 'ro1').map((x) => x.id);
    expect(ids.filter((id) => id === 'ro1')).toHaveLength(1);
  });
});
