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

## Robustness — 8 architectural concerns beyond U1-U5

Post first-write review. Nu ship fără să adresezi acestea, altfel Brain Stack e bling fără fundație.

### R1 — Circuit breaker integration explicit (not implicit)

Există deja `CircuitBreaker` în `FeralAgent/src/egress/circuit-breaker.ts` folosit de `ToolRegistry` (audit runda 8 §198). Brain Stack acum îl consumă indirect via `isHealthy(id)` callback (`brain-stack.ts:129`), dar nu-i wire dedicated per-provider.

Fix: introduce `ProviderBreaker` cu semantics separate de tool breaker:
- Threshold per provider: 5 consecutive 5xx sau 3 consecutive timeouts >30s.
- HALF_OPEN probe = single-shot minimal completion ("say hi") pentru verify recovery, NU un real user turn.
- User vede în UI status per provider: green/yellow (half-open probing)/red (open).

Interaction cu score:
```ts
scoreModelV2(model, requirement, mode, runtime, confidence) {
  if (breaker.stateOf(model.providerId) === 'open') return -Infinity;
  // ... rest of scoring
}
```

Modele cu breaker open sunt excluded din pool înainte de scoring, nu penalize după.

### R2 — Cold start bootstrap (opt-in telemetry global)

Un user nou n-are `runtime_stats` — U2 scoring returnează valori neutrale, RUX bad pentru primele 50 turns.

Soluție: **anonymized global stats** — opt-in la boot ("Help improve Cinderpaw's routing by sharing anonymous latency/error stats for models you use"). Aggregate global fed într-un manifest hosted la `cinderpaw.ai/api/model-baseline.json`:

```json
{
  "generated_at": "2027-XX-XX",
  "models": {
    "gpt-4o": {
      "medianLatencyMs": 850,
      "p95LatencyMs": 2400,
      "errorRatePct": 0.3,
      "sampleCount": 45000,
      "categoryFitness": {
        "coding": 0.87,
        "creative": 0.72,
        ...
      }
    },
    ...
  }
}
```

New user boot fetch-uiește manifest, folosește-l ca prior până build own runtime_stats. După ~100 turns per model, own stats override baseline.

Privacy: **doar aggregated metrics anonime**, zero prompt content, zero user identifiers. `opt-in default OFF` (privacy-first stance consistent cu app).

### R3 — Model deprecation + version pinning

`gpt-4o` s-a schimbat model behavior între release-uri (`gpt-4o-2024-05-13` vs `gpt-4o-2024-08-06`). User's `brain.json` cu `"model": "gpt-4o"` = moving target — subtile behavior shifts breaks user's expectations.

Fix: **auto-pin la boot**, cu explicit versioned identifiers stored în runtime state:
```json
{
  "id": "openai-gpt4o",
  "target": {
    "model": "gpt-4o",              // user-facing alias
    "modelPinned": "gpt-4o-2024-08-06",  // auto-pinned first use
    "pinnedAt": "2027-01-15T10:00:00Z"
  }
}
```

Când OpenAI publish `gpt-4o-2024-11-01`, notifier:
- Detect nou version via HEAD request la `api.openai.com/v1/models`.
- Emit `feral://brain-model-drift` event.
- UI arată banner: "gpt-4o has a newer version available. Test upgrade?"
- User confirms → automated eval on Tier-0 prompt suite → dacă pass, update `modelPinned`.

Pin durabil = reproducible routing decisions. Zero silent behavioral drift.

### R4 — Session stickiness for prompt caching

Anthropic + OpenAI oferă prompt caching — trimite același prompt prefix de 2 ori → al 2-lea request e 90% mai cheap și 3× faster.

Brain Stack decisions per-turn ignore this. Dacă turn 1 → gpt-4o, turn 2 → claude-3.5 (score marginal higher), turn 3 → gpt-4o din nou. Cache-uri niciodată nu se warm-up.

Fix: **session stickiness policy**:
```ts
route(input, sessionContext) {
  const previousModelId = sessionContext.lastModelId;
  const scored = scoreAll(candidates, requirement, mode, runtime);
  const top = scored[0];
  
  if (previousModelId && previousModelId !== top.id) {
    const previous = scored.find(s => s.id === previousModelId);
    const stickinessBonus = 0.15;   // 15% bonus for keeping same session model
    if (previous && previous.score + stickinessBonus >= top.score) {
      return previous;   // stick with previous unless clearly worse
    }
  }
  return top;
}
```

Break stickiness explicit când:
- User classification schimbă radical (coding session → vision session).
- Previous model returns error.
- User explicit switch model via `FeralModelSelector`.

Impact real: user avantaje $$$ automat, fără să conștientizeze cache logic.

### R5 — Observability / explainability trace

User întreabă "de ce a răspuns Claude, credeam că am setat gpt-4o?" — currently zero visibility.

