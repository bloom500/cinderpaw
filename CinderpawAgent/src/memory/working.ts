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

/**
 * Opening of the compaction-boundary note. Everything before this message in
 * the transcript is already summarized; the prefix is how `maybeCompress`
 * recognizes its own artifact so it never summarizes it a second time. Also
 * asserted on by tests — do not reword without updating memory.test.ts.
 */
const SUMMARY_PREFIX = "Summary of earlier conversation:";

/** Tokens the objective drawer may occupy. One request, not an essay. */
const OBJECTIVE_MAX_TOKENS = 200;

/**
 * How many of the most recent tool results survive at full size. Everything
 * the model is actively reasoning over is in the last couple of steps; older
 * tool output is bulk it has already extracted what it needed from.
 */
const TOOL_RESULT_KEEP_RECENT = 4;

/** Token ceiling for a tool result past the keep-recent window. */
const TOOL_RESULT_MAX_TOKENS = 400;

/**
 * Sentinel appended to a trimmed tool result. Two jobs: it tells the model the
 * output is recoverable (re-run the tool) rather than simply gone, and it makes
 * `#budgetToolResults` idempotent — without it, re-trimming an already-trimmed
 * message every turn would shrink it toward nothing.
 */
const TRIMMED_MARK =
  "…[older tool output trimmed to fit the context window — re-run the tool if you need the rest]";

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

/**
 * One measured slice of what we are about to send.
 *
 * `category` is the lane; `detail` is the sub-split within it (which tool, which
 * drawer, which role). Both are stable strings — the report groups on them, so
 * renaming one renames a row in every historical comparison.
 */
export interface PromptPart {
  category:
    | "system_prompt"
    | "tool_schemas"
    | "drawer"
    | "compaction_summary"
    | "conversation"
    | "episodic_replay"
    | "tool_output";
  detail: string;
  tokens: number;
}

/**
 * What WE sent, measured by OUR tokenizer, split into lanes that partition the
 * prompt exactly once.
 *
 * Deliberately NOT reconciled against the provider's `prompt_tokens`. Ours is an
 * approximate BPE count and theirs is authoritative; scaling these to match
 * their total would be inventing precision, and the two are recorded side by
 * side so the gap stays visible instead of being absorbed.
 *
 * Equally deliberately, this carries no cache attribution. Providers report
 * cache hits per REQUEST, never per message, so "how much of the tool output was
 * cached" is not a number anyone has — and multiplying a per-request ratio
 * across these lanes would manufacture one.
 */
export interface PromptBreakdown {
  parts: PromptPart[];
  /** Sum of `parts`. Our count of the whole prompt, not the provider's. */
  localTotal: number;
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

  /**
   * The agent's notebook — durable `note:` facts from semantic memory, rendered
   * in FULL every turn rather than searched.
   *
   * The search path (`recall`) only ever returns what the agent thought to look
   * for, which on hour 6 of a long run is precisely what it has forgotten it
   * knows. A notebook has to be open on the desk.
   *
   * Distinct from the compaction summary on purpose: that block is append-only
   * and blind-truncated head+tail once it outgrows its reserve, so the MIDDLE of
   * a long run is what falls out of it. These rows are rewritten by their owner
   * instead of being cut by us, so they stay small without losing the middle.
   */
  #notebook = "";

  /**
   * Memories the runtime looked up FOR the agent, from this turn's message.
   *
   * The notebook above is what the agent chose to write down. This is the rest
   * of what it has lived through, and until now nothing put it in front of the
   * model: the loop held a `Recaller` and only ever called `noteWrite` on it,
   * so memory was written every turn and read only if the model happened to
   * call the `recall` tool. Measured on TheAgentCompany: 12 leaf-write pulses,
   * zero recalls. The store was never the problem; nobody was asking it
   * anything.
   *
   * Re-queried per turn from the user's own words, so it tracks what the
   * conversation is about rather than what the agent thought to search for at
   * the start. Already self-delimited by the recall engine
   * (`[Memory context]…[End memory context]`), so it is stored rendered.
   */
  #recallContext = "";

