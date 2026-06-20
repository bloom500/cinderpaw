/**
 * Module A — embed bridge to the Phase-0 Rust `embed_text` command.
 *
 * The actual embeddings live in Rust (`src-tauri/src/inference.rs`, embedding
 * context loaded with a bundled bge-small GGUF). The sidecar doesn't talk
 * HTTP — it routes through the existing stdin/stdout `RsiBridge` (the same
 * mechanism the RSI engine uses for `rsi_commit_genome`, `rsi_ratchet_attempt`,
 * `rsi_score`). The Rust dispatcher `handle_rsi_request` will route the new
 * method `embed_text` to the Phase-0 handler once it lands.
 *
 * This module is pure plumbing:
 *   - **Batching**: a single `embed([a,b,c])` → one bridge call, one network
 *     roundtrip to Rust, three vectors back. Never one-per-text.
 *   - **Order preservation**: result[i] corresponds to texts[i], always.
 *   - **Cache**: text-keyed (FNV-1a content hash) so a snapshot rebuild
 *     never re-embeds identical rows. Cache is process-local; in the live
 *     sidecar it persists for the life of the process, which is what we
 *     want (the same chat session re-uses the same embeddings).
 *   - **DI for tests**: the invoker is injectable so unit tests use a
 *     fake and never hit Rust. `setEmbedInvoker(...)` is called once at
 *     sidecar startup with the real bridge; tests pass an invoker
 *     directly to `embed(texts, invoker)`.
 */
import type { RsiBridge } from "../../rsi/bridge.ts";

/**
 * Function that takes a batch of texts and returns one L2-normalized
 * `Float32Array` per input, in order. Production wires this to the
 * `RsiBridge`; tests wire it to a fake.
 */
export type EmbedInvoker = (texts: string[]) => Promise<Float32Array[]>;

/** Default invoker — set once at sidecar startup with `setEmbedInvoker`. */
let defaultInvoker: EmbedInvoker | null = null;

/** Install the production invoker. Call once at sidecar startup. */
export function setEmbedInvoker(invoker: EmbedInvoker): void {
  defaultInvoker = invoker;
}

/** Drop all cached embeddings. Test helper — never call in production. */
export function resetEmbedCache(): void {
  cache.clear();
}

/**
 * Process-local text→vector cache, keyed by the exact text. We key on the
 * full string (not a content hash) so two distinct texts can never collide
 * onto the same cached vector — a 32-bit hash would make that a silent,
 * wrong-answer bug. `Map` already hashes the key internally.
 */
const cache = new Map<string, Float32Array>();

/** L2-normalize a Float32Array in place; returns it for chaining. */
function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i]! * v[i]!;
  if (sq <= 0) return v;
  const inv = 1 / Math.sqrt(sq);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/**
 * Embed a batch of texts. Returns one L2-normalized `Float32Array` per
 * input, in input order. Reads from the cache first; the invoker is
 * called only with the texts that aren't already cached, in one batched
 * call, and the result is split back into input positions.
 *
 * Throws if no invoker is configured and none was passed (programmer
 * error — the production wire-up is `setEmbedInvoker(...)` at startup).
 */
export async function embed(
  texts: string[],
  invoker?: EmbedInvoker,
): Promise<Float32Array[]> {
  const invoke = invoker ?? defaultInvoker;
  if (!invoke) {
    throw new Error(
      "embed: no invoker configured — call setEmbedInvoker(...) at sidecar startup",
    );
  }
  if (texts.length === 0) return [];

  // Partition into cached hits (in order) and uncached misses (de-duped).
  const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
  const missTexts: string[] = [];
  const seenMiss = new Set<string>();
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const cached = cache.get(text);
    if (cached) {
      results[i] = cached;
      continue;
    }
    if (seenMiss.has(text)) continue; // multiple inputs share this text
    seenMiss.add(text);
    missTexts.push(text);
  }

  if (missTexts.length === 0) return results as Float32Array[];

  const vectors = await invoke(missTexts);
  if (vectors.length !== missTexts.length) {
    throw new Error(
      `embed: invoker returned ${vectors.length} vectors for ${missTexts.length} texts (length mismatch)`,
    );
  }

  for (let j = 0; j < missTexts.length; j++) {
    cache.set(missTexts[j]!, normalize(vectors[j]!));
  }

  // Fill the remaining positions (the misses) straight from the cache.
  for (let i = 0; i < texts.length; i++) {
    if (results[i] === null) results[i] = cache.get(texts[i]!)!;
  }

  return results as Float32Array[];
}

/**
 * Production invoker factory: binds `embed_text` to the live `RsiBridge`.
 * The Rust `handle_rsi_request` dispatcher routes the method name to the
 * Phase-0 embedding context (mean-pooled, L2-normalized, returned as
 * `number[][]`). This factory normalizes the response back to
 * `Float32Array[]` so the rest of the fractal stack can treat vectors
 * uniformly.
 */
export function rsiBridgeEmbed(bridge: RsiBridge): EmbedInvoker {
  return async (texts) => {
    const wire = await bridge.request<number[][]>("embed_text", { texts });
    if (!Array.isArray(wire)) {
      throw new Error(
        `embed_text: expected number[][], got ${typeof wire} from Rust`,
      );
    }
    return wire.map((arr, i) => {
      if (!Array.isArray(arr)) {
        throw new Error(
          `embed_text: result[${i}] is not an array (got ${typeof arr})`,
        );
      }
      return new Float32Array(arr);
    });
  };
}
