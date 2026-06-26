/**
 * Deterministic synthetic benchmark corpus generator.
 *
 * Produces two committed artifacts the FMS gate consumes:
 *   - `memories.jsonl` — `{id, text}` per line, the episodic corpus to seed.
 *   - `queries.jsonl`  — `{query, relevant:[id]}` gold set (parseQuerySet).
 *
 * WHY synthetic-but-structured, not random text: the gate's real question is
 * "does the semantic layer add recall over flat FTS5?". A corpus only answers
 * that if it is built so the answer can be *non-trivial* — i.e. the query that
 * targets a memory must share LITTLE surface vocabulary with it (so lexical
 * FTS5 can miss) while a cloud of lexical near-misses (distractors) shares the
 * query's keywords (so FTS5 can be actively wrong). We get both by design:
 *
 *   - Each domain has a template with content-word slots and a per-slot synonym
 *     map. A memory uses the "doc" wording; its gold query uses the "ask"
 *     wording for every slot — same meaning, disjoint keywords.
 *   - Distractors are other permutations of the same template, so they share
 *     the template's function/keyword scaffold with the query but state a
 *     different fact.
 *
 * Determinism: a fixed seed (mulberry32) drives every pick, so regenerating
 * yields byte-identical files. The committed .jsonl are the frozen artifact the
 * bench reads; this generator is the source of truth that produced them.
 *
 * Insertion order == file order == episodic row id (a fresh DB autoincrements
 * 1..N), so the gold `relevant` ids below are simply 1-based line numbers.
 */
import { mulberry32 } from "../../prng.ts";

/** One fillable slot: `doc` wording goes in the memory, `ask` into the query. */
interface Synonym {
  doc: string;
  ask: string;
}

interface Domain {
  /** `d(...)` renders a memory, `q(...)` the paraphrased question. */
  doc: (s: string[]) => string;
  ask: (s: string[]) => string;
  /** One list of synonym pairs per slot. */
  slots: Synonym[][];
}

const sy = (doc: string, ask: string): Synonym => ({ doc, ask });

/**
 * Eight fact domains. Each `doc`/`ask` pair is written so the question's
 * content words are synonyms of the memory's, never the same token — that is
 * the whole point (forces a semantic match, defeats naive keyword overlap).
 */
