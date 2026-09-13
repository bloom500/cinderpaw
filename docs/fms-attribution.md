# FMS attribution: the existing twelve queries

2026-09-12. Worktree `.worktrees/astra-fms-bench`, branch
`audit/astra-fms-bench`, based on `fix/exclude-libsignal-default` at
`487b86bbc661f4c38ad18f74808dd95f6b54d6b2`.

**Decision: repair the task/answerability contract, preserve replay evidence,
and label answer-equivalent evidence groups before increasing n. Multi-gold
alone is insufficient.** There is a demonstrated single-gold false negative,
genuine retrieval misses, and questions that cannot specify one correct
historical event. Exhaustive vector search does not recover the seven FMS
zeros. That rules out beam pruning as their sole cause in this replay; it does
not establish an embedding ceiling or justify buying a different model.

No new aggregate score, latency claim or SHIP verdict was calculated for this
diagnostic. The historical figures remain in `scripts/LAUNCHERS.md`. No query
was regenerated, added or removed; no production retrieval code was changed.

## What was recovered, and what was reconstructed

The original report and branch-8 tree survive in
`%USERPROFILE%/.cinderpaw/agent/`. The tree contains exactly IDs 1–2700. All
those IDs still have text in today's SQLite database. The diagnostic takes a
read-only snapshot of **only those rows**, in the historical `timestamp ASC`
order, and uses the tree's archived leaf vectors rather than today's vectors.
The live database and saved tree are not modified.

Filtering text length >=20 and sampling twelve with seed 1 reconstructs these
source IDs, in report order:

`1729, 21, 1470, 2647, 2613, 806, 1695, 1976, 1206, 2685, 1284, 1373`.

Each source was inspected against its query. This is a strongly corroborated
reconstruction, **not a saved historical gold file**. The old report stores
query text, recall and latency, but not source IDs, returned IDs, query
vectors, corpus hashes or runtime identity. The archived tree lacks leaf text.
There is therefore no byte-for-byte proof that all text is unchanged since
June, or that today's returned lists equal the unrecorded historical lists.
The table below distinguishes replay evidence from that historical limitation.

The archived vectors are 384-dimensional. Today's DB vectors are 1024-dimensional
and the installed model is bge-m3; using those would invalidate this replay.
The historical source (`a0fb2ba:src-tauri/src/paths.rs`) names
`CompendiumLabs/bge-small-en-v1.5-gguf/bge-small-en-v1.5-q8_0.gguf`.
That model was downloaded into the worktree and run on CPU with mean pooling,
matching the historical embedding setup. The llama.cpp executable is newer;
it is not claimed to be the original runtime.

Six calibration texts (IDs 1, 21, 806, 1206, 1470, 1976) produce cosine
similarities to their archived leaf vectors between 0.9999674 and approximately
1.0. These are calibration probes, not additional benchmark queries. The
original twelve query strings were embedded once and their vectors frozen.
Every candidate and FTS hit/miss agrees with the historical report, and a
second retrieval of each query gives exactly the same ordered IDs.

FTS is reconstructed in an in-memory SQLite FTS5 table over those same 2700
texts. Its tokenizer uses the historical AND-only prefix query, read from
`a0fb2ba:FeralAgent/src/memory/episodic.ts`. Today's AND-then-OR implementation
would change the baseline and the hybrid simultaneously, so it is deliberately
not substituted into the historical replay.

## Controlled interventions

1. **Implementation replacement:** replace beam traversal with exhaustive
   scoring of all 2700 archived leaf vectors. Hold query text/vector, corpus,
   semantic candidate count (20), FTS, merge boost (0.5), session exclusion
   (`""`), final cutoff (10) and gold fixed. All seven historical FMS failures
   remain zero. Exhaustive ranks below are positions of the source leaf, not
   claims about answer relevance. For ties, occurrence order matters.
2. **Verified evidence substitution, Q8:** replace the first returned item
   with source 1976 and retain the other nine. The inspected source contains
   the requested Product Hunt URL, `404: Not Found`, and a page body headed
   `500`; the original top ten contain search-failure snippets instead. The
   actual single-gold scorer changes from 0 to 1. This locates a recoverable
   evidence-selection boundary; it is not a claim that a model answered well.
