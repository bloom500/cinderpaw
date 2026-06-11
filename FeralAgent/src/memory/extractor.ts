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

import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { ChatMessage } from "../types.ts";
import type { SkillAutoCreator } from "../skills/auto-create.ts";
import type { MemoryGraph } from "./graph.ts";

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
  readonly #skillCreator: SkillAutoCreator | null;
  readonly #running = new Set<string>();
  readonly #queue: { sessionId: string; turns: ChatMessage[] }[] = [];
  #isIdle: () => boolean = () => true;
  #processing = false;
  #graph: MemoryGraph | null = null;

  constructor(
    router: InferenceRouter,
    semantic: SemanticMemory,
    episodic?: EpisodicMemory,
    skillCreator?: SkillAutoCreator | null,
  ) {
    this.#router = router;
    this.#semantic = semantic;
    this.#episodic = episodic ?? null;
    this.#skillCreator = skillCreator ?? null;
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

    const shouldExtract = assistantTurns % 3 === 0;
    const shouldSkill = this.#skillCreator && (assistantTurns % 5 === 0);

    if (!shouldExtract && !shouldSkill) return;

    const recent = turns.slice(-6);
    let transcript = recent
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");
    if (transcript.length > 2000) transcript = transcript.slice(-2000);

    const promises: Promise<void>[] = [];

    if (shouldExtract) {
      promises.push(this.#extractFactsAndObservation(sessionId, transcript));
    }

    if (shouldSkill && this.#skillCreator) {
      promises.push(
        this.#skillCreator.maybeCreate(transcript, sessionId).then(() => undefined)
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
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
          const key = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (key && value && key.length <= 60 && value.length <= 300) {
            this.#semantic.upsert(key, value);
            graphFacts.push({ key, value });
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
      if (obsText && obsText.toUpperCase() !== "SKIP" && this.#episodic) {
        const obs = parseObservation(obsText);
        if (obs) {
          const entry = [
            `[obs:${obs.type}] ${obs.title}`,
            obs.facts.map((f) => `  • ${f}`).join("\n"),
            obs.concepts.length > 0 ? `  concepts: ${obs.concepts.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          this.#episodic.record(sessionId, "assistant", entry);
        }
      }
    } catch {
      // Never fatal.
    } finally {
      this.#router.evictSession(extractionSessionId);
    }
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
