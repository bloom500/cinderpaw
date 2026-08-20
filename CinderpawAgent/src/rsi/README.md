# rsi/ layer map

R2 (2026-07): subdivided by BRSI layer. Root holds only the cross-layer
orchestrators (`sidecar.ts`, `engine.ts`, `mod.ts`) — everything else lives
under its layer directory. Pure mechanical move (R2 of
`docs/2026-07-09-v1-architecture-hardening-spec.md`); zero logic edits to
any moved file.

- `infra/` — journal, event-bus, hash-chain, instance-paths, provenance,
  envelope-store, budget, rsi-cost, resource-monitor, adapters, bridge,
  the eval-spec cluster (eval-spec, eval-worker, get-specs,
  default-tier-specs, tier-loader, run-eval, invoke-agent), the contract
  FSM (contract, contract-deps, contract-leaves, contract-runner,
  contract-stages), and confidence. Contract-* and confidence live here
  (not l3-code/) because the contract FSM is consumed across layers — by
  L1 promotion (`l1-config/ratchet-handler.ts`), L3 code-RSI
  (`l3-code/code-rsi.ts`), and L4 modules (`l4-modules/module-lifecycle.ts`,
  `l4-modules/module-eval.ts`) — per the spec's explicit ambiguity rule.
- `l1-config/` — genome, mutation, fitness, selection-handler,
  population-manager, population-snapshot, crossover, crossover-selection,
  champion, champion-tree, taste, taste-miner, strategy-seeds,
  birth-policy, extinction-handler, escape-time, escape-time-recorder,
  recalcitrance, dream-config, dream-cycle, dream-scheduler,
  dream-telemetry, pbt-controller, pbt-handler, fractal, goal-mode,
  ratchet-handler, activity-monitor, episode-options, passive-supervisor
  (the last three follow dream-cycle.ts, their only consumer).
- `l2-adapt/` — lora-eval-gate, lora-eval-runner, lora-pipeline,
  lora-registry, dataset-builder, personal-fitness, trainers/cli-trainer.
- `l3-code/` — code-genome, code-genome-io, code-leaves, code-proposer,
  code-rsi, code-sandbox, pending-patches.
- `l4-modules/` — module-eval, module-host, module-host-client,
  module-lifecycle, module-registry, module-wall, seam-adapter,
  seam-catalog, seam-runtime.
- `l5-gov/` — governance, governance-audit, governance-lifecycle.
- `l6-meta/` — meta-evolution.

RSI = Recursive Self-Improvement. Full glossary: `docs/ARCHITECTURE.md`.