Fix: emit trace pentru fiecare routing decision:
```ts
export interface RoutingTrace {
  turnId: string;
  timestamp: number;
  classification: { category, confidence, method: 'heuristic' | 'semantic' };
  candidates: Array<{
    id: string;
    score: number;
    breakdown: { capability, cost, latency, errorRate, thumbUp, stickiness };
    excluded?: 'breaker_open' | 'unconfigured' | 'unavailable_override';
  }>;
  primaryChosen: string;
  fallbackChain: string[];
  reason: string;   // human-readable "chose Claude 3.5 because: highest coding score + stickiness"
}
```

Store în SQLite `brain_traces` (ring buffer last 500 turns). UI: settings tab "Routing traces" arată timeline cu why-decisions.

Debugging blocker fix — support user reports "routing e ciudat" cu trace attached.

### R6 — Budget circuit breaker (proactive downgrade)

Currently `max_total_cost_usd` în SandboxBounds e reactive — throws când exceeded. Better: **proactive downgrade**.

Config:
```json
{
  "budget": {
    "sessionMaxUsd": 1.00,
    "downgradeAt": 0.80,
    "downgradeTarget": "cheap-alternative-tier"
  }
}
```

La 80% budget, Brain Stack shifts mode automatic `balanced` → `budget`, force `LOCAL_BONUS` boost, warns user în UI. La 100% hard stop cu explicit user override needed.

Aliniat cu existing SandboxBounds enforcement (rusty half of trust boundary, ADR-0007).

### R7 — Canary rollout pattern pentru providers noi

User adaugă new BYOK provider (say Cohere). Currently: full routing eligible immediate. Dacă Cohere are 20% error rate, user pierde 20% turns.

Fix: **canary period**:
- New providers get `canary_percent = 5` din turns per category.
- After 100 turns, calibrate error rate + user thumb-up.
- Auto-graduate la full eligibility dacă metrics comparable cu incumbents.
- Auto-quarantine dacă error rate > 10% or thumb-down > 30%.

UI shows canary badge on provider: "in trial — routing 5% traffic here for calibration".

Trust builder — user vede că system prudent cu tools noi.

### R8 — Prompt-caching-aware fallback (interaction cu R4)

R4 introduces stickiness. R3 U3 introduces mid-stream fallback. Interaction: dacă turn 5 sticky la Claude, mid-stream Claude errors, fallback la gpt-4o — **prompt cache pierdut**, next turn user pays full price.

Fix: fallback **prefer aceeași family** dacă available. Claude 3.5 → Claude 3 haiku (same provider, cache-poate-fi-hit-partially) înainte de → gpt-4o (new provider, cold cache).

Fallback chain construction:
```ts
buildFallbackChain(primary: BrainModel, candidates): BrainModel[] {
  const sameProvider = candidates.filter(c => c.providerId === primary.providerId && c.id !== primary.id);
  const differentProvider = candidates.filter(c => c.providerId !== primary.providerId);
  // Same-provider first (cache preservation), then cross-provider (real fallback)
  return [...sameProvider.slice(0, 1), ...differentProvider.slice(0, 2)];
}
```

### R9 — Interaction cu Bounded RSI

Brain Stack decisions produce metrics (latency, thumb rates, cost) care sunt EXACT genul de signals pe care Bounded RSI îl folosește pentru evolution. Currently disconnected.

Fix: emit `BrainStackDecision` events pe existing EventBus:
```ts
bus.emit({
  type: 'BrainStackDecision',
  turnId,
  chosenModel: primary.id,
  scoreBreakdown: trace.candidates[0].breakdown,
  eventualOutcome: {
    thumbUp: userFeedback,
    tokensGenerated, latencyMs, cost,
  },
});
```

RSI's `personal-fitness.ts` consumă acest event, updates fitness gradient. Ratchet advance = **routing weights themselves become part of evolved genome**.

Concret: routing weight-uri (capability multipliers) inițial hardcoded devin **evolved parameters** peste sessions. User's Cinderpaw over 3 luni învață că pentru coding tasks HIS style, Claude beats GPT în 62% of cases → weight-uri shift silent.

Aceasta e integrarea MOAT — Brain Stack devine parte din RSI substrate, nu doar consumer de config file.

## Migration order (revised)

- **v0.3**: U1 semantic classifier + R1 breaker integration + R5 observability trace
- **v0.4**: U2 runtime stats + R2 cold start manifest + R6 budget circuit breaker  
- **v0.5**: U3 mid-stream fallback + R8 cache-aware chain + R4 stickiness
- **v0.6**: U4 cost UI + R3 model pinning + R7 canary rollout
- **v0.7+**: U5 A/B racing (opt-in) + R9 RSI integration (major)

## References

- Existing: `FeralAgent/src/brain/*.ts`, `FeralAgent/src/egress/circuit-breaker.ts`
- Related PRs: n/a yet
- Related ADRs: ADR-0007 (trust boundary), ADR-0010 (microkernel)
- External: Arena.ai Brain Stack (proprietary, not published)
