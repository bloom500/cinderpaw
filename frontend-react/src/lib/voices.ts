import type { TtsVoice } from './tauri';

/** How many voices the picker offers at once. */
export const VOICE_SHORTLIST = 5;

/**
 * Languages this app is used in, and therefore the only voice languages worth
 * offering. Not a universal truth — it is the pair the interface itself ships
 * (`LangPref`), and a voice in a language the user cannot check is a voice they
 * cannot judge.
 */
const READABLE_LANGS = ['ro', 'en'];

/**
 * Does this label read like a name a person would choose?
 *
 * Fish's `/model` returns the public community library, not the account's own
 * voices, so the catalogue is full of uploads named `a2ksi`, `adam adam` and
 * worse. These rules are heuristics and they are deliberately conservative —
 * anything they wrongly drop is still reachable by pasting its id.
 */
/** The name part of a label — everything before the `·` decorations. */
function plainName(label: string): string {
  return (label.split('·')[0] ?? '').trim();
}

/**
 * Is this a plain, sayable first name — "Alina", "Emil", "alloy" — rather than a
 * description, a handle or a sentence?
 *
 * One word of letters, nothing else. Used to rank rather than to exclude: a voice
 * with a descriptive label still works, it just should not be the one offered
 * first when a person is scanning a short list.
 */
export function looksLikeACommonName(label: string): boolean {
  return /^[\p{L}][\p{L}'-]{1,15}$/u.test(plainName(label));
}

export function looksLikeAName(label: string): boolean {
  const name = label.trim();
  if (name.length < 3) return false;
  // Digits and underscores mark generated or throwaway names: `a2ksi`, `voice_01`.
  if (/[0-9_]/.test(name)) return false;
  // Letters outside the Latin script: Chinese, Cyrillic, Arabic, emoji. Not a
  // judgement on the voice — a label the user cannot read is not a choice they
  // can make, and the language filter below would drop most of them anyway.
  if (/[^\p{Script=Latin}\p{P}\p{Zs}\p{M}·]/u.test(name)) return false;
  // The same word twice: `adam adam`.
  const words = name.toLowerCase().split(/\s+/);
  if (words.length > 1 && new Set(words).size === 1) return false;
  return true;
}

/**
 * Cut a vendor's voice catalogue down to a shortlist worth reading.
 *
 * Fish returns 100 voices, most of them named in languages the user does not
 * speak; a hundred-row dropdown is not a choice, it is a wall. So the list is
 * ranked and cut here rather than in Rust: relevance depends on the language the
 * user speaks, which is UI state, and the command keeps returning everything so
 * nothing is hidden from a caller that wants it all.
 *
 * Order:
 *   1. voices in the language being spoken — the ones that will sound right
 *   2. multilingual voices (`locale` empty) — they follow the text, so they work
 *      in a bilingual call
 *   3. everything else, alphabetically, so the cut is at least predictable
 *
 * An explicitly chosen voice is always kept, even if it ranks last: a shortlist
 * that silently drops the voice currently speaking would look like it reset.
 */
export function shortlistVoices(
  voices: TtsVoice[],
  spokenLocale: string | null,
  chosenId?: string,
  limit = VOICE_SHORTLIST,
): TtsVoice[] {
  const lang = (spokenLocale ?? '').slice(0, 2).toLowerCase();
  // Language first, then how the name reads. A plain first name is what someone
  // scanning five rows can actually choose between; "Wang Wei — energetic podcast
  // host v2" is a description, and a list of descriptions is a wall again.
  const rank = (v: TtsVoice) => {
    const spoken = lang && v.locale.slice(0, 2).toLowerCase() === lang ? 0 : v.locale ? 4 : 2;
    return spoken + (looksLikeACommonName(v.label) ? 0 : 1);
  };

  // Two filters, both about being able to judge what you are choosing: a label
  // you can read, in a language you speak. A multilingual voice (empty locale)
  // always qualifies — it follows the text.
  const usable = voices.filter((v) => {
    if (!looksLikeAName(v.label)) return false;
    const l = v.locale.slice(0, 2).toLowerCase();
    return !l || READABLE_LANGS.includes(l) || l === lang;
  });

  const sorted = [...usable].sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
  );
  const top = sorted.slice(0, limit);

  const chosen = chosenId && voices.find((v) => v.id === chosenId);
  if (chosen && !top.some((v) => v.id === chosen.id)) {
    // Replace the last row rather than growing past the limit.
    top.splice(Math.max(0, limit - 1), 1, chosen);
  }
  return top;
}

/**
 * The voice to pin when the user has not chosen one.
 *
 * There is deliberately no "let the vendor decide" option any more. Fish resolves
 * its default **per request**, so leaving it unset produced a different voice in
 * one reply than in the next — the exact inconsistency that reads as unfinished
 * software. A concrete voice, chosen for them and then held, is the professional
 * behaviour; they can change it, but never to "unspecified".
 */
export function preferredVoice(voices: TtsVoice[], spokenLocale: string | null): TtsVoice | null {
  return shortlistVoices(voices, spokenLocale)[0] ?? voices[0] ?? null;
}
