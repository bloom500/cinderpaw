import { createElement, type ReactNode } from 'react';
import { SKIP, visit } from 'unist-util-visit';
import type { Element, ElementContent, Properties, Root, Text } from 'hast';
import { diffLines } from '@/lib/versionDiff';

/**
 * Live writing (Darius, 17 Oct): every letter Cinderpaw writes arrives out of
 * focus and glowing like an ember, sharpens, then cools to the text colour. An
 * edit takes the old letters out the same way backwards and brings the new
 * ones in at the same spot. The look is in globals.css (`.ember-in`,
 * `.ember-out`); this file decides which letters wear it.
 *
 * A letter is known by its offset in the source text, never by where it sits
 * in the rendered tree. The markdown is parsed again on every chunk, and a
 * letter that arrived a second ago must not light up again because the tree
 * around it changed shape. Only letters still animating get a span; the rest
 * are plain text again, so a long document does not keep a span per letter.
 */

/**
 * How long a letter takes to arrive: as long as about TRAIL_LETTERS take to
 * come, between MIN_IN_MS and IN_MS. Claude's recording (20 Oct, frame by
 * frame) settles only the newest word; at a fixed 700 ms a fast model lit
 * hundreds of letters at once behind our cursor.
 */
export const IN_MS = 350;
const MIN_IN_MS = 160;
const TRAIL_LETTERS = 40;
export const OUT_MS = 240;
/** The pace of a slow model's letters, about 140 a second. */
const STAGGER_MS = 7;
/** A chunk's whole stagger, at most: a document that arrives in one piece
 *  (Ollama, Gemini) would otherwise take 9 ms x 10,000 letters to appear. */
const MAX_CHUNK_MS = 600;
/** The fastest a stream is shown, about 200 letters a second. A fast model
 *  (Haiku 5.5, 600 a second) otherwise put a whole table down in a blink and
 *  nobody saw it written (23 Oct, his recording). */
const MIN_PER_MS = 5;
/** ...but the letters never trail the model by more than this: past it they
 *  keep pace again, so a long document does not keep writing for a minute. */
const MAX_BEHIND_MS = 4000;
/** A letter counts as finished a little after its animation ends, so the span
 *  is never taken away while the last frame is still painting. */
const SLACK_MS = 50;

/** Source offsets `[from, to)` that arrived at `at`; letter k starts k x `per` ms later
 *  and takes `dur` ms (IN_MS when not given). */
export type Run = { from: number; to: number; at: number; per: number; dur?: number };

const runDur = (per: number) => Math.max(MIN_IN_MS, Math.min(IN_MS, Math.round(per * TRAIL_LETTERS)));
/** What to animate, as of `now`. `out` are offsets leaving (an edit's old words).
 *  `caret`: where Cinderpaw is writing, drawn as a cursor carrying its name. */
export type Ember = { runs: Run[]; out?: Array<[number, number]>; now: number; caret?: { at: number; name: string } };

/** A collaborator's cursor, as in a shared document (Claude Docs, 20 Oct). */
function caretNode(name: string): ElementContent {
  return { type: 'element', tagName: 'span', properties: { className: ['ember-caret'], dataName: name, ariaHidden: 'true' }, children: [] };
}

export function chunkRun(from: number, text: string, at: number): Run {
  const per = Math.min(STAGGER_MS, MAX_CHUNK_MS / Math.max(1, text.length));
  return { from, to: from + text.length, at, per, dur: runDur(per) };
}

/**
 * The next piece of a stream, `gap` ms after the piece before (`prev`, its
 * run): it starts where that piece's letters stop and spreads over the gap, so
 * letters come in one after another at the pace the model writes. At a fixed
 * 9 ms a letter (111 a second), a model writing 300-600 a second lit three to
 * five pieces at once, out of order, with the cursor a line ahead (20 Oct).
 */
export function streamRun(prev: Run | undefined, from: number, text: string, now: number, gap: number): Run {
  const at = prev ? Math.max(now, prev.at + Math.round((prev.to - prev.from) * prev.per)) : now;
  const len = Math.max(1, text.length);
  const natural = Math.min(STAGGER_MS, Math.min(gap, MAX_CHUNK_MS) / len);
  const room = (now + MAX_BEHIND_MS - at) / len;
  const per = Math.max(natural, Math.min(MIN_PER_MS, room));
  return { from, to: from + text.length, at, per, dur: runDur(per) };
}

