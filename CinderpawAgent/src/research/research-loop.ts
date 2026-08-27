/**
 * DeepResearch-style iterative research loop.
 *
 * Algorithm (ReAct — Reason + Act):
 *   1. Plan:    given question + accumulated notes, decide what to search next
 *               OR decide there's enough info to synthesize
 *   2. Search:  query Jina Search (s.jina.ai) for ranked results
 *   3. Select:  LLM picks the 2-3 most relevant URLs to read
 *   4. Read:    fetch each URL via Jina Reader (r.jina.ai)
 *   5. Extract: LLM pulls key findings from the page content
 *   6. Repeat until confident or max iterations reached
 *   7. Synthesize: write a final markdown report with inline citations
 *
 * The loop accepts a CinderpawFetch (already bound to s.jina.ai + r.jina.ai by the
 * deep_research tool's egress manifest) and an InferenceRouter (for LLM calls
 * within the loop). Every LLM call still counts against the session budget.
 */

import type { InferenceRouter } from "../egress/inference-router.ts";
import type { CinderpawFetch, ToolProgressPayload } from "../types.ts";
import { ddgLiteSearch } from "../tools/builtin/ddg-lite.ts";

export type ResearchProgressStage =
  | "start"
  | "plan"
  | "search"
  | "select"
  | "read"
  | "extract"
  | "synthesize"
  | "complete"
  | "stopped";

export interface ResearchProgressPayload extends ToolProgressPayload {
  stage: ResearchProgressStage;
}

type ResearchProgressHandler = (event: ResearchProgressPayload) => void;

export interface ResearchSource {
  url: string;
  title: string;
  excerpt: string;
}

export interface ResearchResult {
  report: string;
  sources: ResearchSource[];
  iterations: number;
  stopped?: boolean;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface Note {
  iteration: number;
  query: string;
  url: string;
  title: string;
  excerpt: string;
}

export class ResearchStoppedError extends Error {
  constructor() {
    super("research stopped");
    this.name = "ResearchStoppedError";
  }
}

export class ResearchLoop {
  readonly #router: InferenceRouter;
  readonly #fetch: CinderpawFetch;
  readonly #sessionId: string;
  readonly #jinaApiKey: string | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #progress: ResearchProgressHandler | undefined;

  constructor(
    router: InferenceRouter,
    fetch: CinderpawFetch,
    sessionId: string,
    jinaApiKey?: string,
    signal?: AbortSignal,
    progress?: ResearchProgressHandler,
  ) {
    this.#router = router;
    this.#fetch = fetch;
    this.#sessionId = sessionId;
    this.#jinaApiKey = jinaApiKey;
    this.#signal = signal;
    this.#progress = progress;
  }

  async run(question: string, maxIterations = 4): Promise<ResearchResult> {
    const notes: Note[] = [];
    this.#emit("start", 0, "Deep research started", {
      question,
      maxIterations,
    });

    try {
      for (let i = 0; i < maxIterations; i++) {
        this.#throwIfStopped();

        // Plan: what to search for (or stop if enough info)
        this.#emit("plan", this.#progressPercent(i, maxIterations), "Planning the next research step", {
          iteration: i + 1,
        });
        const plan = await this.#plan(question, notes, i);
        if (plan.action === "synthesize") break;
        if (!plan.query) break;