3. **Identical-evidence substitution, Q9:** replace returned ID 1156 with
   labelled ID 1206. Both contain exactly `control_app: Found 1 element(s).`,
   and belong to the same session. The evidence text is unchanged; the actual
   score changes from 0 to 1 solely because the occurrence ID changed. This
   demonstrates the label defect directly, beyond inspection of similar text.
4. **Source-injection positive controls:** inserting the inspected source ID
   at the scored boundary makes each of the seven zeros pass the old scorer.
   For ambiguous/current-state queries this exposes what the scorer rewards;
   it does **not** establish that the injected historical evidence answers the
   question as worded.

The benchmark's measured path is `FractalRecallEngine.rankedLeafIdsWithVec`
followed by `recallAtK`. **There is no answer model or context-consumption stage.**
Running a new answering model would introduce a new experiment, not replay
this benchmark. Evidence substitution therefore occurs at the ranked-evidence
boundary the existing benchmark actually scores. No answer-generation recovery
is claimed. Recovery identifies a useful intervention point, not a unique root
cause; representation, ranking, duplication and query semantics interact.

## Per-failure findings

Numbers are positions in the original twelve-query report. “Retrieval miss”
and “invalid/underspecified memory task” are additional categories: the supplied
five categories did not include them. All seven source texts are in the
2700-row snapshot; missing source information is not their explanation under
the historical-memory interpretation.

| # / declared task | Source and inspected evidence | Category and controlled evidence |
|---|---|---|
| **1.** Q1 — historical recall: the project state and the plan that followed it | **1729** contains the revised project assessment and staged plan. Returned **1650** is earlier advice in the same session, before the repository assessment; **218** is generic capabilities. Most other hits are user questions. | **Retrieval miss / partial, superseded evidence**, plus missing temporal scope. Some returned text is related, but it does not replace the revised plan. Source rank **55** under exhaustive scoring; replacing traversal leaves zero. Source injection passes the scorer. Do not label the earlier advice fully correct just to remove this zero. This assesses recall of advice, not whether that advice's factual claims were true. |
| **2.** Q2 — identity/capability question about the assistant itself | **21** identifies Feral as a local AI and lists capabilities, although the stored message is truncated. The top ten are mainly greetings such as **224**, not identity/capability evidence. **218**, elsewhere in the corpus, is a substantially clearer alternative. | **Genuine retrieval miss**, with a query that does not identify a historical identity/version. Source rank **262**; exhaustive search still fails. Source injection passes. Alternative answers exist, but **they were not returned**: this is not evidence that the old label rejected a genuinely sufficient returned answer. |
| **3.** Q3 — current-state desktop question ("currently") | **1470** records seven windows from a particular June session. Returned **1460, 1283, 1218, …** are launch acknowledgements telling the caller to use `list_windows`; they do not enumerate open windows. | **Invalid temporal target + retrieval miss under a historical interpretation.** No query timestamp/session binds “currently” to 1470. Historical lists exist, but cannot certify the desktop state at query time. Source rank **39**; exhaustive search still fails. Injecting 1470 passes the scorer without making its snapshot current. |
| **6.** Q6 — liveness greeting, no memory needed | **806** is a past assistant greeting confirming it was present. Returned **491, 819, 804, …** are mostly other user questions of the same liveness-greeting shape. | **Invalid memory demand**, plus question-to-question retrieval instead of answer evidence. A liveness greeting needs no unique archived message; a past assistant greeting does not prove present liveness. Source rank **204**; exhaustive search still fails. Source injection passes an arbitrary occurrence test. Keep this as a no-memory-needed control, not as a demand to retrieve 806. |
| **8.** Q8 — historical recall: why one named public web page failed to load | **1976** records the exact URL and its 404/500 failure. Returned **1965** says web search found no instant answer for a ProductHunt query; the remaining hits are unrelated failed searches. | **Genuine evidence-ranking miss.** 1976 already reaches the semantic top 20 but ranks **13** under exhaustive scoring and misses final top 10. Exhaustive traversal gives the same top ten. Replacing one retrieved item with verified 1976 changes score 0→1. The source supports the observed HTTP/page failure, not a deeper server root cause. |
| **9.** Q9 — historical recall: what a tool call returned | **1206** is one occurrence of a tool-result line. Returned **1156, 1158, 1159, 1167, 1177, 1186, 1193, 1194, 1195, 1203** contain the **identical full text** as 1206. Fifteen occurrences exist in the corpus. | **Confirmed useful-evidence/single-gold false negative in replay.** Source is first omitted at exhaustive position **11** among equivalent evidence. Swapping only 1156→1206 preserves text and flips score 0→1. If a particular event identity matters, the query must identify it; the current wording does not. Exhaustive search cannot fix an arbitrary occurrence label. |
| **11.** Q11 — current-state desktop question ("right now") | **1284** records eight windows from an earlier session. The top ten are again launch acknowledgements, e.g. **1336, 1460, 1283**, not window inventories. | **Invalid temporal target + retrieval miss under a historical interpretation.** Same distinction as Q3. Source rank **107**; exhaustive search still fails. Source injection rewards an old snapshot without establishing “right now.” This query cannot be judged against one historical list without an explicit anchor. |

