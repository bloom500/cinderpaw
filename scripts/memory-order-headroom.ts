/**
 * Does it matter WHICH memories reach the model, and in what order?
 *
 * The only seam CinderBrain (or any learned reranker) could touch is the order of the
 * memories FMS already found. Before building anything that reorders them, this measures
 * how much a PERFECT order could add, with a real answering model, in the production
 * format: at most 10 hits, 200-character snippets, a 4000-character block.
 *
 * Arms, per LongMemEval-S question (non-abstention):
 *   NONE         no memory block
 *   FMS          FMS top 10, as production ranks them
 *   REVERSED     the same 10, reversed (order only)
 *   RANDOM       10 drawn at random from FMS's top 40 (a reranker with no signal)
 *   ORACLE       the labelled evidence turns first, then FMS fill to 10 (perfect reranking)
 *   ORACLE-FULL  as ORACLE but evidence turns are not cut to 200 characters (is the cut the limit?)
 *
 * Preregistration and decision rules: bench-results/memory-order/PREREGISTRATION.md.
 *
 *   bun scripts/memory-order-headroom.ts                      # estimate only, calls nothing paid
 *   bun scripts/memory-order-headroom.ts --run --approved-usd 8   # the paid run, stops at the cap
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collapseIdentical } from "../CinderpawAgent/src/memory/fractal/cross-session-dedup.ts";
import { FractalRecallEngine, MAX_CONTEXT_HITS, dateStamp, snippet } from "../CinderpawAgent/src/memory/fractal/fractal-recall.ts";
import { buildTree } from "../CinderpawAgent/src/memory/fractal/tree-builder.ts";
import type { Leaf } from "../CinderpawAgent/src/memory/fractal/types.ts";
import { embedCached, isAbstention, makeFts, stratify, type Instance, type Turn } from "./longmemeval.ts";

export const ARMS = ["NONE", "FMS", "REVERSED", "RANDOM", "ORACLE", "ORACLE-FULL"] as const;
export type Arm = (typeof ARMS)[number];
export const ANSWER_MODEL = "z-ai/glm-5.3-flash";
export const ANSWER_PROVIDER = "z-ai/fp8";
export const JUDGE_MODEL = "openai/gpt-4o-2024-08-06";
/** Production: CINDERPAW_RECALL_INJECTION_MAX_CHARS default. */
export const INJECTION_MAX_CHARS = 4000;
const POOL = 40;
const OUT_DIR = "bench-results/memory-order";

export interface MemTurn { id: number; ts: number; role: string; content: string; evidence: boolean }

/** One memory line in the production shape "[date] role: snippet". */
export const memoryLine = (t: MemTurn, full: boolean) =>
  `  [${t.ts > 0 ? dateStamp(t.ts) : "????-??-??"}] ${t.role ? `${t.role}: ` : ""}${full ? t.content : snippet(t.content)}`;

/** The block the agent would see, cut on a line boundary at the injection cap (working.ts setRecall). */
export function memoryBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  const all = ["[Memory context]", "Relevant past exchanges (fractal hybrid):", ...lines, "[End memory context]"];
  const kept: string[] = [];
  let used = 0;
  for (const l of all) {
    if (used + l.length + 1 > INJECTION_MAX_CHARS) break;
    kept.push(l);
    used += l.length + 1;
  }
  return kept.join("\n");
}

/** Deterministic unit value per string (FNV-1a), the same shuffle key longmemeval.ts uses. */
const unit = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 100000) / 100000; };