/** How far the letters have come by `now`: where the writing cursor belongs
 *  while the text after it is still to appear. Undefined when nothing is moving. */
export function revealedTo(runs: Run[], now: number): number | undefined {
  let end: number | undefined;
  for (const r of runs) {
    const shown = now < r.at ? r.from : Math.min(r.to, r.from + Math.floor((now - r.at) / Math.max(r.per, 0.001)) + 1);
    end = Math.max(end ?? 0, shown);
  }
  return end;
}

/** The letter's animation (delay, length) while it is still animating, else null. */
function letterAt(runs: Run[], offset: number, now: number): { delay: number; dur: number } | null {
  for (const r of runs) {
    if (offset < r.from || offset >= r.to) continue;
    const delay = Math.round((offset - r.from) * r.per);
    const dur = r.dur ?? IN_MS;
    return now - r.at > delay + dur + SLACK_MS ? null : { delay, dur };
  }
  return null;
}

/** The letter's animation delay while it is still animating, else null. */
export function letterDelay(runs: Run[], offset: number, now: number): number | null {
  return letterAt(runs, offset, now)?.delay ?? null;
}

/** When the last letter of these runs has finished (0 for none). */
export function liveUntil(runs: Run[]): number {
  let end = 0;
  for (const r of runs) end = Math.max(end, r.at + Math.round(Math.max(0, r.to - r.from - 1) * r.per) + (r.dur ?? IN_MS));
  return end;
}

/** Whether anything in source offsets `[from, to)` is still moving. */
export function emberActive(e: Ember, from: number, to: number): boolean {
  if (e.out?.some(([a, b]) => a < to && b > from)) return true;
  return e.runs.some((r) => r.from < to && r.to > from && liveUntil([r]) + SLACK_MS > e.now);
}

type Mark = 'out' | { delay: number; dur: number } | null;
type Piece = string | { word: string; letters: Array<[string, Mark]> | null };

function markAt(e: Ember, offset: number): Mark {
  if (e.out?.some(([a, b]) => offset >= a && offset < b)) return 'out';
  return letterAt(e.runs, offset, e.now);
}

/**
 * One text, cut into spaces and words. Every word is its own piece (a stable
 * place for React to keep it); its letters are listed only while one of them
 * is still moving, so a word that has settled is plain text again.
 */
function pieces(value: string, offsetAt: (i: number) => number, e: Ember): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  for (const token of value.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s/.test(token)) {
      out.push(token);
    } else {
      const letters: Array<[string, Mark]> = [];
      let moving = false;
      let j = i;
      for (const ch of token) {
        const m = markAt(e, offsetAt(j));
        if (m !== null) moving = true;
        letters.push([ch, m]);
        j += ch.length;
      }
      out.push({ word: token, letters: moving ? letters : null });
    }
    i += token.length;
  }
  return out;
}

function letterProps(m: Mark): Properties {
  if (m === 'out') return { className: ['ember-out'] };
  if (m === null) return {};
  return { className: ['ember-in'], style: `animation-delay:${m.delay}ms;animation-duration:${m.dur}ms` };
}

/**
 * Rehype plugin for one markdown block whose source starts at `base` in the
 * whole document. Code, pre and maths are left alone, as the chat's word fade
 * leaves them: their text must stay intact for highlighting and copying.
 */
