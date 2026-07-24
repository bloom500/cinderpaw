/**
 * Semantic memory extractor — upgraded with claude-mem observation types.
 *
 * Two passes run asynchronously after each completed turn:
 *
 *   1. FACTS pass (existing behaviour, improved prompt):
 *      Extracts durable user facts (name, role, language, preferences) as
 *      key: value lines → stored in SemanticMemory.
 *
 *   2. OBSERVATION pass (new — from claude-mem):
 *      Classifies the turn with a structured type and extracts bullet-point
 *      facts + key concepts → stored in EpisodicMemory as a typed observation
 *      entry alongside the raw transcript, tagged [obs].
 *
 * Observation types (from claude-mem ECC modes):
 *   discovery  — learning about existing system/context
 *   decision   — architectural or preference choice with rationale
 *   bugfix     — something was broken, now resolved
 *   feature    — new capability discussed or built
 *   change     — generic modification (config, docs, etc.)
 *   task       — actionable item identified
 *   preference — user preference or constraint learned
 *
 * Both passes use a minimal token budget and never block the user response.
 */

import type { InferenceRouter } from "../egress/inference-router.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { ChatMessage, AfterMemoryWritePayload } from "../types.ts";
import type { MemoryGraph } from "./graph.ts";
import type { HookRegistry } from "../core/hook-registry.ts";

export type ObservationType =
  | "discovery"
  | "decision"
  | "bugfix"
  | "feature"
  | "change"
  | "task"
  | "preference";

const VALID_OBS_TYPES = new Set<string>([
  "discovery", "decision", "bugfix", "feature", "change", "task", "preference",
]);

export class MemoryExtractor {
  readonly #router: InferenceRouter;
  readonly #semantic: SemanticMemory;
  readonly #episodic: EpisodicMemory | null;
  readonly #hooks: HookRegistry | null;
  readonly #running = new Set<string>();
  readonly #queue: { sessionId: string; turns: ChatMessage[] }[] = [];
  #isIdle: () => boolean = () => true;
  #processing = false;
  #graph: MemoryGraph | null = null;

  constructor(
    router: InferenceRouter,
    semantic: SemanticMemory,
    episodic?: EpisodicMemory,
    hooks?: HookRegistry | null,
  ) {
    this.#router = router;
    this.#semantic = semantic;
    this.#episodic = episodic ?? null;
    this.#hooks = hooks ?? null;
  }

  setIdleChecker(checker: () => boolean) {
    this.#isIdle = checker;
  }

  setGraph(graph: MemoryGraph): void {
    this.#graph = graph;
  }

  extractAsync(sessionId: string, recentTurns: ChatMessage[]): void {
    if (recentTurns.length < 2) return;

    const existing = this.#queue.find((item) => item.sessionId === sessionId);
    if (existing) {
      existing.turns = recentTurns;
    } else {
      this.#queue.push({ sessionId, turns: recentTurns });
    }

    this.runPending();
  }