/** Arm -> ordered turn ids plus whether evidence lines are shown uncut. `ranked` is FMS order, at least POOL long when available. */
export function armIds(arm: Arm, ranked: number[], evidence: number[], seed: string): { ids: number[]; fullEvidence: boolean } {
  const top = ranked.slice(0, MAX_CONTEXT_HITS);
  switch (arm) {
    case "NONE": return { ids: [], fullEvidence: false };
    case "FMS": return { ids: top, fullEvidence: false };
    case "REVERSED": return { ids: [...top].reverse(), fullEvidence: false };
    case "RANDOM": return { ids: ranked.slice(0, POOL).map((id) => [id, unit(`${seed}:${id}`)] as const).sort((a, b) => a[1] - b[1]).slice(0, MAX_CONTEXT_HITS).map(([id]) => id), fullEvidence: false };
    case "ORACLE":
    case "ORACLE-FULL": {
      const ev = evidence.slice(0, MAX_CONTEXT_HITS);
      return { ids: [...ev, ...ranked.filter((id) => !ev.includes(id))].slice(0, MAX_CONTEXT_HITS), fullEvidence: arm === "ORACLE-FULL" };
    }
  }
}

/** LongMemEval's own non-CoT answer prompt (src/generation/run_generation.py). */
export const answerPrompt = (block: string, date: string, question: string) =>
  `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n${block || "(none)"}\n\nCurrent Date: ${date}\nQuestion: ${question}\nAnswer:`;

