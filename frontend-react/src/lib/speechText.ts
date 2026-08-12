/**
 * Turn a chat reply into something worth hearing.
 *
 * Markdown is written to be read. Spoken verbatim, a reply comes out as
 * "asterisk asterisk important asterisk asterisk" and a fenced code block turns
 * into a minute of punctuation read one character at a time — which, on a
 * metered TTS provider, is also money spent on noise.
 *
 * Deliberately not a Markdown parser. It strips the marks that hurt when spoken
 * and leaves everything else alone; anything it misses is a word said slightly
 * oddly, not a broken call.
 */
/**
 * How much finished text to accumulate before sending a piece to be spoken.
 *
 * Small enough that the first words come out seconds after the model starts, large
 * enough that a reply is a handful of synthesis requests rather than dozens — each
 * one is a round trip, and each seam is a place the engine re-decides its prosody.
 */
export const SPEAK_CHUNK_CHARS = 160;

/**
 * Threshold for the FIRST piece of a reply — deliberately much lower.
 *
 * 160 characters is a reasonable batch once someone is already listening, but it
 * meant nothing ever qualified early: real replies here run 96–135 characters, so
 * the whole answer waited for the end-of-stream flush and the streaming path never
 * fired at all. The first sentence is the one that has to leave immediately; after
 * that, bigger batches keep the seams down.
 */
export const FIRST_PIECE_CHARS = 40;

/**
 * Phrases Whisper emits when it has nothing real to transcribe.
 *
 * Documented artefacts of its training data — it learned from subtitle tracks, so
 * on quiet or unclear audio it reproduces their boilerplate. They are not what the
 * user said, and they reached the agent as genuine turns: a request to search the
 * web came back as "Nu uitați să vă abonați la canal!", and quiet rooms came back
 * as "Thank you." and as Japanese closing credits.
 */
const HALLUCINATION_PATTERNS = [
  /^nu uita(ț|t)i[^.!?]*abona(ț|t)i/i, // "nu uitați să vă abonați…"
  /^mul(ț|t)umesc pentru (viz|urm)/i, // "mulțumesc pentru vizionare"
  /^(subtitr(a|ă)ri|subtitles|subs)\b.*\b(de|by)\b/i,
  /^(thank you|thanks for watching)[.!]?$/i,
  /^(ご視聴ありがとうございました|字幕)/,
  /^\[?(muzic(ă|a)|music|applause|aplauze)\]?[.!]?$/i,
];

/** Above this length, a matching transcript is treated as real speech. */
const HALLUCINATION_MAX_CHARS = 60;

/**
 * Is this transcript one of Whisper's stock phrases rather than something spoken?
 *
 * A blocklist is crude and it is still the right tool here: these are model
 * artefacts with known text, each one costs a full agent turn, and the alternative
 * — passing them on — makes the agent answer a question nobody asked. Only short
 * transcripts are checked; the same words inside a longer sentence were probably
 * really said, and discarding real speech is the worse mistake.
 */
export function isLikelyHallucination(transcript: string): boolean {
  const text = transcript.trim();
  if (!text || text.length > HALLUCINATION_MAX_CHARS) return false;
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

/**
 * Split streamed text into a piece ready to speak and the remainder.
 *
 * Only ever cuts at a sentence end, and only once there is enough text to be worth
 * a request — mid-phrase seams are heard as glitches, while a seam at a full stop
 * is heard as a breath. `null` means "not yet": keep accumulating.
 */
export function takeSpeakable(
  pending: string,
  streamFinished: boolean,
  minChars = SPEAK_CHUNK_CHARS,
): { speak: string; rest: string } | null {
  const text = pending.trimStart();
  if (!text) return null;
  // The stream is over: whatever is left is the last piece, boundary or not.
  if (streamFinished) return { speak: text, rest: '' };
  if (text.length < minChars) return null;
  const cut = lastSentenceEnd(text, text.length);
  if (cut <= 0) return null; // one long unfinished sentence — wait for its end
  return { speak: text.slice(0, cut + 1).trim(), rest: text.slice(cut + 1) };
}

/** The last sentence end at or before `limit`, or -1. `.!?` must be followed by
 *  whitespace, so a period inside "3.14" or "e.g." is not a boundary. */
function lastSentenceEnd(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  return Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('\n'),
  );
}

/**
 * Split a reply so speaking can start before the whole thing is synthesised, and
 * so an interruption cannot waste a minute of audio.
 *
 * A short head goes first — that is the latency win, the listener hears a voice
 * a second after the reply lands instead of after the last token. The rest is cut
 * into bounded parts rather than one blob, and that second rule was paid for in
 * evidence: a 982-character answer split into 32 + 935 characters, and the tail
 * came back as **68 seconds** of synthesised speech. Barging in one second later
 * threw all of it away — already generated, already charged for, on an engine
 * that bills per character.
 *
 * Every cut lands on a sentence end. A seam mid-phrase is heard as a glitch,
 * while a seam at a full stop is heard as a breath; if no boundary exists inside
 * a window the text stays whole, which is slower and never wrong.
 */
export function splitForPipeline(text: string, headChars = 140, partChars = 420): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= headChars) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;

  // The head is deliberately smaller than the rest: it only has to be long
  // enough to sound like a sentence and short enough to synthesise fast.
  const headEnd = lastSentenceEnd(rest, headChars);
  if (headEnd <= 0) return [trimmed]; // nowhere to cut without cutting a phrase
  parts.push(rest.slice(0, headEnd + 1).trim());
  rest = rest.slice(headEnd + 1).trim();

  while (rest.length > partChars) {
    const cut = lastSentenceEnd(rest, partChars);
    // One sentence longer than a whole part: keep it whole rather than seam it.
    if (cut <= 0) break;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);

  return parts.filter((p) => p.length > 0);
}

export function forSpeech(markdown: string): string {
  return (
    markdown
      // Fenced code: announce it instead of reading it. Someone on a call wants
      // to know code arrived, then read it on screen.
      .replace(/```[\s\S]*?```/g, ' (code on screen) ')
      .replace(/`([^`]+)`/g, '$1')
      // Images before links: `![alt](url)` would otherwise leave a stray "!".
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading marks
      .replace(/^\s{0,3}>\s?/gm, '') // block quotes
      .replace(/^\s*[-*+]\s+/gm, '') // bullets
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
      .replace(/(?<![\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1') // italics
      .replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, '') // horizontal rules
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
}