  async runPending(): Promise<void> {
    if (this.#processing) return;
    if (!this.#isIdle()) return;

    this.#processing = true;
    try {
      while (this.#queue.length > 0 && this.#isIdle()) {
        const item = this.#queue.shift();
        if (!item) break;

        if (this.#running.has(item.sessionId)) continue;

        this.#running.add(item.sessionId);
        try {
          await this.#extract(item.sessionId, item.turns);
        } finally {
          this.#running.delete(item.sessionId);
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #extract(sessionId: string, turns: ChatMessage[]): Promise<void> {
    const assistantTurns = turns.filter((m) => m.role === "assistant").length;
    if (assistantTurns === 0) return;

    const shouldExtract = assistantTurns === 1 || assistantTurns % 3 === 0;
    if (!shouldExtract) return;

    const recent = turns.slice(-6);
    let transcript = recent
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");
    if (transcript.length > 2000) transcript = transcript.slice(-2000);

    await this.#extractFactsAndObservation(sessionId, transcript);
  }

  async #extractFactsAndObservation(sessionId: string, transcript: string): Promise<void> {
    const extractionSessionId = `${sessionId}__extraction`;
    try {
      const res = await this.#router.complete({
        sessionId: extractionSessionId,
        messages: [
          {
            role: "system",
            content: [
              "You are a memory extractor. Analyze the conversation turn and extract two sections:",
              "",
              "=== FACTS ===",
              "Extract durable facts about the USER (e.g. name, role, language, preferences, goal).",
              "Output ONE fact per line as: key: value",
              "If nothing worth extracting, output: NONE",
              "",
              "=== OBSERVATION ===",
              "Classify this conversation turn and extract a structured observation.",
              "Output format:",
              "type: <one of: discovery|decision|bugfix|feature|change|task|preference>",
              "title: <short title, max 60 chars>",
              "facts:",
              "- <fact 1>",
              "- <fact 2>",
              "concepts: <comma-separated keywords>",
              "If nothing worth recording, output: SKIP",
            ].join("\n"),
          },
          { role: "user", content: transcript },
        ],
        maxTokens: 300,
        temperature: 0.1,
      });

      const rawContent = res.content.trim();
      const sections = parseCombined(rawContent);

      // 1. Process FACTS
      const factsText = sections.facts;
      if (factsText && factsText.toUpperCase() !== "NONE") {
        const graphFacts: Array<{ key: string; value: string }> = [];
        for (const line of factsText.split("\n")) {
          const colon = line.indexOf(":");
          if (colon < 1) continue;
          const fact = sanitizeFact(
            line.slice(0, colon),
            line.slice(colon + 1),
          );
          if (fact) {
            this.#semantic.upsert(fact.key, fact.value);
            graphFacts.push(fact);
            // Fire after_memory_write ONCE per fact write — the
            // Reconciler (Pathway 3 step 2) subscribes to upsert into
            // the fractal tree. Awaited so the hook completes before
            // the extraction loop moves on; the registry contract
            // guarantees handlers never throw.
            await this.#fireMemoryWrite({
              kind: "fact",
              sessionId,
              ts: Date.now(),
              key: fact.key,
              value: fact.value,
            });
          }
        }
        if (this.#graph && graphFacts.length > 0) {
          for (const { key, value } of graphFacts) {
            this.#graph.addFact(key, "has", value);
          }
          this.#graph.persist();
        }
      }

      // 2. Process OBSERVATION
      const obsText = sections.observation;
      if (obsText && obsText.toUpperCase() !== "SKIP") {
        const obs = parseObservation(obsText);
        if (obs) {
          if (this.#episodic) {
            const entry = [
              `[obs:${obs.type}] ${obs.title}`,
              obs.facts.map((f) => `  • ${f}`).join("\n"),
              obs.concepts.length > 0 ? `  concepts: ${obs.concepts.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            this.#episodic.record(sessionId, "assistant", entry);
          }
          // Mirror observation concepts to the knowledge graph so recall
          // can surface them in future sessions alongside semantic facts.
          if (this.#graph && obs.concepts.length > 0) {
            const slug = obs.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 50);
            const eventId = `event_${slug}`;
            this.#graph.upsertNode(eventId, obs.title, "event");
            for (const concept of obs.concepts.slice(0, 8)) {
              if (concept.length > 0 && concept.length <= 60) {
                const cId = concept.toLowerCase().replace(/[^a-z0-9]+/g, "_");
                this.#graph.upsertNode(cId, concept, "concept");
                this.#graph.addEdge(eventId, cId, obs.type);
              }
            }
            this.#graph.persist();
          }
          // Fire after_memory_write ONCE per observation — same contract
          // as the fact branch above.
          await this.#fireMemoryWrite({
            kind: "observation",
            sessionId,
            ts: Date.now(),
            obsType: obs.type,
            title: obs.title,
            concepts: [...obs.concepts],
          });
        }
      }
    } catch {
      // Never fatal.
    } finally {
      this.#router.evictSession(extractionSessionId);
    }
  }

  /**
   * Fire `after_memory_write` to the registry, if one is attached. No-op
   * when the extractor was constructed without a HookRegistry (the
   * pathway-3-step-1 substrate was hook-less). The registry's own
   * fire() catches handler errors so this method never rejects — keeping
   * the extraction pipeline resilient exactly like the rest of the
   * memory write path.
   */
  async #fireMemoryWrite(payload: AfterMemoryWritePayload): Promise<void> {
    if (!this.#hooks) return;
    await this.#hooks.fire("after_memory_write", payload);
  }
}

interface ParsedObservation {
  type: ObservationType;
  title: string;
  facts: string[];
  concepts: string[];
}

function parseObservation(raw: string): ParsedObservation | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  let type: ObservationType | null = null;
  let title = "";
  const facts: string[] = [];
  const concepts: string[] = [];
  let inFacts = false;

  for (const line of lines) {
    if (line.startsWith("type:")) {
      const val = line.slice(5).trim().toLowerCase();
      if (VALID_OBS_TYPES.has(val)) type = val as ObservationType;
      inFacts = false;
    } else if (line.startsWith("title:")) {
      title = line.slice(6).trim().slice(0, 80);
      inFacts = false;
    } else if (line.startsWith("facts:")) {
      inFacts = true;
    } else if (line.startsWith("concepts:")) {
      inFacts = false;
      const val = line.slice(9).trim();
      concepts.push(...val.split(",").map((c) => c.trim()).filter(Boolean));
    } else if (inFacts && (line.startsWith("- ") || line.startsWith("* "))) {
      facts.push(line.slice(2).trim());
    }
  }

  if (!type || !title) return null;
  return { type, title, facts, concepts };
}

/** Keys that are conversation roles / prompt scaffolding, never user facts. */
const FACT_KEY_BLOCKLIST = new Set([
  "user", "assistant", "model", "bot", "system", "nick", "observation",
  "facts", "type", "title", "concepts", "none", "skip",
]);

/**
 * Is this (already-lowercased, trimmed) key unusable as a fact name?
 * Shared by the extraction-time sanitizer and the boot-time hygiene sweep
 * so junk that ever reached the store gets removed by the same rules that
 * prevent new junk from being written.
 */
export function isJunkFactKey(key: string): boolean {
  if (!key) return true;
  if (FACT_KEY_BLOCKLIST.has(key)) return true;
  if (key.length > 40) return true;
  // List markers / numbering leaked from the model's bullet output.
  if (/^[-*•]/.test(key) || /^\d+[.)]/.test(key)) return true;
  // Sentence-shaped keys are reasoning leakage, not fact names.
  if (key.split(/\s+/).length > 4) return true;
  // Quotes, markup, or JSON fragments in the key mean a malformed line.
  if (/["'<>{}()`\\]/.test(key)) return true;
  return false;
}

/**
 * Validate and normalize one extracted `key: value` fact line.
 *
 * Local models leak reasoning text, markdown bullets, and Windows paths into
 * the facts output; the old colon-split stored keys like "- language",
 * "1. user shared a link", "we need to produce final answer", and
 * "the user has a project at `d" (path split at the drive-letter colon).
 * Those keys are unguessable, so any future tool that targets a fact by key
 * would never hit them and the graph would fill with junk nodes — hence the
 * aggressive sanitation here.
 *
 * Returns the cleaned fact, or null when the line is not a usable fact.
 */
export function sanitizeFact(
  rawKey: string,
  rawValue: string,
): { key: string; value: string } | null {
  // Strip markdown list markers and numbering from the key.
  const key = rawKey
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim()
    .toLowerCase();
  const value = rawValue.trim();

  if (!value || isJunkFactKey(key)) return null;
  const canonicalKey = canonicalFactKey(key);
  if (value.length > 300) return null;
  // A value starting with a path separator means the colon we split on was
  // a Windows drive letter ("...at c:\Users\...") — the line is not a fact.
  if (/^[\\/]/.test(value)) return null;
  // Thinking markup in the value is model leakage.
  if (/<\/?think/i.test(value)) return null;

  return { key: canonicalKey, value };
}

/**
 * Collapse synonym keys onto one canonical name.
 *
 * `SemanticMemory.upsert` dedupes on the PRIMARY KEY, so a re-stated fact
 * correctly overwrites — but only when the key matches exactly. The extractor
 * is a language model: it writes `project path` one session and
 * `project directory` the next, so a user who moves their repo ends up with
 * BOTH rows, both recent, both rendered into the prompt. The model is then
 * handed two contradictory facts with equal authority. Deduping the storage
 * layer was never the missing piece; agreeing on the key was.
 *
 * ponytail: a fixed table, not embeddings. Whitespace→underscore alone kills
 * roughly half the collisions; the table handles the identity/location/path
 * families that actually recur. If contradictions show up on a key that is
 * not here, add a row — semantic clustering over the fact keys would be more
 * code than the layer it protects.
 */
/**
 * Every alias maps onto the name ALREADY in use (`name`, `language`, …)
 * rather than a prettier one. Canonicalising away from the incumbent would
 * orphan every fact already on disk under the old key — a migration, not a
 * dedup — and the point here is to stop contradictions, not to rename them.
 */
const FACT_KEY_ALIASES: Readonly<Record<string, string>> = {
  "user name": "name",
  "users name": "name",
  "user's name": "name",
  "full name": "name",
  "project path": "project_dir",
  "project directory": "project_dir",
  "project folder": "project_dir",
  "project root": "project_dir",
  "working directory": "project_dir",
  "repo path": "project_dir",
  "city": "location",
  "lives in": "location",
  "based in": "location",
  "speaks": "language",
  "spoken language": "language",
  "preferred language": "language",
  "job": "occupation",
  "role": "occupation",
  "profession": "occupation",
};

/** Canonical storage key for an already-lowercased, sanitized fact name. */
export function canonicalFactKey(key: string): string {
  const alias = FACT_KEY_ALIASES[key];
  if (alias) return alias;
  // `project dir` and `project_dir` must not be two different facts.
  return key.replace(/\s+/g, "_");
}

export function parseCombined(raw: string): { facts: string; observation: string } {
  let facts = "";
  let observation = "";

  const factsRegex = /={2,}\s*FACTS\s*={2,}/i;
  const obsRegex = /={2,}\s*OBSERVATION\s*={2,}/i;

  const factsMatch = raw.match(factsRegex);
  const obsMatch = raw.match(obsRegex);

  if (factsMatch && obsMatch) {
    const factsIdx = factsMatch.index!;
    const obsIdx = obsMatch.index!;

    if (factsIdx < obsIdx) {
      facts = raw.slice(factsIdx + factsMatch[0].length, obsIdx);
      observation = raw.slice(obsIdx + obsMatch[0].length);
    } else {
      observation = raw.slice(obsIdx + obsMatch[0].length, factsIdx);
      facts = raw.slice(factsIdx + factsMatch[0].length);
    }
  } else if (factsMatch) {
    facts = raw.slice(factsMatch.index! + factsMatch[0].length);
  } else if (obsMatch) {
    observation = raw.slice(obsMatch.index! + obsMatch[0].length);
  } else {
    // Neither header found — fallback to splitting by common headers if present
    const lower = raw.toLowerCase();
    const factsWordIdx = lower.indexOf("facts:");
    const obsWordIdx = lower.indexOf("type:");
    
    if (factsWordIdx !== -1 && obsWordIdx !== -1) {
      if (factsWordIdx < obsWordIdx) {
        facts = raw.slice(factsWordIdx, obsWordIdx);
        observation = raw.slice(obsWordIdx);
      } else {
        observation = raw.slice(obsWordIdx, factsWordIdx);
        facts = raw.slice(factsWordIdx);
      }
    } else {
      facts = raw;
    }
  }

  return { facts: facts.trim(), observation: observation.trim() };
}
