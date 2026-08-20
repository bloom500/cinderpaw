# ADR-0014: Brain Stack — parity cu multi-provider model routing (Arena-style)

**Status:** Proposed
**Date:** 2026-08-20
**Related:** ADR-0010 (microkernel), audit findings §157-§159 din runda 6 (BrainStack bugs)

## Context

Cinderpaw (fost Feral) are deja un Brain Stack basic — 4 fișiere în `FeralAgent/src/brain/`:
- `capability-registry.ts` (183 linii) — models catalog cu 5 capabilities (reasoning/coding/vision/speed/multilingual)
- `task-classifier.ts` (171 linii) — heuristic regex clasifică prompt în 7 categorii (coding/vision/reasoning/creative/simple/offline/multilingual)
- `brain-stack.ts` (376 linii) — orchestrator: classify → filter healthy → score → primary + fallback
- `brain-config.ts` (179 linii) — loads `~/.cinderpaw/brain.json`, opt-in via `CINDERPAW_BRAIN=1`

Comportamentul curent:
1. La fiecare user turn, `route(input)` clasifică prompt-ul heuristic.
2. Score per model: `Σ requirement[cap] · capabilities[cap] − modeWeight · cost + budgetLocalBonus`.
3. Primary = top scorer. Fallback = top scorer cu provider diferit.
4. Fallback fires doar la execution error (circuit breaker), NU la runtime signals (latency, quality).
5. Zero learning — capabilities scores sunt hardcoded în JSON, nu se ajustează per user usage.

User feedback (2026-08-20): vrea "Brain Stack ca cel de pe Arena.ai — sistem de modele interschimbabile automat". Adică:
- Routing per turn bazat pe **conținutul prompt-ului**, nu doar 7 categorii heuristic.
- Fallback la un alt provider când primul are rate-limit / latency spike / stream-cut mid-response.
- User trust signal — thumb-up pe răspuns → boost la weights modelul care l-a produs pentru contextul respectiv.
- Cost accounting per model per session — user vede "$0.02 spent pe GPT-4o today".
- Optional: A/B racing între 2 modele pe același turn când latency budget permite.

Arena Brain Stack (unde rulează Cursor Composer / Arena Agent Mode / etc.) e un intermediary layer care:
- Menține un pool live de providers cu credit disponibil.
- Are un router LLM-driven care alege model per turn bazat pe embedding-ul prompt-ului (nu regex).
- Track-uiește per-turn: latency real, tokens generated/s, user feedback, cost.
- Rulează silent A/B în background pentru calibrare continua.
- Când un provider dă 429/timeout, request-ul rerouted transparent la alt provider fără să pierdă streaming context.

## Decision

Extindem Brain Stack curent cu **5 upgrade-uri incrementale**, fiecare shippable independent. Nu rewrite — evoluție.

### U1 — Prompt classifier LLM-driven cu embedding cache

Heuristic regex (`task-classifier.ts`) e fragile — "explain quantum entanglement" clasifică `coding` prin match `\bwhy\b`? Nu chiar, dar edge cases similare există (§F60 seria).

Nou: `SemanticClassifier` — folosește embedding model (deja avem, dedicat pentru FMS) să compute similarity între prompt și un set de exemplare per category:

```ts
// FeralAgent/src/brain/semantic-classifier.ts (nou)
export class SemanticClassifier {
  #anchors: Record<Category, Float32Array[]>;  // pre-computed embeddings ale exemplarelor
  
  async classify(prompt: string): Promise<Classification> {
    const embed = await getEmbedding(prompt);
    const scores = new Map<Category, number>();
    for (const [cat, anchors] of Object.entries(this.#anchors)) {
      scores.set(cat, Math.max(...anchors.map(a => cosine(embed, a))));
    }
    const [cat, score] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    return { category: cat, confidence: score };
  }
}
```

Anchors seed inițial hardcoded (5-10 exemplare per category), dar user poate adăuga:
```
CINDERPAW_BRAIN_ANCHORS=~/.cinderpaw/brain-anchors.json
```

Semantic classifier ca **layer 2 peste heuristic**. Heuristic still runs (cheap, sync). Dacă heuristic e confident (regex match direct), use it. Altfel escalate la semantic. Zero regressiune, doar upgrade la edge cases.

### U2 — Runtime signals feeding score

Curent scorer e static — nu vede latency, error rate, user feedback. Adăugăm `RuntimeStats` per model per user:

```ts
// FeralAgent/src/brain/runtime-stats.ts (nou)
export interface RuntimeStats {
  modelId: string;
  // Rolling window last N turns (default 100):
  latencyP50Ms: number;
  latencyP95Ms: number;
  tokensPerSecMedian: number;
  errorRatePct: number;         // 4xx/5xx în ultimele N calls
  thumbUpRate: number;          // 0..1
  costUsdRolling: number;
  lastCallAt: number;
}

export class RuntimeStatsStore {
  // Persistat în SQLite `model_runtime_stats` table (nouă migration).
  record(modelId: string, event: TurnEvent): void { ... }
  get(modelId: string): RuntimeStats { ... }
}
```