export function rehypeEmber(opts: Ember & { base: number; source: string }) {
  return (tree: Root) => {
    let caretPlaced = false;
    visit(tree, (node, index, parent) => {
      if (node.type === 'element') {
        const el = node as Element;
        const cls = el.properties?.className;
        if (el.tagName === 'code' || el.tagName === 'pre' || (Array.isArray(cls) && cls.some((c) => String(c).startsWith('katex')))) return SKIP;
        return;
      }
      if (node.type !== 'text' || parent == null || index == null) return;
      const text = node as Text;
      const start = text.position?.start.offset;
      if (start === undefined || !/\S/.test(text.value)) return;
      // An entity or an escape makes the text differ from its source; then the
      // whole node goes by where it starts, which is close enough to look right.
      const exact = opts.source.slice(start, start + text.value.length) === text.value;
      const at = (i: number) => opts.base + (exact ? start + i : start);
      // ponytail: the cursor goes at the end of the text it is in. A part is
      // written over a placeholder paragraph of its own, so the writing edge is
      // a node's end; mid-node it would sit a few letters late.
      const withCaret = !caretPlaced && opts.caret !== undefined && opts.caret.at >= at(0) && opts.caret.at <= at(text.value.length);
      const replacement: ElementContent[] = pieces(text.value, at, opts).map((p) =>
        typeof p === 'string'
          ? { type: 'text', value: p }
          : {
              type: 'element',
              tagName: 'span',
              properties: { className: ['ember-word'] },
              children: p.letters
                ? p.letters.map(([ch, m]): ElementContent => ({ type: 'element', tagName: 'span', properties: letterProps(m), children: [{ type: 'text', value: ch }] }))
                : [{ type: 'text', value: p.word }],
            },
      );
      if (withCaret) {
        caretPlaced = true;
        replacement.push(caretNode(opts.caret!.name));
      }
      (parent as Element).children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
}

/** The same for plain text in a `<pre>`: the plain string once nothing moves. */
export function emberText(text: string, e: Ember): ReactNode {
  const caret = e.caret ? createElement('span', { key: 'caret', className: 'ember-caret', 'data-name': e.caret.name, 'aria-hidden': true }) : null;
  if (!emberActive(e, 0, text.length)) return caret ? [text, caret] : text;
  const shown = pieces(text, (i) => i, e).map((p, k) =>
    typeof p === 'string'
      ? p
      : createElement(
          'span',
          { key: k, className: 'ember-word' },
          p.letters
            ? p.letters.map(([ch, m], n) =>
                createElement('span', {
                  key: n,
                  className: m === 'out' ? 'ember-out' : m === null ? undefined : 'ember-in',
                  style: m && m !== 'out' ? { animationDelay: `${m.delay}ms`, animationDuration: `${m.dur}ms` } : undefined,
                }, ch),
              )
            : p.word,
        ),
  );
  return caret ? [...shown, caret] : shown;
}

const tokens = (s: string) => s.split(/(\s+)/).filter(Boolean);

/**
 * What an edit takes out (offsets in `before`) and brings in (runs in `after`,
 * starting at `at`). Line by line first, then word by word inside the lines
 * that changed, with the same diff that "What changed" uses. Null when that
 * diff gives up on a text this long.
 */
export function editRuns(before: string, after: string, at: number): { out: Array<[number, number]>; runs: Run[] } | null {
  const lines = diffLines(before.split('\n'), after.split('\n'));
  if (!lines) return null;
  const out: Array<[number, number]> = [];
  const runs: Run[] = [];
  let oa = 0;
  let ob = 0;
  let k = 0;
  while (k < lines.length) {
    if (lines[k]!.kind === 'same') {
      oa += lines[k]!.text.length + 1;
      ob += lines[k]!.text.length + 1;
      k++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    const [ha, hb] = [oa, ob];
    for (; k < lines.length && lines[k]!.kind !== 'same'; k++) {
      const l = lines[k]!;
      (l.kind === 'removed' ? removed : added).push(l.text);
      if (l.kind === 'removed') oa += l.text.length + 1;
      else ob += l.text.length + 1;
    }
    const was = removed.join('\n');
    const now = added.join('\n');
    const words = diffLines(tokens(was), tokens(now));
    if (!words) {
      if (was) out.push([ha, ha + was.length]);
      if (now) runs.push(chunkRun(hb, now, at));
      continue;
    }
    // Neighbouring changed words become one range, so a new phrase comes in
    // as one chunk, letter after letter.
    let pa = ha;
    let pb = hb;
    let outFrom = -1;
    let inFrom = -1;
    const close = () => {
      if (outFrom >= 0) out.push([outFrom, pa]);
      if (inFrom >= 0) runs.push(chunkRun(inFrom, after.slice(inFrom, pb), at));
      outFrom = inFrom = -1;
    };
    for (const w of words) {
      if (w.kind === 'same') {
        close();
        pa += w.text.length;
        pb += w.text.length;
      } else if (w.kind === 'removed') {
        if (outFrom < 0) outFrom = pa;
        pa += w.text.length;
      } else {
        if (inFrom < 0) inFrom = pb;
        pb += w.text.length;
      }
    }
    close();
  }
  return { out, runs };
}
