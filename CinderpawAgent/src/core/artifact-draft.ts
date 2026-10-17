/**
 * The document an `artifact_create` call is writing, read while the model is
 * still writing it, so the desktop can show it letter by letter (Darius,
 * 17 Oct: "I watch the text appear live").
 *
 * A tool call's arguments arrive as a JSON object that is cut off anywhere:
 * mid-key, mid-escape, between the two halves of an emoji. `readPartialJson`
 * reads what is there and leaves out whatever has not finished arriving, so the
 * text it returns only ever grows. The tracker turns that into small updates
 * carrying only what was added since the last one.
 *
 * ponytail: every update re-reads the whole argument text, O(n²) over one
 * document. Fine up to ~100 KB; past that, an incremental string decoder.
 */

const INCOMPLETE = Symbol("incomplete");

/**
 * The value at the start of `text`, as far as it has arrived. An unterminated
 * string keeps what it has, minus an escape or a surrogate pair still on its
 * way; an unfinished key, number or literal is left out; anything after the
 * first complete value is ignored. `undefined` when nothing usable is there.
 */
export function readPartialJson(text: string): unknown {
  let i = 0;
  const end = text.length;
  const ws = () => {
    while (i < end && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };

  /** `done` is false when the text ran out before the closing quote. */
  const str = (): { s: string; done: boolean } => {
    i++; // opening quote
    let s = "";
    while (i < end) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return { s, done: true };
      }
      if (c !== "\\") {
        s += c;
        i++;
        continue;
      }
      if (i + 1 >= end) break;
      const e = text[i + 1]!;
      if (e === "u") {
        if (i + 6 > end) break;
        const code = parseInt(text.slice(i + 2, i + 6), 16);
        // A high surrogate alone is half an emoji: wait for its other half.
        if (code >= 0xd800 && code <= 0xdbff && i + 12 > end) break;
        s += String.fromCharCode(code);
        i += 6;
        continue;
      }
      s += ESCAPES[e] ?? e;
      i += 2;
    }
    i = end;
    return { s, done: false };
  };

  const value = (): unknown => {
    ws();
    if (i >= end) return INCOMPLETE;
    const c = text[i]!;
    if (c === '"') return str().s;
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      while (true) {
        ws();
        if (i >= end) return obj;
        if (text[i] === "}") {
          i++;
          return obj;
        }
        if (text[i] !== '"') return obj;
        const key = str();
        if (!key.done) return obj;
        ws();
        if (text[i] !== ":") return obj;
        i++;
        const v = value();
        if (v === INCOMPLETE) return obj;
        obj[key.s] = v;
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return obj;
        } else return obj;
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      while (true) {
        ws();
        if (i >= end) return arr;
        if (text[i] === "]") {
          i++;
          return arr;
        }
        const v = value();
        if (v === INCOMPLETE) return arr;
        arr.push(v);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return arr;
        } else return arr;
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 32));
    if (num) {
      // A number that runs to the end may still be growing.
      if (i + num[0].length >= end) return INCOMPLETE;
      i += num[0].length;
      return Number(num[0]);
    }
    for (const [word, v] of LITERALS) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return INCOMPLETE;
  };

  const v = value();
  return v === INCOMPLETE ? undefined : v;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };
const LITERALS: Array<[string, unknown]> = [["true", true], ["false", false], ["null", null]];

export type DraftUpdate = { draft: string; kind?: string; title?: string; append: string };

/** A tool call written as text, in a shape whose arguments read as JSON. */
const TEXT_CALL = /\{\s*"name"\s*:\s*"artifact_create"/g;
/** The same call in a shape we cannot read (MiniMax invoke-XML…): the openers
 *  are STREAM_HOLD_OPENERS in agent-loop.ts, so prose that only mentions the
 *  tool's name never opens a document. */
const OPAQUE_CALL = /(?:<tool_call|<invoke|```tool|\]<\]minimax\[>\[)[^]*artifact_create/;

/**
 * Turns a growing `artifact_create` call into `artifact_draft` updates. One
 * tracker per model call; `prefix` keeps a retry's drafts apart from the
 * attempt before it.
 */
export function createArtifactDraftTracker(
  prefix: string,
  emit: (u: DraftUpdate) => void,
): { fromArgs(call: number, name: string, args: string): void; fromText(streamed: string): void } {
  const seen = new Map<string, { kind?: string; title?: string; sent: number }>();

  const update = (draft: string, args: unknown): void => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const kind = typeof a.kind === "string" ? a.kind : undefined;
    const title = typeof a.title === "string" ? a.title : undefined;
    const content = typeof a.content === "string" ? a.content : "";
    const prev = seen.get(draft);
    if (prev && prev.kind === kind && prev.title === title && content.length <= prev.sent) return;
    const sent = prev?.sent ?? 0;
    seen.set(draft, { kind, title, sent: Math.max(sent, content.length) });
    emit({
      draft,
      ...(kind !== undefined ? { kind } : {}),
      ...(title !== undefined ? { title } : {}),
      append: content.slice(sent),
    });
  };

  return {
    fromArgs(call, name, args) {
      if (name === "artifact_create") update(`${prefix}:${call}`, readPartialJson(args));
    },
    fromText(streamed) {
      let k = 0;
      for (const m of streamed.matchAll(TEXT_CALL)) {
        const call = readPartialJson(streamed.slice(m.index)) as Record<string, unknown> | undefined;
        update(`${prefix}:t${k++}`, call?.args ?? call?.arguments ?? call?.parameters);
      }
      if (k === 0 && OPAQUE_CALL.test(streamed)) update(`${prefix}:t0`, undefined);
    },
  };
}