/** LongMemEval's judge prompts, verbatim (src/evaluation/evaluate_qa.py), non-abstention. */
export function judgePrompt(type: string, q: string, a: string, r: string): string {
  const head = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ";
  if (type === "temporal-reasoning") return `${head}In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  if (type === "knowledge-update") return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  if (type === "single-session-preference") return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q}\n\nRubric: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
  return `${head}\n\nQuestion: ${q}\n\nCorrect Answer: ${a}\n\nModel Response: ${r}\n\nIs the model response correct? Answer yes or no only.`;
}

/** Paired difference B - A over questions, with a seeded bootstrap 95% interval. */
export function pairedDiff(a: boolean[], b: boolean[], resamples = 2000, seed = 1): { diff: number; lo: number; hi: number; wins: number; losses: number; ties: number } {
  const n = a.length, d = a.map((x, i) => Number(b[i]) - Number(x));
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) { let t = 0; for (let i = 0; i < n; i++) t += d[Math.floor(rand() * n)]!; means.push(t / n); }
  means.sort((x, y) => x - y);
  return { diff: d.reduce((x, y) => x + y, 0) / n, lo: means[Math.floor(0.025 * resamples)]!, hi: means[Math.floor(0.975 * resamples)]!, wins: d.filter((x) => x > 0).length, losses: d.filter((x) => x < 0).length, ties: d.filter((x) => x === 0).length };
}

async function prices(): Promise<Record<string, { in: number; out: number }>> {
  const d = (await (await fetch("https://openrouter.ai/api/v1/models")).json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] };
  const pick = (id: string) => { const m = d.data.find((x) => x.id === id); if (!m) throw new Error(`${id} not listed by OpenRouter`); return { in: Number(m.pricing.prompt), out: Number(m.pricing.completion) }; };
  return { [ANSWER_MODEL]: pick(ANSWER_MODEL), [JUDGE_MODEL]: pick(JUDGE_MODEL) };
}

const turnsOf = (inst: Instance): (Turn & { evidence: boolean })[] => {
  const out: (Turn & { evidence: boolean })[] = [];
  inst.haystack_sessions.forEach((session, si) => {
    const ts = Date.parse(inst.haystack_dates[si] ?? inst.question_date) || 0;
    for (const t of session) if (t.content?.trim()) out.push({ id: out.length + 1, sessionId: inst.haystack_session_ids[si]!, ts, role: t.role, content: t.content, evidence: t.has_answer === true });
  });
  return out;
};

if (import.meta.main) {
  const run = process.argv.includes("--run");
  const cap = Number(process.argv[process.argv.indexOf("--approved-usd") + 1]);
  const data = JSON.parse(readFileSync("data/longmemeval/longmemeval_s_cleaned.json", "utf8")) as (Instance & { answer: string })[];
  const pool = stratify(data.filter((i) => !isAbstention(i)), 10_000) as (Instance & { answer: string })[];
  const pr = await prices();
  const tok = (chars: number) => chars / 3.5; // conservative for English text

  if (!run) {
    // Upper bounds from the format, not from retrieval: 10 cut lines, or evidence uncut plus fill, under the 4000 cap.
    const cutLine = 2 + 13 + 11 + 201;
    let answerIn = 0, noEvidence = 0;
    for (const inst of pool) {
      const turns = turnsOf(inst), ev = turns.filter((t) => t.evidence);
      if (ev.length === 0) noEvidence++;
      const evFull = Math.min(INJECTION_MAX_CHARS, 60 + ev.slice(0, 10).reduce((s, t) => s + memoryLine({ ...t }, true).length + 1, 0) + Math.max(0, 10 - ev.length) * cutLine);
      const base = 250 + inst.question.length;
      answerIn += tok(base) + 4 * tok(base + 60 + 10 * cutLine) + tok(base + evFull);
    }
    const calls = pool.length * ARMS.length;
    const scen = (outTok: number) => {
      const judgeIn = calls * tok(700 + outTok * 3.5);
      const answer = answerIn * pr[ANSWER_MODEL]!.in + calls * outTok * pr[ANSWER_MODEL]!.out;
      const judge = judgeIn * pr[JUDGE_MODEL]!.in + calls * 3 * pr[JUDGE_MODEL]!.out;
      return { answer, judge, total: answer + judge };
    };
    const lines = [
      `# Memory-order headroom: cost estimate (nothing paid was called)`,
      ``,
      `${pool.length} LongMemEval-S questions (non-abstention) x ${ARMS.length} arms = ${calls} answer calls + ${calls} judge calls. Questions with no has_answer turn (ORACLE = FMS for them): ${noEvidence}.`,
      `Answer ${ANSWER_MODEL} pinned to ${ANSWER_PROVIDER}: $${(pr[ANSWER_MODEL]!.in * 1e6).toFixed(3)} / $${(pr[ANSWER_MODEL]!.out * 1e6).toFixed(3)} per M in/out. Judge ${JUDGE_MODEL} (LongMemEval's official judge): $${(pr[JUDGE_MODEL]!.in * 1e6).toFixed(2)} / $${(pr[JUDGE_MODEL]!.out * 1e6).toFixed(2)}. Prices read live from OpenRouter ${new Date().toISOString().slice(0, 10)}.`,
      `Answer input tokens (upper bound): ${(answerIn / 1e6).toFixed(2)} M.`,
      ``,
      `| scenario | answer $ | judge $ | total $ |`, `|---|---|---|---|`,
      ...[["short answers, reasoning off (150 tok)", 150], ["long answers (500 tok)", 500], ["reasoning leaks through (2500 tok)", 2500]].map(([n, o]) => { const s = scen(o as number); return `| ${n} | ${s.answer.toFixed(2)} | ${s.judge.toFixed(2)} | ${s.total.toFixed(2)} |`; }),
      ``,
      `Add ~20% for retries. The run refuses to start without --approved-usd and stops when spend reaches it.`,
    ].join("\n");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "COST-ESTIMATE.md"), lines + "\n");
    console.log(lines);
    process.exit(0);
  }

  if (!(cap > 0)) throw new Error("--run needs --approved-usd <dollars>, the cap Darius approved");
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  let spend = 0;
  const call = async (model: string, prompt: string, maxTokens: number, provider?: string) => {
    if (spend >= cap) throw new Error(`spend cap $${cap} reached`);
    const body: Record<string, unknown> = { model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens };
    if (provider) Object.assign(body, { provider: { order: [provider], allow_fallbacks: false }, reasoning: { enabled: false } });
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      if (res.ok) {
        const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        spend += (j.usage?.prompt_tokens ?? 0) * pr[model]!.in + (j.usage?.completion_tokens ?? 0) * pr[model]!.out;
        return { text: j.choices[0]?.message.content ?? "", outTokens: j.usage?.completion_tokens ?? 0 };
      }
      if (attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${model} ${res.status}: ${await res.text()}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(OUT_DIR, { recursive: true });
  const partial = join(OUT_DIR, `${stamp}.partial.jsonl`);
  const rows: { qid: string; type: string; arm: Arm; correct: boolean; outTokens: number }[] = [];
  let answerTokens = 0, answers = 0;
  for (const [qi, inst] of pool.entries()) {
    const turns = turnsOf(inst);
    const vecs = await embedCached(`${inst.question_id}-turns`, turns.map((t) => t.content));
    const [qVec] = await embedCached(`${inst.question_id}-q`, [inst.question]);
    const leaves: Leaf[] = turns.map((t, i) => ({ id: t.id, text: t.content, sessionId: t.sessionId, ts: t.ts, vec: vecs[i]! }));
    const tree = await buildTree(collapseIdentical(leaves).survivors, { summarize: async (items) => items.slice(0, 3).join(" | ").slice(0, 200) });
    const fts = makeFts(turns);
    const engine = new FractalRecallEngine({ tree, embed: async () => [qVec!], ftsSearch: (q, l) => fts.search(q, l) as never, leavesById: new Map(leaves.map((l) => [l.id, l])) });
    const ranked = await engine.rankedLeafIdsWithVec(inst.question, qVec!, "", POOL);
    fts.close();
    const byId = new Map(turns.map((t) => [t.id, t]));
    const evidence = turns.filter((t) => t.evidence).map((t) => t.id);
    for (const arm of ARMS) {
      const { ids, fullEvidence } = armIds(arm, ranked, evidence, inst.question_id);
      const block = memoryBlock(ids.map((id) => memoryLine(byId.get(id)!, fullEvidence && byId.get(id)!.evidence)));
      const a = await call(ANSWER_MODEL, answerPrompt(block, inst.question_date, inst.question), 512, ANSWER_PROVIDER);
      answerTokens += a.outTokens; answers++;
      // Cost guard from the GLM reasoning explosion (arc-canary memory): stop early instead of paying for it.
      if (answers === 30 && answerTokens / answers > 1500) throw new Error(`answers average ${Math.round(answerTokens / answers)} tokens: reasoning is not off, stopping`);
      const j = await call(JUDGE_MODEL, judgePrompt(inst.question_type, inst.question, inst.answer, a.text), 10);
      const row = { qid: inst.question_id, type: inst.question_type, arm, correct: j.text.toLowerCase().includes("yes"), outTokens: a.outTokens, answer: a.text, judge: j.text };
      rows.push(row);
      appendFileSync(partial, JSON.stringify(row) + "\n");
    }
    console.error(`[${qi + 1}/${pool.length}] ${inst.question_type} spend $${spend.toFixed(3)}`);
  }

  const byArm = (arm: Arm) => pool.map((i) => rows.find((r) => r.qid === i.question_id && r.arm === arm)!.correct);
  const fms = byArm("FMS"), pct = (x: number) => (100 * x).toFixed(1);
  const md = [
    `# Memory-order headroom result`, ``, `${pool.length} questions, answer ${ANSWER_MODEL}@${ANSWER_PROVIDER}, judge ${JUDGE_MODEL}, spend $${spend.toFixed(2)}.`, ``,
    `| arm | accuracy | vs FMS (95% CI) | wins / losses / ties |`, `|---|---|---|---|`,
    ...ARMS.map((arm) => { const b = byArm(arm), d = pairedDiff(fms, b); return `| ${arm} | ${pct(b.filter(Boolean).length / b.length)}% | ${arm === "FMS" ? "-" : `${pct(d.diff)} [${pct(d.lo)}, ${pct(d.hi)}]`} | ${arm === "FMS" ? "-" : `${d.wins} / ${d.losses} / ${d.ties}`} |`; }),
  ].join("\n");
  writeFileSync(join(OUT_DIR, `${stamp}-result.md`), md + "\n");
  console.log(md);
}
