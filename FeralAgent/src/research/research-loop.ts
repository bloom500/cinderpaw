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
 * The loop accepts a FeralFetch (already bound to s.jina.ai + r.jina.ai by the
 * deep_research tool's egress manifest) and an InferenceRouter (for LLM calls
 * within the loop). Every LLM call still counts against the session budget.
 */

import type { InferenceRouter } from "../sandbox/inference-router.ts";
import type { FeralFetch } from "../types.ts";

export interface ResearchSource {
  url: string;
  title: string;
  excerpt: string;
}

export interface ResearchResult {
  report: string;
  sources: ResearchSource[];
  iterations: number;
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

export class ResearchLoop {
  readonly #router: InferenceRouter;
  readonly #fetch: FeralFetch;
  readonly #sessionId: string;
  readonly #jinaApiKey: string | undefined;

  constructor(
    router: InferenceRouter,
    fetch: FeralFetch,
    sessionId: string,
    jinaApiKey?: string,
  ) {
    this.#router = router;
    this.#fetch = fetch;
    this.#sessionId = sessionId;
    this.#jinaApiKey = jinaApiKey;
  }

  async run(question: string, maxIterations = 4): Promise<ResearchResult> {
    const notes: Note[] = [];

    for (let i = 0; i < maxIterations; i++) {
      // Plan: what to search for (or stop if enough info)
      const plan = await this.#plan(question, notes, i);
      if (plan.action === "synthesize") break;
      if (!plan.query) break;

      // Search
      const results = await this.#search(plan.query);
      if (results.length === 0) continue;

      // Select top URLs to read
      const selected = await this.#selectUrls(question, plan.query, results, notes);

      // Read + Extract
      for (const url of selected.slice(0, 3)) {
        // Skip URLs we already read
        if (notes.some((n) => n.url === url)) continue;

        const content = await this.#readPage(url);
        if (!content) continue;

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

    const report = await this.#synthesize(question, notes);
    return {
      report,
      sources: notes.map((n) => ({ url: n.url, title: n.title, excerpt: n.excerpt })),
      iterations: notes.length > 0 ? (notes[notes.length - 1]?.iteration ?? 0) : 0,
    };
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

  /** Search via Jina Search API; parse JSON or markdown fallback. */
  async #search(query: string): Promise<SearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://s.jina.ai/${encoded}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.#jinaApiKey)
        headers["Authorization"] = `Bearer ${this.#jinaApiKey}`;

      const res = await this.#fetch(url, { timeoutMs: 20_000, headers });
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
    } catch {
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

      const res = await this.#fetch(jinaUrl, { timeoutMs: 30_000, headers });
      if (!res.ok) return null;

      const text = await res.text();
      return text.slice(0, 40_000);
    } catch {
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
            "Structure: Brief intro → Key Findings (with inline citations [1], [2]) → Conclusion → Sources.",
            "Use inline citations like [1] or [1,2] when referencing sources.",
            "End with a '## Sources' section listing all references.",
            "Do not invent facts beyond what the notes contain.",
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