The original categories concerning **model misuse** and **fallback execution**
do not explain these results. There is no answering model in the measured
path. The replay invokes the named candidate directly, records 24 hybrid FTS
calls (two per query), zero embedding fallback calls, and identical repeats.
FTS inside the hybrid is intentional, not a fallback. The benchmark wrapper
instantiates `FractalRecallEngine` directly; it does not exercise an L4 registry
seam. Historical runtime execution was not traced, so the report alone cannot
prove which old binary ran; no evidence of a fallback causing its zeros was
recovered.

**Environment/corpus differences** would invalidate a naive present-day rerun:
the database is larger, the embedder changed, and FTS changed. These were
controlled here. They remain a limit on comparing the old capped and full runs:
their frozen gold sets and returned evidence were not preserved together. The
present investigation does not establish that any difference between those
runs was caused by corpus size, or that single-gold bias explains that gap.

## FTS failures, including the four without an FMS failure

To cover both engines, all eleven historical FTS zeros were also reproduced.
Each source lacks one or more tokens required by the historical AND query.
This is lexical matching behavior, not absence of source content. Example
missing prefix terms (quotes/asterisks omitted for readability):

| Query # | Query terms absent from its source | FMS evidence when FTS alone failed |
|---|---|---|
| 1 | 2 of its terms | See main table. |
| 2 | 3 of its terms | See main table. |
| 3 | 3 of its terms | See main table. |
| 4 | 4 of its terms | Source **2647**, the find-skills instructions, is returned by FMS. |
| 5 | 3 of its terms | Source **2613**, a voice-message test, is returned. The query still needs event context. |
| 6 | 3 of its terms | See main table. |
| 8 | 3 of its terms | See main table. |
| 9 | 4 of its terms | See main table. |
| 10 | 3 of its terms | Source **2685** is returned. It records an opinion the user stated, not an independently verified fact. |
| 11 | 4 of its terms | See main table. |
| 12 | 4 of its terms | Source **1373** is returned and exposes the malformed `get_tree</action>` action string. |

Q7 is the original non-failing FTS control. None of these records is a new
headline comparison with today's improved lexical baseline.

## What “fix the benchmark” means next

1. **Freeze the experiment before relabelling it.** Preserve the twelve texts,
   source IDs, timestamp/session scope, corpus text/vector hashes, model and
   runtime fingerprint, tree, ordered retrieval outputs and executed path.
   A seed is insufficient: it does not freeze the corpus or model paraphrases.
2. **Declare the task per query.** Distinguish historical recall, current-state
   tool requests, identity/configuration questions and no-memory-needed turns.
   Q3/Q11 need an explicit historical anchor or a live-tool expectation. Q6
   should test that needless memory is avoided. Keep all twelve records during
   this repair; mark applicability rather than quietly replacing hard cases.
3. **Hand-label answer-supporting evidence groups, with provenance.** Q9's
   equivalent texts belong together for its current answer-content question.
   Similar words, a user asking the same question, or superseded advice are not
   automatically relevant. Add partial/stale relevance where appropriate;
   retain event identity when the question actually asks for that event.