Scorer nou (extensie non-breaking):
```ts
export function scoreModelV2(
  model: BrainModel, requirement, mode,
  runtime: RuntimeStats | null,
  confidence = 0.5,
): number {
  let s = scoreModel(model, requirement, mode, confidence);  // V1 base
  if (runtime === null) return s;
  // Penalize slow/broken models, reward well-received ones.
  s -= 0.5 * clamp01(runtime.latencyP95Ms / 10_000);   // 10s p95 = -0.5
  s -= 2.0 * runtime.errorRatePct / 100;                // 5% errors = -0.1
  s += 1.0 * runtime.thumbUpRate;                        // 100% thumbs = +1
  return s;
}
```

Weights (0.5 / 2.0 / 1.0) devin editable via `brain.json`:
```json
{
  "runtimeWeights": {
    "latencyPenaltyMax": 0.5,
    "errorPenaltyPerPct": 2.0,
    "thumbBonusMax": 1.0
  }
}
```

Ratchet natural: model care primește constant thumb-down pentru coding tasks va cădea sub scoring pentru alte cloud models pentru category coding, iar system-ul îl folosește mai puțin.

### U3 — Fallback la runtime error mid-stream

Curent fallback fires doar la initial call error (circuit breaker open). Dar Arena Brain Stack re-routes MID-STREAM dacă provider cade după 30 tokens.

Refactor `InferenceRouter.completeWith(target)` să accepte optional `fallbackChain: ModelTarget[]`:

```ts
async completeStreamWithFallback(
  targets: ModelTarget[],
  messages: ChatMessage[],
  onToken: (tok: string) => void,
): Promise<InferenceResponse> {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      let receivedAny = false;
      const wrapped = (tok: string) => { receivedAny = true; onToken(tok); };
      return await this.completeWith(target, messages, wrapped);
    } catch (err) {
      const isRecoverable = err instanceof RateLimit || err instanceof NetworkError;
      const canFallback = i < targets.length - 1;
      if (!isRecoverable || !canFallback) throw err;
      // Log: fallback triggered.
      if (receivedAny) {
        // Mid-stream cut. Emit un separator la UI + inject "[continuing with X]".
        onToken(`\n\n_[continuing with ${targets[i+1].model}]_\n\n`);
      }
      continue;
    }
  }
  throw new Error("all fallbacks exhausted");
}
```

Trade-off: mid-stream fallback poate produce output disjunct (modelul 2 nu are context la ce a spus modelul 1). Mitigation: prepend la conversation history un fake message `assistant: <ce a apucat model 1 să spună>` înainte de retry cu model 2. Model 2 continuă natural.

### U4 — Cost accounting per session

Deja avem `completion_cost` table în SQLite (per audit — `db.ts:380+`). Extindem cu view UI:

```tsx
// frontend-react/src/components/settings/BrainStackTab.tsx (nou)
export function BrainStackTab() {
  // Vezi rolling 30d cost per model, thumbs-up rate, avg latency.
  // Sliders pentru mode weight (budget/balanced/quality) + preview
  // ce model ar fi ales pentru ultimele 10 turns.
}
```

Include per-model badge în chat header: user vede `gpt-4o · $0.023 this session`.

Un opt-in "budget alert" — dacă user setează `maxSessionUsd = 1.00`, Brain Stack downgrades automat la modele mai ieftine când 80% e consumed.

### U5 — Silent A/B racing (optional, feature flag)

Când latency budget generous (user tolerates 5s+ pentru response), Brain Stack poate rula 2 modele în paralel, arată răspunsul primului care termină, dar loghează scoruri comparate:

```ts
if (mode === 'quality' && bothProvidersHealthy) {
  const race = await Promise.race([
    provider1.stream(msgs).then(r => ({ from: 'p1', ...r })),
    provider2.stream(msgs).then(r => ({ from: 'p2', ...r })),
  ]);
  // Show race winner to user.
  // Log both response transcripts for future training data (A/B eval).
  await recordABPair(race);
}
```

Cost 2×. Doar în mode `quality`, doar cu explicit opt-in `brain.json: { "enableAB": true }`.

Value: peste 100 A/B pairs se acumulează golden dataset pentru user preference — feeds direct în U2 (thumb-up rate calibrated per model per user).

## Consequences

**Positive:**
- Routing per turn devine adaptativ, nu static.
- User percepe app-ul ca "smart" — modelul potrivit apare fără config manual.
- Fallback mid-stream = fewer "connection lost" errors visible.
- Cost transparency = trust building.

**Negative:**
- Semantic classifier costs 1 embedding call per turn (~10ms local, 100ms cloud). Cached după prima query per session.
- RuntimeStats requires new SQLite table + migration.
- Mid-stream fallback complexity → mai multe edge cases pentru testing.
- A/B racing dublă cost fără value garantată — feature flag off default.

**Migration path:**
- U1: additive, zero breaking. Ship v0.3.
- U2: additive, new SQLite table + migration. Ship v0.4.
- U3: refactor router internal, backwards compat prin single-target overload. Ship v0.5.
- U4: pure UI addition. Ship v0.4 alongside U2.
- U5: feature-flagged, opt-in. Ship v0.5+.

**Audit findings closed:**
- §157 (capabilities unclamped) — validate în U2 RuntimeStats path.
- §158 (silent config errors) — U4 UI arată brain config issues explicit.
- §159 (override unavailable silent) — U4 UI badge când fallback fires.

## References

- Existing: `FeralAgent/src/brain/*.ts`
- Related PRs: n/a yet
- External: Arena.ai Brain Stack (proprietary, not published)
