/**
 * Working memory — the in-session message transcript handed to the LLM.
 *
 * Holds the live conversation for a single session. When the transcript grows
 * past a token threshold it is auto-compressed: the oldest turns are summarized
 * into a single system note so the recent context stays intact while total size
 * stays bounded. Compression here is the counterpart to the inference router's
 * "compress_and_continue" budget policy.
 */

import type { ChatMessage } from "../types.ts";

export interface WorkingMemoryConfig {
  /** Approximate token ceiling before compression kicks in. */
  maxTokens: number;
  /** How many of the most-recent turns to always preserve verbatim. */
  keepRecent: number;
}

const DEFAULT_CONFIG: WorkingMemoryConfig = {
  maxTokens: 8_000,
  keepRecent: 8,
};

export class WorkingMemory {
  readonly #system: string;
  readonly #config: WorkingMemoryConfig;
  #messages: ChatMessage[] = [];
  /**
   * Transient recall context injected at render time. Updated each turn by the
   * agent loop (via `setMemoryContext`) but never stored in the persistent
   * transcript — it is not summarized, compressed, or accumulated. This keeps
   * past-memory surfacing ephemeral and turn-specific.
   */
  #memoryContext = "";

  constructor(systemPrompt: string, config: Partial<WorkingMemoryConfig> = {}) {
    this.#system = systemPrompt;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Append a turn to the transcript. */
  add(message: ChatMessage): void {
    this.#messages.push(message);
  }

  addUser(content: string): void {
    this.add({ role: "user", content });
  }

  addAssistant(content: string): void {
    this.add({ role: "assistant", content });
  }

  addToolResult(toolName: string, content: string): void {
    this.add({ role: "tool", name: toolName, content });
  }

  /** Current non-system turns. */
  get turns(): ReadonlyArray<ChatMessage> {
    return this.#messages;
  }

  /** Approximate token footprint of the full prompt (system + turns). */
  estimatedTokens(): number {
    const all = this.#system + this.#messages.map((m) => m.content).join("");
    return Math.ceil(all.length / 4);
  }

  /**
   * Replace the transient memory context for this turn. The context is injected
   * as a system message between the base system prompt and the conversation
   * transcript so the model sees it without it polluting the turn history.
   * Pass an empty string to clear it.
   */
  setMemoryContext(context: string): void {
    this.#memoryContext = context;
  }

  /**
   * Build the full message array for an inference call: the system prompt,
   * followed by the (optional) transient memory context, followed by the
   * conversation transcript.
   */
  render(): ChatMessage[] {
    const base: ChatMessage[] = [{ role: "system", content: this.#system }];
    if (this.#memoryContext) {
      base.push({ role: "system", content: this.#memoryContext });
    }
    return [...base, ...this.#messages];
  }

  /**
   * Compress when over budget. Summarizes the older portion of the transcript
   * via the provided summarizer, replacing it with one system note. Returns true
   * if compression occurred. The summarizer is injected so working memory has no
   * dependency on the inference layer.
   */
  async maybeCompress(
    summarize: (messages: ChatMessage[]) => Promise<string>,
  ): Promise<boolean> {
    if (this.estimatedTokens() <= this.#config.maxTokens) return false;
    if (this.#messages.length <= this.#config.keepRecent) return false;

    const cut = this.#messages.length - this.#config.keepRecent;
    const older = this.#messages.slice(0, cut);
    const recent = this.#messages.slice(cut);

    let summary: string;
    try {
      summary = await summarize(older);
    } catch {
      // If summarization fails, fall back to a hard truncation note so memory
      // never grows unbounded and the agent never crashes.
      summary = `[${older.length} earlier turns omitted due to size]`;
    }

    this.#messages = [
      { role: "system", content: `Summary of earlier conversation: ${summary}` },
      ...recent,
    ];
    return true;
  }

  /** Drop all turns (keeps the system prompt). */
  clear(): void {
    this.#messages = [];
  }
}