  /**
   * The original request, captured the first time this session is compacted
   * and re-projected every turn thereafter (same trick as `#todoList`: durable
   * state re-rendered, not transcript that can be eaten).
   *
   * The first user turn is what the whole session is *for*, and it is the first
   * thing a summarizer flattens into a clause. Losing it is what turns a long
   * task into an agent that is busy but no longer working on the thing it was
   * asked to do. Empty until the first compaction — before that the real
   * message is still right there in the transcript.
   */
  #objective = "";

  /**
   * Where this session's answers are being rendered — a chat app, with a narrow
   * column and no table support, versus the desktop app's full markdown view.
   *
   * Set once per session by the connector. Rendered as a drawer rather than
   * folded into the system prompt because owner sessions must keep the full
   * owner prompt: a connector profile would replace it wholesale, which is the
   * wrong trade for "please use shorter paragraphs".
   */
  #surfaceBrief = "";

  /**
   * True once this session has been compacted at least once. Gates the
   * post-compaction reminder in `render()`; also a free "this transcript is
   * long" signal that costs no extra tokenization.
   */
  #compacted = false;

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
   *
   * The one system message that IS kept is the compaction boundary note. It is
   * not a prompt, it is the only surviving record of everything compacted away
   * before the crash — dropping it resumed the session missing precisely the
   * history it could no longer reconstruct.
   */
  restore(messages: ChatMessage[]): void {
    this.#messages = messages.filter(
      (m) => m.role !== "system" || m.content.startsWith(SUMMARY_PREFIX),
    );
    this.#compacted = this.#messages.some((m) => m.role === "system");
  }

  addUser(content: string, images?: string[]): void {
    this.add({ role: "user", content, ...(images && images.length > 0 ? { images } : {}) });
  }

  addAssistant(content: string): void {
    this.add({ role: "assistant", content });
  }

  /**
   * Append a turn replayed from episodic memory rather than lived in this
   * session.
   *
   * Flagged on the message, not by index, because compaction reorders and drops
   * — a boundary index would start pointing at the wrong turn the first time a
   * session compacted. What the flag buys is one honest lane in the breakdown:
   * replayed history is a cost you pay for continuity, and it is worth knowing
   * separately from the conversation actually happening now.
   */
  addReplayed(role: "user" | "assistant", content: string): void {
    this.add({ role, content, replayed: true });
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
    total += countTokens(this.#notebook);
    total += countTokens(this.#recallContext);
    total += countTokens(this.#objective);
    total += countTokens(this.#surfaceBrief);
    total += countTokens(this.#memoryContext);
    for (const m of this.#messages) {
      total += countTokens(m.content);
    }
    return total;
  }

  /**
   * Where the tokens go, for the prompt this memory would render right now.
   *
   * Every field `estimatedTokens()` sums appears here exactly once, so with no
   * `systemAsSent` the two totals agree — that is what keeps the compaction
   * budget and the cost table from describing different prompts.
   *
   * WITH `systemAsSent` they deliberately differ, and the difference is the
   * point: `estimatedTokens()` measures what we hold, because that is what the
   * compaction budget must bound, while this measures what leaves, because
   * that is what gets billed. Do not "fix" the divergence by making one call
   * the other.
   *
   * Empty lanes are omitted rather than reported as zero: a table full of zero
   * rows hides the rows that matter.
   *
   * Tool schemas are NOT here. They are built per session from the registry and
   * the drawer, and this class has never seen them; the caller adds that lane.
   */
  breakdown(systemAsSent?: (system: string) => string): PromptBreakdown {
    const parts: PromptPart[] = [];
    const push = (category: PromptPart["category"], detail: string, text: string): void => {
      if (!text) return;
      const tokens = countTokens(text);
      if (tokens === 0) return;
      parts.push({ category, detail, tokens });
    };

    // What the PROVIDER receives, which is not what we store. The system prompt
    // carries a `## Available tools` block, and every provider strips it before
    // sending whenever native tool definitions are in play — the same tools then
    // travel as a separate `tools` field, counted in its own lane. Measuring the
    // unstripped prompt therefore counted those tools twice AND counted bytes
    // that were never sent: on the first real completion it inflated our total
    // by 31% against the provider's, entirely in the largest lane. A cost table
    // has to measure the wire, not the intent.
    push("system_prompt", "system_prompt", systemAsSent ? systemAsSent(this.#system) : this.#system);
    // The per-turn drawers, named individually: "drawers are 12%" is not
    // actionable, "the todo list is 9% of every completion" is.
    push("drawer", "objective", this.#objective);
    push("drawer", "skill_menu", this.#skillMenu);
    push("drawer", "todo_list", this.#todoList);
    push("drawer", "notebook", this.#notebook);
    push("drawer", "recall", this.#recallContext);
    push("drawer", "surface_brief", this.#surfaceBrief);
    push("drawer", "memory_recall", this.#memoryContext);

    // Tool outputs are grouped by tool AND by whether #budgetToolResults has
    // already cut them. That second split is the one that answers whether
    // trimming is paying for itself.
    const toolTotals = new Map<string, number>();
    let conversationUser = 0;
    let conversationAssistant = 0;
    let replayUser = 0;
    let replayAssistant = 0;
    let summary = 0;

    for (const m of this.#messages) {
      const tokens = countTokens(m.content);
      if (tokens === 0) continue;
      if (m.role === "tool") {
        const trimmed = m.content.endsWith(TRIMMED_MARK) ? "trimmed" : "full";
        const key = `${m.name ?? "unknown"} (${trimmed})`;
        toolTotals.set(key, (toolTotals.get(key) ?? 0) + tokens);
      } else if (m.role === "system") {
        // The only system message inside the transcript is the compaction
        // boundary note; `restore()` drops every other one.
        summary += tokens;
      } else if (m.replayed) {
        if (m.role === "user") replayUser += tokens;
        else replayAssistant += tokens;
      } else if (m.role === "user") {
        conversationUser += tokens;
      } else {
        conversationAssistant += tokens;
      }
    }

    if (summary > 0) parts.push({ category: "compaction_summary", detail: "summary", tokens: summary });
    if (conversationUser > 0) parts.push({ category: "conversation", detail: "user", tokens: conversationUser });
    if (conversationAssistant > 0) parts.push({ category: "conversation", detail: "assistant", tokens: conversationAssistant });
    if (replayUser > 0) parts.push({ category: "episodic_replay", detail: "user", tokens: replayUser });
    if (replayAssistant > 0) parts.push({ category: "episodic_replay", detail: "assistant", tokens: replayAssistant });
    // Biggest first: the table is read to find what to attack.
    for (const [detail, tokens] of [...toolTotals].sort((a, b) => b[1] - a[1])) {
      parts.push({ category: "tool_output", detail, tokens });
    }

    return { parts, localTotal: parts.reduce((n, p) => n + p.tokens, 0) };
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
   * Update the per-turn view of the durable task list.
   *
   * Two blocks, deliberately separated. OPEN items are the work; CLOSED items
   * are the memory of work already done. The done block exists because the
   * transcript that recorded the work is summarized away while these rows are
   * not — without it, hour 6 of a long run has no record that hour 2 happened,
   * and the agent redoes it.
   *
   * The two headings say opposite things on purpose. One list is "do this", the
   * other is "do NOT do this". Rendered as one list they would read as a plan.
   *
   * ponytail: capped at 20 open / 8 closed, no pagination. A task list longer
   * than that is a planning problem, not a rendering one.
   */
  setTodoList(items: Array<{ id: string; content: string; status: string }>): void {
    const open = items.filter((t) => t.status !== "done").slice(0, 20);
    // `items` arrives newest-updated first (TodoStore.list ORDER BY updated_at
    // DESC), so the head of this slice is the most recently finished work —
    // which is the part most likely to be redone.
    const done = items.filter((t) => t.status === "done").slice(0, 8);
    const blocks: string[] = [];
    if (open.length > 0) {
      blocks.push(
        "## Your task list (persists across sessions — `todo_write` to update)\n" +
          "These are still OPEN. Do not redo anything absent from this list.\n\n" +
          open.map((t) => `- [${t.status}] \`${t.id}\` — ${t.content}`).join("\n"),
      );
    }
    if (done.length > 0) {
      blocks.push(
        "## Already done (most recent first)\n" +
          "This work is FINISHED. Do not redo it. Verify current state before any " +
          "write that one of these may already have performed.\n\n" +
          done.map((t) => `- \`${t.id}\` — ${t.content}`).join("\n"),
      );
    }
    this.#todoList = blocks.join("\n\n");
  }

  /**
   * Update the per-turn view of the notebook. Keys arrive with their `note:`
   * storage prefix and are rendered without it — the prefix is how the rows are
   * partitioned in the `semantic` table (see memory/semantic.ts), not something
   * the model needs to read.
   *
   * No cap here. The cap is enforced at the WRITE side (the `remember` tool), so
   * a full notebook is curated by its owner rather than silently truncated by
   * us. Truncating here would reintroduce exactly the failure this drawer exists
   * to escape.
   */
  setNotebook(notes: Array<{ key: string; value: string }>): void {
    if (notes.length === 0) {
      this.#notebook = "";
      return;
    }
    this.#notebook =
      "## Your notebook (durable — `remember` with a `note:` key to write)\n" +
      "You wrote these. They survive compaction. Trust them, keep them current, " +
      "and rewrite an entry the moment it stops being true.\n" +
      // Without this line the drawer hijacks the conversation. It is the most
      // concrete block in the prompt and it arrives with an instruction to act on
      // it, so "hello" came back as a status report about whatever the notes were
      // about — every turn, and worst on the first message of a new session where
      // the user has given no context at all. Rendering the notebook in full is
      // right for a long autonomous run; reciting it at someone who said hello is
      // not the same thing.
      "They are reference, not an agenda. Do not recite them, summarise them, or " +
      "bring them up unless the user's message is actually about them — answer " +
      "what was asked.\n\n" +
      notes
        .map((n) => `- **${n.key.replace(/^note:/, "")}** — ${n.value}`)
        .join("\n");
  }

  /**
   * Update the per-turn view of recalled memory.
   *
   * `context` arrives already rendered and self-delimited from the recall
   * engine, so it is stored verbatim; an empty string clears the drawer, which
   * is the normal case on a fresh profile with nothing to remember yet.
   *
   * Capped, unlike the notebook. The notebook has a write-side cap because its
   * owner curates it; this drawer is filled by a similarity search that has no
   * owner and no upper bound on how much it can match, so the cap belongs
   * here. Cut on a line boundary so a hit is either shown whole or not at all —
   * half a remembered fact is worse than none, because the model cannot tell
   * it is reading half.
   */
  setRecall(context: string, maxChars = 4000): void {
    const trimmed = context.trim();
    if (!trimmed) {
      this.#recallContext = "";
      return;
    }
    if (trimmed.length <= maxChars) {
      this.#recallContext = trimmed;
      return;
    }
    const lines = trimmed.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    this.#recallContext = kept.join("\n");
  }

  /**
   * Describe the surface this session's answers are rendered on. Idempotent —
   * connectors call it on every inbound message. Empty string clears it.
   */
  setSurfaceBrief(brief: string): void {
    this.#surfaceBrief = brief;
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
    if (this.#objective) dynamicBlocks.push(this.#objective);
    if (this.#skillMenu) dynamicBlocks.push(this.#skillMenu);
    if (this.#todoList) dynamicBlocks.push(this.#todoList);
    if (this.#notebook) dynamicBlocks.push(this.#notebook);
    if (this.#recallContext) dynamicBlocks.push(this.#recallContext);
    if (this.#surfaceBrief) dynamicBlocks.push(this.#surfaceBrief);
    // Post-compaction reminder. Both halves address a real late-session failure:
    // the model treats the summary note as verbatim history and re-does or
    // invents work, and it drifts off the tool-call syntax it has not emitted
    // for a while and starts DESCRIBING calls in prose instead of making them.
    // Only rendered once a session has actually compacted — a short chat pays
    // nothing, and the system prompt (which teaches both) is by then thousands
    // of tokens away from where generation happens.
    //
    // The first half used to end at "re-read the file or re-run the tool", with
    // no exception. Measured: a 24-file inventory task under a tight budget made
    // 117 read_file calls for 24 files and never finished. Every compaction took
    // the numbers away, the reminder said do not recall them, so it fetched them
    // again — four full rounds, then the wall clock. Two safeguards, each right
    // on its own, that multiply into a treadmill.
    //
    // So the summary now carries an `### Established facts` section written to be
    // exact (see AgentLoop.#summarize) and the reminder points at it. Without
    // this exception the instruction is "distrust everything you learned", which
    // on a long task means "never finish".
    if (this.#compacted) {
      dynamicBlocks.push(
        "## Reminder\n" +
          "- Earlier turns in this conversation were compacted into the summary note above. " +
          "Its `### Established facts` lines are EXACT — trust them and do not re-fetch what " +
          "is already there. The narrative around them is lossy: for a detail that is NOT in " +
          "that list, re-read the file or re-run the tool rather than recalling it.\n" +
          "- To use a tool, emit the call itself inside `<tool_call>` … `</tool_call>` tags, one " +
          'JSON object per block: `{"name": "tool_name", "args": {…}}`. Describing a tool call in ' +
          "prose does not run it. Answer in plain text if you no longer need a tool.",
      );
    }
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

    // Cheapest shaper first — but only now that we are over budget, because it
    // is not free the way it looks.
    //
    // It used to run above the check, on every single turn. It costs no model
    // call, so it read as free; what it actually costs is the prompt cache.
    // Trimming rewrites a tool result in the MIDDLE of the transcript, and a
    // prefix cache keys on bytes: the first message that differs from last turn
    // ends the reusable prefix, and everything after it is billed and prefilled
    // again. Measured with no memory pressure at all (17k transcript, 10M
    // budget), from the fifth tool result onward every turn moved the divergence
    // point back into the body and re-sent ~15,000 unchanged tokens to save the
    // ~476 the trim recovered. Thirty times the cost of the thing it bought.
    //
    // Down here it fires only when the transcript is genuinely over budget —
    // which is the one moment the cache is about to be invalidated anyway, by
    // the summary note this method is about to prepend. One invalidation per
    // compaction instead of one per turn, and it still runs before the
    // summarizer, so the "trim before you pay for a completion" intent it was
    // written for is intact.
    this.#budgetToolResults();
    // Trimming alone got us under. No summarizer, no history lost — but the
    // transcript did change, so this is a compaction and says so.
    if (this.estimatedTokens() <= targetTokens) return true;

    // The compaction boundary — a note THIS method wrote on an earlier pass.
    // It is held out of the region handed to the summarizer.
    //
    // It used to sit at index 0 of the transcript with nothing marking it as
    // special, so every later compaction summarized it along with the real
    // turns: a summary of a summary of a summary. Each pass is lossy and each
    // pass is free to invent, which is exactly the "it was fine and then it
    // started making things up" cliff on a long session. Summaries are carried
    // forward verbatim from here on, never re-compressed.
    const head = this.#messages[0];
    const boundary =
      head && head.role === "system" && head.content.startsWith(SUMMARY_PREFIX) ? head : null;
    const body = boundary ? this.#messages.slice(1) : this.#messages;
    if (body.length === 0) return false;

    // Pin the objective before the turn carrying it is folded away. See the
    // field docstring — this is the one thing summarization must not blur.
    if (!this.#objective) {
      const firstUser = body.find((m) => m.role === "user");
      if (firstUser?.content) {
        // Stored WITH its header, like #todoList and #skillMenu, so the header
        // is inside what estimatedTokens() and fixedOverhead already count.
        this.#objective =
          "## What this conversation is for (the original request)\n" +
          "Compaction has folded away the turn this came from. It is still the job.\n\n" +
          truncateToBudget(firstUser.content, OBJECTIVE_MAX_TOKENS);
      }
    }

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
      countTokens(this.#notebook) +
      countTokens(this.#recallContext) +
      countTokens(this.#objective) +
      countTokens(this.#surfaceBrief) +
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
    for (let i = body.length - 1; i >= 0; i--) {
      const msg = body[i]!;
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

    const cut = body.length - kept.length;
    if (cut <= 0) {
      // Nothing older to summarize, but we were over budget — the lone-huge
      // message was truncated above. Persist that and stop.
      this.#messages = boundary ? [boundary, ...kept] : kept;
      return true;
    }
    const older = body.slice(0, cut);

    let summary: string;
    try {
      summary = await summarize(older);
    } catch {
      // If summarization fails, fall back to a hard truncation note so memory
      // never grows unbounded and the agent never crashes.
      summary = `[${older.length} earlier turns omitted due to size]`;
    }

    // Append-only: what was already summarized stays byte-identical and the new
    // summary lands after it. When the accumulated block outgrows its reserve it
    // is cut head+tail (oldest facts and newest both survive) instead of being
    // handed back to the model. A one-shot truncation loses detail; a
    // re-summarization loses detail AND is free to invent replacements for it.
    // Given the failure being fixed is invention, truncation is the right trade.
    const carried = boundary ? boundary.content.slice(SUMMARY_PREFIX.length).trim() : "";
    const block = truncateToBudget(carried ? `${carried}\n\n${summary}` : summary, summaryReserve);

    this.#messages = [{ role: "system", content: `${SUMMARY_PREFIX} ${block}` }, ...kept];
    this.#compacted = true;
    return true;
  }

  /**
   * Layer 0 of compaction — cap tool results the model has moved past.
   *
   * A single `read_file` can return 64 KB (~16k tokens), which on the local
   * 8k transcript budget is the entire allowance spent on one message the model
   * already extracted what it needed from three steps ago. Left verbatim, stale
   * tool output is what drives a session into the summarizer over and over, and
   * every one of those passes costs history. Trimming it here is the cheapest
   * thing in the pipeline and buys the most turns.
   *
   * Idempotent (see TRIMMED_MARK) — this runs on every turn.
   *
   * ponytail: head+tail cut with a "re-run the tool" note, no content-addressed
   * store. If the model starts needing the dropped middles back, spill them to
   * disk and put a real reference in the note.
   */
  #budgetToolResults(): void {
    let seen = 0;
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      const msg = this.#messages[i]!;
      if (msg.role !== "tool") continue;
      // The freshest results are what the current reasoning step is built on.
      if (++seen <= TOOL_RESULT_KEEP_RECENT) continue;
      // Cheap guards before paying for real BPE tokenization on every turn:
      // one token is at least one character, so anything under the ceiling in
      // CHARS is certainly under it in tokens.
      if (msg.content.length <= TOOL_RESULT_MAX_TOKENS) continue;
      if (msg.content.endsWith(TRIMMED_MARK)) continue;
      if (countTokens(msg.content) <= TOOL_RESULT_MAX_TOKENS) continue;
      this.#messages[i] = {
        ...msg,
        content: `${truncateToBudget(msg.content, TOOL_RESULT_MAX_TOKENS)}\n${TRIMMED_MARK}`,
      };
    }
  }

  /** Drop all turns (keeps the system prompt). */
  clear(): void {
    this.#messages = [];
    this.#objective = "";
    this.#compacted = false;
    // #surfaceBrief deliberately survives: /new restarts the conversation, it
    // does not move it to a different app.
  }
}
