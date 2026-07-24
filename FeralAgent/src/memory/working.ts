/**
 * Working memory — the in-session message transcript handed to the LLM.
 *
 * Holds the live conversation for a single session. When the transcript grows
 * past a token threshold it is auto-compressed: the oldest turns are summarized
 * into a single system note so the recent context stays intact while total size
 * stays bounded. Compression here is the counterpart to the inference router's
 * "compress_and_continue" budget policy.
 *
 * P1 (prompt caching): the render() output is shaped so the static system
 * prompt sits alone in the system role and per-turn dynamic context (skill
 * menu, memory recall) is appended to the last user message. This keeps
 * the tokenized prefix `[system, msg_0, ..., user_{n-1}]` byte-stable
 * turn-over-turn so the local engine (llama.cpp) can reuse the KV cache
 * for the static prefix and only recompute the new tail. See the docstring
 * on `render()` for the full rationale.
 */

import { countTokens } from "../core/tokenizer.ts";
import type { ChatMessage, SkillMeta } from "../types.ts";

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

/** Tokens reserved for the summary note maybeCompress prepends, so the kept
 *  recent transcript + the summary still fit under the target budget.
 *  Must cover the summarizer's `maxTokens` (see AgentLoop.#summarize) — when it
 *  was 512 against a 1024-token summary, compaction handed back a prompt bigger
 *  than the budget it was called with and the next turn compacted again. */
const SUMMARY_RESERVE_TOKENS = 1_200;

/** Last-resort truncation of a single message larger than the whole recent
 *  budget (e.g. one giant tool output). Keeps head + tail (where the useful
 *  bits usually are) with a marker. Approximate char↔token ratio — fine
 *  because this only runs on the pathological oversized-message path.
 *  ponytail: blunt middle-cut; a smarter summarizer pass is overkill here. */