        // Search
        this.#emit("search", this.#progressPercent(i, maxIterations), "Searching the web", {
          query: plan.query,
        });
        const results = await this.#search(plan.query);
        if (results.length === 0) continue;

        // Select top URLs to read
        this.#emit("select", this.#progressPercent(i, maxIterations), "Selecting sources to read", {
          resultCount: results.length,
        });
        const selected = await this.#selectUrls(question, plan.query, results, notes);

        // Read + Extract
        for (const url of selected.slice(0, 3)) {
          this.#throwIfStopped();
          // Skip URLs we already read
          if (notes.some((n) => n.url === url)) continue;

          this.#emit("read", this.#progressPercent(i, maxIterations), "Reading source", {
            url,
          });
          const content = await this.#readPage(url);
          if (!content) continue;

          this.#emit("extract", this.#progressPercent(i, maxIterations), "Extracting findings", {
            url,
          });
          const srcResult = results.find((r) => r.url === url);
          const excerpt = await this.#extractFindings(question, url, content);
          if (excerpt.trim()) {
            notes.push({
              iteration: i + 1,
              query: plan.query,
              url,
              title: srcResult?.title ?? url,
              excerpt,
            });
          }
        }
      }

      this.#emit("synthesize", 95, "Synthesizing final report");
      const report = await this.#synthesize(question, notes);
      this.#emit("complete", 100, "Deep research complete", {
        sources: notes.length,
        iterations: notes.length > 0 ? (notes[notes.length - 1]?.iteration ?? 0) : 0,
      });
      return {
        report,
        sources: notes.map((n) => ({ url: n.url, title: n.title, excerpt: n.excerpt })),
        iterations: notes.length > 0 ? (notes[notes.length - 1]?.iteration ?? 0) : 0,
      };
    } catch (err) {
      if (err instanceof ResearchStoppedError) {
        this.#emit("stopped", this.#progressPercent(0, maxIterations), "Deep research stopped", {
          sources: notes.length,
          iterations: notes.length > 0 ? (notes[notes.length - 1]?.iteration ?? 0) : 0,
        });
        return {
          report: this.#stoppedReport(question, notes),
          sources: notes.map((n) => ({ url: n.url, title: n.title, excerpt: n.excerpt })),
          iterations: notes.length > 0 ? (notes[notes.length - 1]?.iteration ?? 0) : 0,
          stopped: true,
        };
      }
      throw err;
    }
  }

  #emit(
    stage: ResearchProgressStage,
    progress: number | null,
    message: string,
    data?: unknown,
  ): void {
    this.#progress?.({ stage, progress, message, data });
  }

  #throwIfStopped(): void {
    if (this.#signal?.aborted) throw new ResearchStoppedError();
  }

  #progressPercent(iteration: number, maxIterations: number): number {
    if (maxIterations <= 0) return 0;
    return Math.min(90, Math.round(((iteration + 0.25) / maxIterations) * 90));
  }

  #stoppedReport(question: string, notes: Note[]): string {
    if (notes.length === 0) {
      return `Research stopped before any sources were gathered for: **${question}**`;
    }

    const notesText = notes
      .map(
        (n, i) =>
          `## Source [${i + 1}]: ${n.title}\nURL: ${n.url}\n\n${n.excerpt}`,
      )
      .join("\n\n---\n\n");

    const sourceList = notes
      .map((n, i) => `[${i + 1}] ${n.title} — ${n.url}`)
      .join("\n");

    return (
      `Research stopped before synthesis completed for: **${question}**\n\n` +
      `Collected notes:\n${notesText}\n\nSources:\n${sourceList}`
    );
  }

  /** Decide: search (with a new query) or synthesize (enough info). */
  async #plan(
    question: string,
    notes: Note[],
    iteration: number,
  ): Promise<{ action: "search" | "synthesize"; query?: string }> {
    const notesText =
      notes.length > 0
        ? notes
            .map(
              (n, i) =>
                `[${i + 1}] From "${n.title}":\n${n.excerpt.slice(0, 300)}`,
            )
            .join("\n\n")
        : "No research done yet.";

    // On the first iteration always search
    const forceSearch = iteration === 0;

    const res = await this.#router.complete({
      sessionId: this.#sessionId,
      messages: [
        {
          role: "system",
          content: [
            "You are a research planner. Decide the next research step.",
            "Reply with ONLY a valid JSON object — no explanation, no markdown wrapper.",
            "",
            "If more research is needed:",
            '{"action":"search","query":"specific focused search query"}',
            "",
            "If the accumulated notes already answer the question comprehensively:",
            '{"action":"synthesize"}',
            "",
            forceSearch
              ? "This is the first iteration — always return a search action."
              : "",
            "Vary queries across iterations; do not repeat the same search.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        {
          role: "user",
          content:
            `Research question: ${question}\n\n` +
            `Accumulated notes (${notes.length}):\n${notesText}`,
        },
      ],
      maxTokens: 150,
      temperature: 0.1,
      signal: this.#signal,
    });

    try {
      const jsonMatch = res.content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          action?: string;
          query?: string;
        };
        if (parsed.action === "synthesize" && !forceSearch)
          return { action: "synthesize" };
        if (typeof parsed.query === "string" && parsed.query.trim())
          return { action: "search", query: parsed.query.trim() };
      }
    } catch {
      // fallthrough to default
    }
    return { action: "search", query: question };
  }

  /**
   * One search step. Jina Search needs an API key now (it answers 401 without
   * one), which made deep_research dead on a default install — including as
   * web_search's declared escalation. So: Jina only when a key exists, and DDG
   * Lite whenever Jina is absent or comes up empty.
   */
  async #search(query: string): Promise<SearchResult[]> {
    if (this.#jinaApiKey) {
      const hits = await this.#jinaSearch(query);
      if (hits.length > 0) return hits;
    }
    const { results } = await ddgLiteSearch(this.#fetch, query, { signal: this.#signal });
    return results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? "" }));
  }

  /** Search via Jina Search API; parse JSON or markdown fallback. */
  async #jinaSearch(query: string): Promise<SearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://s.jina.ai/${encoded}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.#jinaApiKey)
        headers["Authorization"] = `Bearer ${this.#jinaApiKey}`;

      const res = await this.#fetch(url, { timeoutMs: 20_000, headers, signal: this.#signal });
      if (!res.ok) return [];

      const raw = await res.text();

      // Structured JSON response
      try {
        const data = JSON.parse(raw) as {
          data?: Array<{
            title?: string;
            url?: string;
            description?: string;
          }>;
        };
        if (Array.isArray(data?.data) && data.data.length > 0) {
          return data.data
            .slice(0, 8)
            .map((r) => ({
              title: r.title ?? "Untitled",
              url: r.url ?? "",
              snippet: r.description ?? "",
            }))
            .filter((r) => r.url.startsWith("http"));
        }
      } catch {
        // Not JSON — fall through to text parsing
      }

      return parseMarkdownResults(raw);
    } catch (err) {
      if (err instanceof ResearchStoppedError) throw err;
      return [];
    }
  }

  /** LLM picks the most relevant URLs to read from the result list. */
  async #selectUrls(
    question: string,
    query: string,
    results: SearchResult[],
    notes: Note[],
  ): Promise<string[]> {
    if (results.length <= 2)
      return results.map((r) => r.url).filter((u) => u.startsWith("http"));

    const alreadyRead = new Set(notes.map((n) => n.url));
    const fresh = results.filter((r) => !alreadyRead.has(r.url));
    if (fresh.length === 0) return [];
    if (fresh.length <= 2) return fresh.map((r) => r.url);

    const list = fresh
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
      .join("\n\n");

    const res = await this.#router.complete({
      sessionId: this.#sessionId,
      messages: [
        {
          role: "system",
          content: [
            "Select the 2-3 most relevant search results to read in detail.",
            "Reply with ONLY a JSON array of URLs, no explanation:",
            '["https://...","https://..."]',
          ].join("\n"),
        },
        {
          role: "user",
          content:
            `Question: ${question}\nSearch query: ${query}\n\nResults:\n${list}`,
        },
      ],
      maxTokens: 256,
      temperature: 0.1,
      signal: this.#signal,
    });

    try {
      const match = res.content.match(/\[[\s\S]*?\]/);
      if (match) {
        const urls = JSON.parse(match[0]) as unknown[];
        return urls
          .filter(
            (u): u is string => typeof u === "string" && u.startsWith("http"),
          )
          .slice(0, 3);
      }
    } catch {
      // fallthrough
    }
    return fresh.slice(0, 2).map((r) => r.url);
  }

  /** Fetch page content via Jina Reader. */
  async #readPage(url: string): Promise<string | null> {
    try {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const headers: Record<string, string> = { Accept: "text/plain" };
      if (this.#jinaApiKey)
        headers["Authorization"] = `Bearer ${this.#jinaApiKey}`;

      const res = await this.#fetch(jinaUrl, { timeoutMs: 30_000, headers, signal: this.#signal });
      if (!res.ok) return null;

      const text = await res.text();
      return text.slice(0, 40_000);
    } catch (err) {
      if (err instanceof ResearchStoppedError) throw err;
      return null;
    }
  }

  /** Extract key findings from a page, relevant to the research question. */
  async #extractFindings(
    question: string,
    url: string,
    content: string,
  ): Promise<string> {
    const truncated = content.slice(0, 8_000);

    const res = await this.#router.complete({
      sessionId: this.#sessionId,
      messages: [
        {
          role: "system",
          content: [
            "Extract the key research findings from this webpage.",
            "Return 3-5 bullet points of the most relevant facts.",
            "Be specific: include numbers, dates, names, and concrete claims.",
            "If the page is not relevant to the question, reply with exactly: NOT_RELEVANT",
          ].join("\n"),
        },
        {
          role: "user",
          content:
            `Research question: ${question}\nSource: ${url}\n\nContent:\n${truncated}`,
        },
      ],
      maxTokens: 512,
      temperature: 0.2,
      signal: this.#signal,
    });

    const text = res.content.trim();
    return text === "NOT_RELEVANT" ? "" : text;
  }

  /** Write the final markdown research report from all accumulated notes. */
  async #synthesize(question: string, notes: Note[]): Promise<string> {
    if (notes.length === 0) {
      return (
        `No information could be gathered for: **${question}**\n\n` +
        `The web search returned no accessible results. ` +
        `Try rephrasing the question or checking your network connection.`
      );
    }

    const notesText = notes
      .map(
        (n, i) =>
          `## Source [${i + 1}]: ${n.title}\nURL: ${n.url}\n\n${n.excerpt}`,
      )
      .join("\n\n---\n\n");

    const sourceList = notes
      .map((n, i) => `[${i + 1}] ${n.title} — ${n.url}`)
      .join("\n");

    const res = await this.#router.complete({
      sessionId: this.#sessionId,
      messages: [
        {
          role: "system",
          content: [
            "Write a comprehensive, well-structured markdown research report.",
            "Structure: Brief intro → Key Findings (with inline citations [1], [2]) → Conclusion → Not confirmed → Sources.",
            "Use inline citations like [1] or [1,2] when referencing sources.",
            // "Do not invent facts" alone does not hold: it asks for a property
            // nothing checks. These make it checkable sentence by sentence, and
            // give the gaps a place to go so they stop being filled in.
            "Every factual sentence carries a citation. A sentence with no citation is your own inference and must say so ('this suggests', 'no source states').",
            "Specific values — file paths, config keys, version numbers, prices, benchmark figures — may ONLY be written if a note contains them. Never reconstruct a plausible-looking one; a precise invention is worse than an omission because it can be acted on.",
            "Judge a claim by its source. A vendor's own site or repository is primary; a blog, forum post, wiki or AI-generated summary is secondary. When a number or a technical detail rests only on a secondary source, say so where you state it.",
            "End with '## Not confirmed' — what the question asked that the notes do not answer, and any claim resting on a single secondary source. Write 'Nothing material' only if that is true.",
            "End with a '## Sources' section listing all references.",
          ].join("\n"),
        },
        {
          role: "user",
          content:
            `Research question: ${question}\n\n` +
            `Collected notes:\n${notesText}\n\n` +
            `Source references:\n${sourceList}`,
        },
      ],
      maxTokens: 4096,
      temperature: 0.3,
      signal: this.#signal,
    });

    return res.content.trim();
  }
}

/** Parse markdown-formatted search results (Jina text fallback). */
function parseMarkdownResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];

  for (const line of text.split("\n")) {
    // Match markdown links: [Title](https://...)
    const m = line.match(/\[([^\]]+)\]\((https?:[^)]+)\)/);
    if (m) {
      const rest = line.replace(m[0], "").replace(/^[:\s–-]+/, "").trim();
      results.push({ title: m[1]!, url: m[2]!, snippet: rest });
    }
  }

  return results.slice(0, 8);
}