const DOMAINS: Domain[] = [
  {
    // deployment cadence
    doc: (s) => `The ${s[0]} service is rolled out to the ${s[1]} datacenter every ${s[2]}.`,
    ask: (s) => `At ${s[2]}, which ${s[1]} site does the ${s[0]} backend get shipped to?`,
    slots: [
      [sy("billing", "payments"), sy("catalog", "product listing"), sy("auth", "login"), sy("search", "lookup"), sy("notifications", "alerts"), sy("analytics", "reporting")],
      [sy("Frankfurt", "German"), sy("Oregon", "US west coast"), sy("Singapore", "Southeast Asian"), sy("Dublin", "Irish")],
      [sy("Friday afternoon", "end of the work week"), sy("Monday morning", "start of the week"), sy("Wednesday", "midweek")],
    ],
  },
  {
    // tool preference
    doc: (s) => `For ${s[0]} I always reach for ${s[1]} rather than the defaults.`,
    ask: (s) => `When I need to handle ${s[0]}, do I favor ${s[1]}?`,
    slots: [
      [sy("dependency management", "keeping packages in sync"), sy("log analysis", "digging through logs"), sy("schema migrations", "evolving the database"), sy("load testing", "stress checks"), sy("secret storage", "keeping credentials safe")],
      [sy("pnpm", "the fast workspace installer"), sy("ripgrep", "the recursive grep tool"), sy("Atlas", "the migration framework"), sy("k6", "the scripting load runner"), sy("Vault", "the encrypted secrets store")],
    ],
  },
  {
    // incident learning
    doc: (s) => `The ${s[0]} outage was caused by ${s[1]}; we added ${s[2]} afterward.`,
    ask: (s) => `In the ${s[0]} incident from ${s[1]}, did we put in ${s[2]} to prevent a repeat?`,
    slots: [
      [sy("checkout", "purchase flow"), sy("ingest pipeline", "data intake"), sy("CDN", "edge cache"), sy("email worker", "mail dispatcher")],
      [sy("a connection pool exhaustion", "running out of database handles"), sy("an expired TLS certificate", "a lapsed encryption cert"), sy("a runaway retry storm", "uncontrolled retries")],
      [sy("a circuit breaker", "a failure cutoff"), sy("a renewal alarm", "an expiry reminder"), sy("a backoff cap", "a retry ceiling")],
    ],
  },
  {
    // person/role
    doc: (s) => `${s[0]} owns the ${s[1]} domain and reviews all changes to it.`,
    ask: (s) => `Is ${s[0]} the person to ask to look over edits in the ${s[1]} area?`,
    slots: [
      [sy("Priya", "Priya"), sy("Marco", "Marco"), sy("Dana", "Dana"), sy("Wei", "Wei")],
      [sy("payments", "money movement"), sy("identity", "account access"), sy("data warehouse", "analytics storage"), sy("mobile client", "phone app")],
    ],
  },
  {
    // config value
    doc: (s) => `The ${s[0]} timeout is set to ${s[1]} in production.`,
    ask: (s) => `Does the ${s[0]} call give up after ${s[1]} in our live environment?`,
    slots: [
      [sy("upstream API", "third-party request"), sy("database query", "SQL statement"), sy("cache fetch", "memory store read"), sy("webhook delivery", "callback push")],
      [sy("30 seconds", "half a minute"), sy("5 seconds", "five seconds"), sy("2 minutes", "120 seconds")],
    ],
  },
  {
    // decision rationale
    doc: (s) => `We chose ${s[0]} over ${s[1]} mainly because of ${s[2]}.`,
    ask: (s) => `Did we pick ${s[0]} instead of ${s[1]} for ${s[2]}?`,
    slots: [
      [sy("Postgres", "the relational store"), sy("Rust", "the systems language"), sy("gRPC", "the binary RPC layer"), sy("Kafka", "the log broker")],
      [sy("MongoDB", "the document store"), sy("Go", "the other backend language"), sy("REST", "plain HTTP endpoints"), sy("RabbitMQ", "the classic queue")],
      [sy("stronger consistency guarantees", "safer correctness under load"), sy("lower memory overhead", "a smaller footprint"), sy("better streaming throughput", "faster firehose handling")],
    ],
  },
  {
    // schedule/habit
    doc: (s) => `I run the ${s[0]} report ${s[1]} and send it to ${s[2]}.`,
    ask: (s) => `Do I send my ${s[1]} ${s[0]} summary to ${s[2]}?`,
    slots: [
      [sy("revenue", "sales"), sy("error budget", "reliability"), sy("growth", "signup"), sy("cost", "spend")],
      [sy("every Monday", "weekly"), sy("at month end", "monthly"), sy("each quarter", "quarterly")],
      [sy("the leadership channel", "the exec group"), sy("the finance team", "accounting"), sy("the on-call rotation", "the duty engineers")],
    ],
  },
  {
    // location/path
    doc: (s) => `The ${s[0]} lives under ${s[1]} in the repository.`,
    ask: (s) => `Can I find the ${s[0]} inside ${s[1]} in the codebase?`,
    slots: [
      [sy("embedding bridge", "vector encoder glue"), sy("dream scheduler", "idle evolution trigger"), sy("FTS5 fallback", "keyword search backup"), sy("audit logger", "action recorder")],
      [sy("the memory module", "the recall subsystem"), sy("the rsi folder", "the self-improvement area"), sy("the tools directory", "the builtin actions"), sy("the transports layer", "the IO boundary")],
    ],
  },
];

interface Built {
  memories: { id: number; text: string }[];
  queries: { query: string; relevant: number[] }[];
}

