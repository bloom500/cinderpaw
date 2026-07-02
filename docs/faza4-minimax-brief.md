# Brief MiniMax — Faza 4 Slice 4 (leaf: TrainerBackend CLI extern)

Context: contractul `TrainerBackend` e DEJA fixat și comis în
`FeralAgent/src/rsi/lora-registry.ts`. Tu implementezi UN backend concret
care shell-uie un trainer extern. Nu atingi registry-ul, eval-gate-ul sau
încărcarea adapterului în inferență (ale mele). Leaf pur, contract fix.

## Ce livrezi
`FeralAgent/src/rsi/trainers/cli-trainer.ts` — o clasă `CliTrainer` care
`implements TrainerBackend` (importă tipul din `../lora-registry.ts`):

```ts
export interface TrainerBackend {
  name: string;
  available(): Promise<boolean>;
  train(job: {
    baseModel: string;
    datasetPath: string;
    hyperparameters: Record<string, unknown>;
    outputDir: string;
  }): Promise<{ adapterPath: string; metrics: Record<string, number> }>;
}
```

### Contract exact
1. `name` = `"cli-trainer"`.
2. Constructor primește config injectabil (pentru test): `{ binPath?: string;
   exec?: ExecFn }`. `binPath` default din env `FERAL_LORA_TRAINER_BIN`.
   Refolosește `ExecFn` din `./code-sandbox.ts` (NU rescrie exec — e deja
   acolo, cu `bunExec` ca default; vezi cum îl folosește `pending-patches.ts`).
3. `available()`: `true` DOAR dacă `binPath` e setat ȘI binarul răspunde la
   `--version` cu exit 0 (timeout 5s). Orice altceva → `false`, ZERO throw
   (mașini fără trainer văd „unavailable", nu crash — disciplina Faza 4).
4. `train(job)`:
   - construiește comanda: `<bin> finetune --base <baseModel> --data
     <datasetPath> --out <outputDir> ` + flag-uri din `hyperparameters`
     (mapează fiecare cheie la `--<kebab-key> <value>`; boolean true → doar
     `--<key>`, false → omite);
   - rulează cu timeout generos (env `FERAL_LORA_TRAIN_TIMEOUT_MS`, default
     3_600_000 = 1h — training e lent pe CPU);
   - exit ≠ 0 → THROW cu prima linie din stderr (training e infra; un adapter
     prost e treaba eval-gate-ului, dar un CLI care crapă e eroare reală);
   - la succes: `adapterPath = join(outputDir, "adapter.gguf")`; parsează
     metricile din stdout dacă trainer-ul emite linii `metric:<name>=<float>`
     (regex simplu), altfel `metrics = {}`.

### Teste (`FeralAgent/tests/rsi-cli-trainer.test.ts`)
Injectează un `exec` fake (vezi pattern-ul din `rsi-pending-patches.test.ts`:
`exec` mockuit care returnează `{exitCode, stdout, stderr}`). Acoperă:
- `available()` false când binPath lipsește / `--version` dă exit ≠ 0 / exec
  aruncă (prinde intern → false);
- `available()` true pe `--version` exit 0;
- `train()` construiește comanda corect (assert pe args capturate: base/data/
  out + un flag numeric `--rank 16`, un boolean `--use-flash` din
  `{useFlash:true}`, și că `{useFlash:false}` NU apare);
- `train()` throw pe exit ≠ 0 cu mesajul din stderr;
- `train()` parsează `metric:loss=0.42` din stdout în `metrics.loss`;
- `train()` returnează `adapterPath` sub `outputDir`.
NU rula un trainer real. Totul prin exec fake.

## Reguli
- Ponytail: fără abstracții speculative. O clasă, un fișier de test.
  Refolosește `ExecFn`/`bunExec` existente — nu scrie un exec nou.
- Path-uri cu `join` din `node:path`, nu concatenare de string-uri.
- ⚠️ Verifică pe disc (ls/Read) că `code-sandbox.ts` exportă `ExecFn` +
  `bunExec` ÎNAINTE de a importa — nu presupune forma.
- `bunx tsc --noEmit` curat + `bun test tests/rsi-cli-trainer.test.ts` verde
  înainte de a raporta. NU comite — las eu review + commit.

## Ce NU atingi (ale mele)
- Rust: încărcarea adapterului GGUF în llama-cpp-2 la inferență.
- Wiring-ul train→registry.add→eval-gate→human card.
- `lora-registry.ts`, `lora-eval-gate.ts`, `dataset-builder.ts` (comise, fixe).