function truncateToBudget(text: string, budgetTokens: number): string {
  const total = countTokens(text);
  if (total <= budgetTokens) return text;
  const keepChars = Math.max(0, Math.floor(text.length * (budgetTokens / total)) - 32);
  const head = Math.floor(keepChars * 0.7);
  const tail = keepChars - head;
  return text.slice(0, head) + "\n…[truncated for context]…\n" + text.slice(text.length - tail);
}

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
  /**
   * Claude Code-style skill menu. Updated each turn from `msg.skillsContext`
   * (the fresh roster sent by Rust). Rendered as a system message so the LLM
   * sees a short "Available skills" list and uses the `read_skill` tool to
   * load the body of any skill it actually wants to apply. Updated per turn
   * so newly installed skills show up without resetting the session.
   *
   * P1: even though it changes every turn, the menu is APPENDED to the last
   * user message (via `render()`) instead of being injected as its own system
   * message. See the docstring on `render()` for why.
   */
  #skillMenu = "";

  /**
   * Open items from the durable todo list, rendered per turn like the skill
   * menu. This is what stops "I already did this" followed by doing it again:
   * the transcript that recorded the work gets compacted away, but the todo
   * rows live in SQLite and are re-shown every turn.
   */
  #todoList = "";

  constructor(systemPrompt: string, config: Partial<WorkingMemoryConfig> = {}) {
    this.#system = systemPrompt;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Append a turn to the transcript. */
  add(message: ChatMessage): void {
    this.#messages.push(message);
  }

  /**
   * Replace the transcript wholesale. Used by crash-resume to rehydrate a
   * full mid-turn checkpoint (CheckpointStore) — including tool-role messages,
   * which the episodic replay path deliberately omits. System messages are
   * dropped: the system prompt is this WorkingMemory's own, injected at
   * render(), not part of the stored turns.
   */
  restore(messages: ChatMessage[]): void {
    this.#messages = messages.filter((m) => m.role !== "system");
  }

  addUser(content: string, images?: string[]): void {
    this.add({ role: "user", content, ...(images && images.length > 0 ? { images } : {}) });
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

  /**
   * Approximate token footprint of the full prompt (system + turns).
   *
   * Uses real BPE tokenization (P0-#5) instead of the old `length/4`
   * heuristic. Critical for code-heavy and CJK content where the old
   * estimate was 2-3× too low, causing late compression and silent
   * context overflow.
   */
  estimatedTokens(): number {
    let total = 0;
    total += countTokens(this.#system);
    total += countTokens(this.#skillMenu);
    total += countTokens(this.#todoList);
    total += countTokens(this.#memoryContext);
    for (const m of this.#messages) {
      total += countTokens(m.content);
    }
    return total;
  }

  /**
   * Replace the transient memory context for this turn. The context is
   * appended to the LAST user message in `render()` (P1) so the static
   * system prompt above it stays byte-stable across turns. Pass an empty
   * string to clear it.
   */
  setMemoryContext(context: string): void {
    this.#memoryContext = context;
  }

  /**
   * Update the per-turn skill menu from the Rust-side roster. The menu is
   * appended to the last user message in `render()` (P1) so the system
   * prompt above it stays stable. Pass an empty array to clear the menu
   * (e.g. user uninstalled everything).
   */
  setSkillMenu(skills: SkillMeta[]): void {
    if (skills.length === 0) {
      this.#skillMenu = "";
      return;
    }
    const lines = skills.map(
      (s) => `- \`${s.id}\` — ${s.name}: ${s.description || "(no description)"}`,
    );
    this.#skillMenu =
      "## Available skills (locally installed)\n" +
      "Use the `read_skill` tool to load the full body of any skill before applying it.\n\n" +
      lines.join("\n");
  }

  /**
   * Update the per-turn view of the durable todo list. Only OPEN items are
   * shown — a done item is history, and re-listing it every turn would spend
   * context re-teaching the model something it must not redo.
   *
   * ponytail: capped at 20 items, no pagination. A task list longer than that
   * is a planning problem, not a rendering one.
   */
  setTodoList(items: Array<{ id: string; content: string; status: string }>): void {
    const open = items.filter((t) => t.status !== "done").slice(0, 20);
    if (open.length === 0) {
      this.#todoList = "";
      return;
    }
    this.#todoList =
      "## Your task list (persists across sessions — `todo_write` to update)\n" +
      "These are still OPEN. Do not redo anything absent from this list.\n\n" +
      open.map((t) => `- [${t.status}] \`${t.id}\` — ${t.content}`).join("\n");
  }

  /**
   * Build the full message array for an inference call.
   *
   * P1 (prompt caching): the layout is reshaped so llama.cpp's KV cache
   * can be reused across turns. The base system prompt is rendered
   * EXACTLY once and never changes mid-session, so the tokenized prefix
   * that begins with it stays byte-stable.
   *
   * Per-turn dynamic context (skill menu, memory recall) is appended to
   * the LAST user-role message instead of being injected as separate
   * system messages between the static system prompt and the transcript.
   * The reason is purely positional: any message inserted between the
   * system prompt and the transcript (or added at the head) shifts the
   * token index of every subsequent message, which invalidates the cache
   * just as effectively as changing the system prompt. Appending to the
   * last user message keeps the message COUNT and POSITIONS stable, so
   * only the tail content changes per turn — the engine reuses the KV
   * for everything up to the start of that user message and recomputes
   * only the appended dynamic block (and any new turn content).
   *
   * First completion of a session: no cache to reuse, full prefill.
   * Subsequent completions: cache hits for `[system, msg_0, …, user_{n-1}]`
   * (everything up to and including the original tail of user_n), recompute
   * for the appended dynamic block + any new tool/user content past it.
   *
   * No model template rejects this layout — all four (llama3, chatml,
   * gemma, mistral) accept long user messages. Skill menus and recall
   * blocks are already self-delimited (`[Memory context]…[End memory
   * context]`, `## Available skills (locally installed)…`) so the model
   * parses them unambiguously.
   */
  render(): ChatMessage[] {
    const dynamicBlocks: string[] = [];
    if (this.#skillMenu) dynamicBlocks.push(this.#skillMenu);
    if (this.#todoList) dynamicBlocks.push(this.#todoList);
    if (this.#memoryContext) dynamicBlocks.push(this.#memoryContext);

    if (dynamicBlocks.length === 0) {
      return [{ role: "system", content: this.#system }, ...this.#messages];
    }

    const dynamic = dynamicBlocks.join("\n\n");
    // Copy-on-write: avoid mutating the caller's transcript slice.
    const messages = this.#messages.slice();

    // Reverse-iterate to find the LAST user-role message. Manual loop
    // rather than Array.prototype.findLastIndex for Bun runtime
    // portability (ES2023 may not be available in every build target).
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      const prev = messages[lastUserIdx]!;
      messages[lastUserIdx] = {
        ...prev,
        content: prev.content
          ? `${prev.content}\n\n---\n\n${dynamic}`
          : dynamic,
      };
    } else {
      // Degenerate: no user message in the transcript. The agent loop
      // always calls addUser() before render(), so this branch is only
      // reachable from unit tests that exercise the helper in isolation.
      // We surface a synthetic user message at the tail — the cache miss
      // here is unavoidable, but it's a fallback, not the common path.
      messages.push({ role: "user", content: dynamic });
    }

    return [{ role: "system", content: this.#system }, ...messages];
  }

  /**
   * Compress when over budget. Summarizes the older portion of the transcript
   * via the provided summarizer, replacing it with one system note. Returns true
   * if compression occurred. The summarizer is injected so working memory has no
   * dependency on the inference layer.
   *
   * P1: compression mutates `this.#messages` (replaces the older portion with
   * a single summary system message). The next render() will produce a
   * DIFFERENT prefix than the cached one, so the KV cache will be invalidated.
   * This is acceptable — compression is rare (once every ~8K tokens), and
   * the cost is amortized over many subsequent turns that all hit the cache.
   */
  async maybeCompress(
    summarize: (messages: ChatMessage[]) => Promise<string>,
    targetTokens: number = this.#config.maxTokens,
  ): Promise<boolean> {
    if (this.estimatedTokens() <= targetTokens) return false;
    if (this.#messages.length === 0) return false;

    // Overhead that SURVIVES compaction and still counts against the model's
    // context: the static system prompt, the per-turn drawers, and the summary
    // note we're about to prepend. The local KV cache overflows on the full
    // prompt, not just the transcript, so reserve it before sizing "recent".
    // The reserve is a ceiling, not a fixed cost: on a small target budget a
    // flat 1200 would swallow the whole allowance and leave `recentBudget` at
    // 0, so an oversized message survived verbatim into a prompt that was
    // already overflowing. Never spend more than a quarter of the budget
    // holding room for a summary that hasn't been written yet.
    const summaryReserve = Math.min(
      SUMMARY_RESERVE_TOKENS,
      Math.floor(targetTokens * 0.25),
    );
    const fixedOverhead =
      countTokens(this.#system) +
      countTokens(this.#skillMenu) +
      countTokens(this.#todoList) +
      countTokens(this.#memoryContext) +
      summaryReserve;
    const recentBudget = Math.max(0, targetTokens - fixedOverhead);

    // Keep newest-first until the next message would blow the recent budget.
    // Token-bounded (not a fixed message COUNT like the old keepRecent): a
    // handful of fat tool outputs can no longer survive verbatim into a prompt
    // that overflows the model context — the "crashes on complex tasks" case.
    // Always keep at least the most recent message (the live turn).
    const kept: ChatMessage[] = [];
    let keptTokens = 0;
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      const msg = this.#messages[i]!;
      const t = countTokens(msg.content);
      if (kept.length > 0 && keptTokens + t > recentBudget) break;
      kept.unshift(msg);
      keptTokens += t;
    }

    // Last resort: a single message larger than the whole recent budget would
    // still overflow. Truncate it so the prompt fits no matter what.
    if (kept.length === 1 && keptTokens > recentBudget && recentBudget > 64) {
      kept[0] = { ...kept[0]!, content: truncateToBudget(kept[0]!.content, recentBudget) };
    }

    const cut = this.#messages.length - kept.length;
    if (cut <= 0) {
      // Nothing older to summarize, but we were over budget — the lone-huge
      // message was truncated above. Persist that and stop.
      this.#messages = kept;
      return true;
    }
    const older = this.#messages.slice(0, cut);

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
      ...kept,
    ];
    return true;
  }

  /** Drop all turns (keeps the system prompt). */
  clear(): void {
    this.#messages = [];
  }
}