/**
 * Build the corpus. For each domain we enumerate enough slot permutations to
 * fill `perDomain` memories (the distractor cloud); `goldPerDomain` of them are
 * also turned into paraphrased gold queries. Picks are seeded → reproducible.
 */
export function buildCorpus(opts: {
  perDomain: number;
  goldPerDomain: number;
  seed?: number;
}): Built {
  const rand = mulberry32(opts.seed ?? 1);
  const memories: { id: number; text: string }[] = [];
  const queries: { query: string; relevant: number[] }[] = [];
  let id = 0;

  for (const dom of DOMAINS) {
    // Cartesian product of slot-option indices = every distinct fact this
    // template can state. We then take a seeded subset as the distractor cloud.
    let combos: number[][] = [[]];
    for (const slot of dom.slots) {
      const next: number[][] = [];
      for (const c of combos) for (let i = 0; i < slot.length; i++) next.push([...c, i]);
      combos = next;
    }
    // Seeded shuffle of the combo indices.
    for (let i = combos.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [combos[i], combos[j]] = [combos[j]!, combos[i]!];
    }
    const take = Math.min(opts.perDomain, combos.length);
    const chosen = combos.slice(0, take);
    const goldIdx = new Set<number>();
    for (let g = 0; g < Math.min(opts.goldPerDomain, take); g++) goldIdx.add(g);

    chosen.forEach((combo, idxInDom) => {
      const docWords = combo.map((optIdx, slotIdx) => dom.slots[slotIdx]![optIdx]!.doc);
      const askWords = combo.map((optIdx, slotIdx) => dom.slots[slotIdx]![optIdx]!.ask);
      id += 1;
      memories.push({ id, text: dom.doc(docWords) });
      if (goldIdx.has(idxInDom)) {
        queries.push({ query: dom.ask(askWords), relevant: [id] });
      }
    });
  }
  return { memories, queries };
}

/** Render the two committed artifacts as JSONL strings. */
export function renderJsonl(b: Built): { memories: string; queries: string } {
  return {
    memories: b.memories.map((m) => JSON.stringify(m)).join("\n") + "\n",
    queries: b.queries.map((q) => JSON.stringify(q)).join("\n") + "\n",
  };
}

// --- self-check: the corpus is only useful if a gold query shares FEW content
// words with its target memory (otherwise FTS5 trivially wins and the bench
// proves nothing). Assert mean lexical overlap is low. Run: `bun run <thisfile>`.
if (import.meta.main) {
  const b = buildCorpus({ perDomain: 40, goldPerDomain: 8, seed: 1 });
  const byId = new Map(b.memories.map((m) => [m.id, m.text]));
  const words = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  let overlapSum = 0;
  for (const q of b.queries) {
    const qw = words(q.query);
    const mw = words(byId.get(q.relevant[0]!)!);
    const inter = [...qw].filter((w) => mw.has(w)).length;
    overlapSum += inter / Math.max(1, qw.size);
  }
  const meanOverlap = overlapSum / b.queries.length;
  // Distinct ids, no collisions.
  if (new Set(b.memories.map((m) => m.id)).size !== b.memories.length) {
    throw new Error("corpus self-check: duplicate memory ids");
  }
  // A query must not be a lexical copy of its target. Keep mean content-word
  // overlap under 25% — the regime where semantic recall actually has to work.
  if (meanOverlap >= 0.25) {
    throw new Error(`corpus self-check: gold queries too lexical (mean overlap ${meanOverlap.toFixed(2)} ≥ 0.25)`);
  }
  // Write the frozen artifacts next to this file.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const out = renderJsonl(b);
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  fs.writeFileSync(path.join(dir, "memories.jsonl"), out.memories);
  fs.writeFileSync(path.join(dir, "queries.jsonl"), out.queries);
  console.log(
    `corpus ok: ${b.memories.length} memories, ${b.queries.length} gold queries, ` +
      `mean content-word overlap ${(meanOverlap * 100).toFixed(1)}% (target <25%)`,
  );
}
