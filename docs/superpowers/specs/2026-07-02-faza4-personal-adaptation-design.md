# Faza 4 — Bounded Continual Personal Adaptation (L2 LoRA)

Data: 2026-07-02. Direcția dictată de Darius în sesiune (harta L-urilor).

**Propoziția fazei**: „Un runtime care poate construi, antrena, evalua,
promova și retrage adaptoare LoRA personale folosind același protocol BRSI
construit pentru evoluția configurației."

Schimbarea de esență: până acum FER învață *cum să folosească* modelul mai
bine (L1 config). Din Faza 4 învață *cum să adapteze* modelul la utilizator
— fără să atingă foundation model-ul și fără să piardă controlul.

## Pipeline

```
Foundation Model → Personal LoRA → Evaluation → Confidence → Human Review → Promotion
```

Human gate OBLIGATORIU la L2 (se relaxează abia la L5/L6). Rollback
obligatoriu. Fiecare LoRA are arbore genealogic complet (provenance).

## Slices (în ordinea dependențelor, nu a "pașilor")

### Slice 1 — LoRA substrate: registry + provenance + rollback
`FeralAgent/src/rsi/lora-registry.ts` — store JSON versionat (disciplina
journal: corupt → start gol), mirror al pattern-urilor `pending-patches.ts`
+ `champion.json`:
- `LoraAdapterRecord`: id, domain (general/coding/research/writing/…),
  adapterPath (GGUF), baseModel, status
  (`candidate|evaluating|champion|retired|rolled_back`), provenance
  (parentId, datasetId+hash, hyperparameters, metrics, createdAt).
- Champion PER DOMENIU (nu unul global). `promote(id)` demotează
  campionul vechi → `retired`; `rollback(domain)` → campionul curent
  `rolled_back`, părintele redevine campion. Genealogia = lanțul parentId.
- `TrainerBackend` — interfața pluggabilă (name, available(), train(job)).
  Slice 1 livrează DOAR interfața; backend-urile reale vin în Slice 4.

### Slice 2 — Dataset Builder v1
Minează sursele EXISTENTE, fără LLM în v1 (heuristici):
- conversații din DB-ul agentului → perechi instruction/response;
- istoricul de eval + journal (succes/eșec) → etichete de preferință.
Output: JSONL + hash (intră în provenance). Filtre de calitate minime
(dedup, lungime, redactare secrete — refolosește redactarea existentă).
Extracția LLM-asistată de preferințe = extensie în Dream Cycle, ulterior.

### Slice 3 — Eval gate + human gate (BRSI reuse)
Candidate LoRA → aceeași scară: Tier 0 floor + suita de eval cu adapterul
încărcat vs campionul curent → Confidence → card de review în UI (același
pattern ca patch-urile de cod: aprobare umană explicită) → Promotion.
NU se promovează pe loss ↓ — doar pe task suite + regression + confidence.

### Slice 4 — Trainer backend #1
FER doar orchestrează. Realitate hardware (Windows + RX 580): Unsloth=CUDA,
MLX=Mac → primul backend realist e `llama.cpp finetune` (CPU/slow, dar
local și universal) SAU export dataset + CLI extern. `available()` decide
la runtime; mașini fără trainer văd starea „training unavailable" explicată,
nu un crash. Încărcarea adapterului la inferență: llama.cpp suportă LoRA
GGUF — de verificat suprafața în `llama-cpp-2` la implementare.

### Slice 5 — Resource monitoring real + observability
`episodeBudgetCaps` placeholders (cpu/ram/disk/energy) devin MĂSURATE
(+ VRAM, training time). Dashboard: training jobs, datasets, acceptance
rate, champion LoRA, rollback count, average gain, token cost.

## Ce NU intră (L3/L4+)
Self-modifying TS/Rust dincolo de code-RSI existent, self-refactoring
kernel, arhitectură self-generated, tool creation, foundation training.

## Testare
Unit pe registry (promote/rollback/genealogie/corupt→gol) și dataset
builder (dedup, redactare). Live: un ciclu candidate→eval→review→champion
cu un adapter dummy înainte de primul training real.