4. **Choose a metric matching those labels.** For “did I obtain sufficient
   evidence?”, use a hit on a valid answer-equivalence group (and coverage when
   several distinct facts are required), rather than recall over every duplicate
   occurrence. Merely making Q9 multi-gold gives ten of fifteen IDs at k=10:
   perfect answer evidence still cannot achieve full document recall. Keep
   exact-source retrieval as a separately named provenance diagnostic. Evaluate
   no-memory/live-tool expectations separately from document retrieval. Track
   irrelevant evidence and redundancy too: one correct hit should not hide
   nine distracting or duplicate passages. Retrieval scores still do not
   measure downstream answer correctness.
5. **Keep genuine failures visible.** Q8 demonstrates a ranking/cutoff problem;
   Q1/Q2 and the historical interpretations of Q3/Q11 remain retrieval problems.
   This pass does not isolate encoding, truncation, language, ranking and
   duplication from one another. It just shows that exhaustive traversal alone
   does not recover these cases. Do not infer “embedding ceiling” from that.

**A different corpus is not the first fix:** the historical source evidence is
present. Changing corpus or model now would discard the controlled comparison.
**A different metric and better-scoped labels are required**, alongside durable
run evidence. Increasing n comes after those corrections, not before them.

## Privacy

The twelve queries are real turns from a private conversation history and this
repository is public, so no query text, no memory text and no verbatim tool
output appears above. Each query is named `Q1`…`Q12` with its declared task,
which is all the analysis needs; source ids are stable across the redaction, so
every number here still lines up with the local artifacts.

The query→text mapping, the corpus and the ordered results live only in the
gitignored `data/fms-attribution/` on the machine that ran this. Nothing in
this directory is written by the benchmark: a live run writes its report to
`%USERPROFILE%/.cinderpaw/agent/fractal-bench-report.json`, outside the
repository, and that file does carry raw query text. Do not copy it in.

## Reproduction and local evidence

Run `bun scripts/fms-attribution.ts` from this worktree. The script snapshots
inputs only when absent and caches vectors; subsequent runs need no model
server. Its assertions check corpus/query sizes, reconstructed source IDs,
historical per-query outcomes for both engines, deterministic repeats and the
two evidence interventions. It does not call the aggregate benchmark runner.

First-run embed service used:

```text
llama-server.exe -m data/fms-attribution/bge-small-en-v1.5-q8_0.gguf
  --embedding --pooling mean -ngl 0 -c 8192 -b 2048 -ub 2048 -np 16
  --port 18087 --host 127.0.0.1
```

Runtime executable:
`%USERPROFILE%/.lmstudio/extensions/backends/llama.cpp-win-x86_64-avx2-2.16.0/llama-server.exe`.
Private corpus text and full ordered results stay in the worktree's gitignored
`data/fms-attribution/`: `corpus.json`, `tree.json`, `historical-report.json`,
`reconstructed-queries.json`, `vectors.json`, `evidence.json`, `replay.log`.
They are local reproducibility artifacts, not included in a clone. The source
script and this report are reviewable without publishing the full conversation
corpus. A clone needs the archived inputs to replay these particular cases.

SHA-256 receipts:

| Input | SHA-256 |
|---|---|
| Archived tree | `6e74542f911a18d66af46cf35a519ac23aff4bb497736c176c2e1683b69de662` |
| Historical report | `11e4f9d86460c946e3b203837d50da57ee46961a618e352b079a5a79c742e3a1` |
| Reconstructed corpus text/metadata | `6290535a3e4d26175b80ec2b1f7ea440795ca351496583a87afe02ff76801147` |
| Frozen query/calibration vectors | `e2ccaa837bfa198b57df5099d01f4905cbb1e1db161b9fe4e4fd47ace1e2df2a` |
| Downloaded bge-small model | `ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514` |
| Replay llama-server executable | `5614aef43e5e10eb8e749db43b992279c7c2ed45b939c215cfcbd3a35f14f103` |

## Verification

The diagnostic assertions pass. Focused existing runner, query-set, metric and
tree-query tests: **44 pass, zero fail**. Full `scripts/verify.sh` status is
recorded after worktree dependency setup; see the final verification note below.
