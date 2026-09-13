# Durable mandate: autonomy as continuous responsibility

Competence plan §3.4 (`2026-09-13-competence-and-receipts-plan.md`), Astra
text 3 §5. A spec, not a build: nothing here is scheduled before the first
Cinderpaw release, and §6 says what must exist before it starts.

## 0. What already exists, measured 14 Sep 2026

The plan's sketch assumed a new `Mandate` object in `cowork/types.ts`. The
repo already has most of one, in `core/run-store.ts`:

| Astra's field | `RunRow` today | gap |
|---|---|---|
| result (objective) | `mission`, `doneWhen: DoneWhen \| null` | none |
| budget | `continuationBudget` (turns), `deadlineAt` (wall) | no USD, no token cap per run |
| access | none | the whole gap |
| limits | none | the whole gap |
| expiry | `deadlineAt` | expiry != deadline: a deadline ends the work, an expiry ends the *right* to work |
| receipts (audit) | `report`, `stoppedBecause`, `resumes` | one report, not a receipt chain |
| resume after interruption | the boot pass in `boot.ts` ("runs whose process never came back") | exists |
| verifier's word | `concludeRun(..., verified)` (§3.3) | exists, feeds the utility ledger |

Approvals exist for cowork agents only (`cowork/approval.ts`: five classes,
`send | publish | delete | purchase | prod_change`, fail-closed after 5 min).
The egress wall exists and is on the L3 denylist. Cowork v1 ticks only on
agents that exist (`cowork/runtime.ts`, fresh-install: zero agents, no work).

So the mandate is **a run with declared access and limits that outlives the
conversation**, not a new runtime.

## 1. The object

Add to `RunRow` (migration adds nullable columns; every row before this
version is a mandate with no declared access, i.e. exactly today's run):

```ts
mandate: {
  /** USD the run may spend, all models and tools; null = the profile's cap. */
  budgetUsd: number | null;
  /** Approval classes pre-granted for this run, from cowork's five. */
  access: ApprovalClass[];
  /** Egress hosts the run may reach unattended; the wall reads this list. */
  hosts: string[];
  /** Things the run must not do, in words the person wrote; shown to the
   *  model in the system prompt and to the person on the card. Not enforced
   *  by code: enforcement is `access` and `hosts`; this is the contract. */
  limits: string[];
  /** After this instant the run may not act; it may only report. */
  expiresAt: number | null;
  /** Receipt ids written by this run, in order (the audit). */
  receipts: string[];
} | null;
```

`null` mandate = today's run. There is no separate "mandate store".

## 2. Behaviour

1. **Pre-granted approvals.** `cowork/approval.ts` `classifyToolCall` runs
   as today; if the class is in `mandate.access`, the approval is written as
   `approved` with `resolvedAt = createdAt` and a note `"pre-granted by
   mandate <runId>"`. Anything outside asks once; the answer is stored on the
   approval row as today and ALSO appended to `mandate.access` when approved,
   so the same class is not asked twice in one mandate. Denied stays denied
   for the run.
2. **Egress.** `mandate.hosts` is a new caller of the existing wall, never a
   change to it. A host outside the list is a refusal with the reason on the
   card; the run does not stop, it asks (one approval of a new class,
   `egress`, sixth in `APPROVAL_CLASSES`, with the parity test updated).
3. **Expiry.** `expiresAt` passed: the loop concludes the run with
   `stoppedBecause: "expired"` (new `RunStopReason`) and the report says what
   was and was not done. An expired run is never resumed by the boot pass.
4. **Method invalid.** When the run's `doneWhen` fails twice in a row after
   a step the run believed had succeeded, the run opens a question in Dreams
   (`QuestionStore`, exists) and pauses instead of retrying blind. The
   question carries the two failing receipts. Not a new mechanism: §2.4's
   `need_method` failure class already exists on the receipt.
5. **Receipts.** Every tool call that changes the world outside the machine
   (an approval class fired, or an egress write) appends a receipt id to
   `mandate.receipts`. The receipt is the §2.1 shape; the writer is the
   runner, not the model.
6. **The card.** One card per run with a non-null mandate in the React run
   view: objective, spend so far / `budgetUsd`, expiry, last receipt (human
   line), "Stop". Stop = `concludeRun(..., "user_stopped")`, exists.

## 3. Fresh install

No mandate exists until a person writes one. Writing one requires: a model
configured, `doneWhen` set, and at least one `access` class or `hosts` entry
chosen explicitly. The form defaults to empty access and empty hosts, i.e.
"ask me for everything", which is today's behaviour. There is no default
budget other than the profile cap that already exists.

## 4. Not in this spec

- Cowork agents as mandates. v1 reactive cowork stays as is; an agent is not
  a run. Revisit when a cowork agent has a `doneWhen`.
- Any change to the egress wall's rules.
- Skills running unattended (§3.1): a mandate may call a learned procedure
  like any tool; nothing special.

## 5. Tests

- A run with `access: ["send"]` sends without a pending approval; the
  approval row exists, `approved`, note says pre-granted.
- A run with `access: []` behaves byte for byte as today (paired test over the
  existing approval tests).
- A row from before the migration reads back with `mandate: null`.
- `expiresAt` in the past: the boot pass skips the row and the report says so.
- Two consecutive `doneWhen` failures open one question and no third attempt.

## 6. Preconditions

Do not start before: the first Cinderpaw release is tagged; the utility
ledger (§3.3) has closed at least one real run (proves `concludeRun`'s
`verified` reaches the ledger on a user machine); and the connectors are
finished, because `hosts` is meaningless before there is something to reach.
