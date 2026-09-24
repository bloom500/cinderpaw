// The real agent's answer stream (spec 2026-09-24 §6.1): POST /runtime/chat
// on the same "chat" session `cinderpaw chat` uses. The engine answers with
// SSE: OpenAI-style data chunks plus typed `event: tool_*` frames. Parsed
// here the way the TUI does it (tui/api/client.go StreamChat).

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; id: string; tool: string }
  | { type: "tool_done"; id: string; tool: string; ok: boolean }
  | { type: "error"; detail: string }
  | ({ type: "secret" } & SecretAsk)
  | { type: "ask"; requestId: string; question: string; options: string[] }
  | { type: "done" };

/** A request_secret question: the page shows a password field for it. */
export type SecretAsk = { requestId: string; question: string; connector: string; field: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SESSION = "chat";

/**
 * Tool frames carry the MESSAGE id, not a per-call one, so a finished tool is
 * matched to the last still-running row with the same name.
 */
export function finishTool<T extends { tool: string; ok?: boolean }>(rows: T[], tool: string, ok: boolean): T[] {
  let i = -1;
  rows.forEach((r, j) => {
    if (r.tool === tool && r.ok === undefined) i = j;
  });
  return rows.map((r, j) => (j === i ? { ...r, ok } : r));
}

/** Finish the tool in whichever bubble is still running it, newest first. */
export function finishToolIn<L extends { tools?: { tool: string; ok?: boolean }[] }>(lines: L[], tool: string, ok: boolean): L[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rows = lines[i].tools;
    if (rows?.some((r) => r.tool === tool && r.ok === undefined)) {
      return lines.map((l, j) => (j === i ? { ...l, tools: finishTool(rows, tool, ok) } : l));
    }
  }
  return lines;
}

/** Complete SSE records from `buffer`, and whatever trailing part is not yet complete. */
export function parseSse(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const records = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = records.pop() ?? "";
  const events = records.flatMap((rec) => {
    let event = "message";
    const data: string[] = [];
    for (const line of rec.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

/** Some models put their thinking inline as <think>…</think>; keep it out of the answer. */
export class ThinkSplitter {
  private inThink = false;
  private pending = "";

  feed(text: string): { answer: string; reasoning: string } {
    let s = this.pending + text;
    this.pending = "";
    let answer = "";
    let reasoning = "";
    while (s) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = s.indexOf(tag);
      if (i >= 0) {
        if (this.inThink) reasoning += s.slice(0, i);
        else answer += s.slice(0, i);
        s = s.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a tail that could be the start of the tag.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(-k))) {
          keep = k;
          break;
        }
      }
      const out = s.slice(0, s.length - keep);
      this.pending = s.slice(s.length - keep);
      if (this.inThink) reasoning += out;
      else answer += out;
      s = "";
    }
    return { answer, reasoning };
  }
}

export async function streamChat(f: Fetch, content: string, on: (e: ChatEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await f("/runtime/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // "web": this surface can show cards, so request_secret may ask here.
      body: JSON.stringify({ content, session_id: SESSION, surface: "web" }),
    });
  } catch (e) {
    return on({ type: "error", detail: String(e) });
  }
  if (!res.ok || !res.body) {
    return on({ type: "error", detail: `${res.status} ${await res.text().catch(() => "")}`.trim() });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const think = new ThinkSplitter();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(buf + dec.decode(value, { stream: true }));
      buf = parsed.rest;
      for (const { event, data } of parsed.events) {
        if (data === "[DONE]") return on({ type: "done" });
        let raw: Record<string, any>;
        try {
          raw = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === "tool_start") {
          on({ type: "tool_start", id: String(raw.id ?? ""), tool: String(raw.tool ?? "") });
          continue;
        }
        if (event === "tool_done") {
          // The sidecar puts success in result.ok (top-level ok on older builds).
          const ok = (raw.ok ?? raw.result?.ok) !== false;
          on({ type: "tool_done", id: String(raw.id ?? ""), tool: String(raw.tool ?? ""), ok });
          continue;
        }
        if (event === "ask_user") {
          const q = raw.questions?.[0];
          if (!q) continue;
          if (q.secret?.connector && q.secret?.field) {
            on({ type: "secret", requestId: String(raw.id), question: String(q.question), connector: q.secret.connector, field: q.secret.field });
          } else {
            on({ type: "ask", requestId: String(raw.id), question: String(q.question), options: (q.options ?? []).map((o: any) => String(o.label)) });
          }
          continue;
        }
        if (event !== "message") continue;
        if (raw.error) return on({ type: "error", detail: String(raw.error) });
        const choice = raw.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.reasoning_content) on({ type: "reasoning", text: choice.delta.reasoning_content });
        if (choice.delta?.content) {
          const { answer, reasoning } = think.feed(choice.delta.content);
          if (reasoning) on({ type: "reasoning", text: reasoning });
          if (answer) on({ type: "text", text: answer });
        }
        if (choice.finish_reason === "error") return on({ type: "error", detail: String(raw.error ?? "error") });
        if (choice.finish_reason === "stop") return on({ type: "done" });
      }
    }
  } catch (e) {
    return on({ type: "error", detail: String(e) });
  }
  // The stream ended without saying it was done: the engine went away mid-answer.
  on({ type: "error", detail: "the answer stopped before it finished" });
}

/** Answer an agent's question (ask_user) with one option label. */
export async function answerAsk(f: Fetch, requestId: string, question: string, label: string): Promise<boolean> {
  try {
    const r = await f("/runtime/ask/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, answers: [{ question, selected: [label] }] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The secure field's Save: the value goes to the engine and nowhere else;
 * the waiting agent is only told "Saved", and only once the engine took it.
 */
export async function saveSecret(f: Fetch, ask: SecretAsk, raw: string): Promise<boolean> {
  const value = raw.trim();
  if (!value) return false;
  try {
    const r = await f("/runtime/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ask.connector, secrets: { [ask.field]: value } }),
    });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  return answerAsk(f, ask.requestId, ask.question, "Saved");
}
