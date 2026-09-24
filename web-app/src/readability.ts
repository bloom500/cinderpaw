// Flesch-Kincaid grade level (spec 2026-09-24 §8.4). A heuristic, like every
// FK counter: vowel groups, minus a silent final "e". Good enough to catch a
// sentence written for engineers.

// Product names are names, not vocabulary: nobody has to understand the
// word "OpenRouter" to press a button that says it.
const NAMES = new Set(["openrouter", "cinderpaw", "ollama", "discord", "telegram", "whatsapp"]);

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (NAMES.has(w)) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 0);
}

export function fkGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}
