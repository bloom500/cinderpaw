# Watch Your Agents Die: The Lineage Panel

*Published: 2026-09-05 (D+10, tentative) · Author: Darius (Bloom Media) · Read time: 6 min*

---

## The screenshot everyone kept asking about

After [last week's post](002-species-agi-response.md) about Cinderpaw having genomes and generations, the most common question wasn't "does this actually work" or "prove it." It was: "can I see it?"

Yes. It shipped in v1.1 preview this week.

**[SCREENSHOT: Lineage panel showing 4 columns — Alive Genomes (with fitness scores in green), Cemetery (dead genomes greyed out with cause of death), Genealogy Tree (parent-child DAG), Diff View (what mutated between generation N and N+1)]**

This is the Lineage panel. It's a UI over the RSI subsystem that's been in Cinderpaw since v0.1. Nothing new architecturally — I just made the data visible.

## What you're looking at

**Alive column:** every genome currently instantiated. Each has a name (auto-generated, like "clever-hare-47"), a fitness score, a lineage depth (how many generations back to the founding genome), and a resource footprint.

**Cemetery column:** every dead genome. Cause of death is one of:
- `LOW_FITNESS` — dropped below the survival threshold for 3 consecutive evals
- `INVARIANT_VIOLATION` — did something forbidden by hard invariants (touched `~/.cinderpaw/`, made a network call to a denied domain, etc.)
- `TIMEOUT` — took longer than the budget for evals
- `SUPERSEDED` — a mutation of this genome scored better and inherited its slot
- `USER_KILLED` — you manually retired it

Each dead genome keeps its full config archived. You can revive it. You can diff it against current alive genomes. You can see exactly what mutated to create its children.

**Genealogy tree:** a DAG (directed acyclic graph) showing parent-child relationships. Click any node to see its config at that generation, its fitness trajectory, when it died (if it's dead), what descendants survived.

**Diff view:** when you select two genomes (usually a parent and its child), you get a side-by-side of what changed. System prompt tokens added/removed. Tool ordering changes. Budget adjustments. Memory access modifications.

## Why this matters more than the technology

The technology is not new. Evolutionary algorithms for hyperparameter optimization have existed since the 1990s. Google's AutoML uses similar mechanisms internally. Anthropic and OpenAI use variants for RLHF pipelines. What's new is that **it's visible to the user**.

At every frontier lab, this same process runs. Users never see it. They see the current alive model as if it appeared fully-formed. They don't see the ancestors. They don't see the mutations. They don't see the fitness function.

Cinderpaw shows it. Not because I'm trying to educate anyone. Because I built it for myself and I wanted to see it. Turned out other people want to see it too.

## A real example from my own machine

Yesterday I noticed that my main coding agent had lower fitness than usual on a Rust refactoring task. Opened the Lineage panel. Saw that the alive generation had inherited a mutation two generations back that reduced the token budget for tool call sequences.

Diff view showed exactly the change: `max_tool_chain: 12 → 8`. The mutation had helped on shorter tasks (faster completion, higher score) but was starving longer refactors.

I killed that generation manually. Revived the ancestor from before that mutation. Restarted evolution with `max_tool_chain: 12` locked. Two generations later, the new descendants had better fitness on both short AND long tasks — the mutation-with-lock approach caught a trade-off that unconstrained evolution had missed.

**This took me 15 minutes.** At Anthropic, if you noticed Claude was worse at long tasks, you'd file a bug and wait 4-8 weeks for a model update. There's no ancestor to revert to. There's no diff you can inspect. You just get a new number version.

## What the panel doesn't show

I want to be honest about limits.

**You don't see the base model's evolution.** If you're using Claude Sonnet 4.6 via BYOK, whatever Anthropic did to shape that model is baked in. Cinderpaw evolves the AGENT (system prompt, tools, memory access, budgets), not the model. The base model is a fixed dependency.

**You don't see other users' genomes.** In v1.0, Cinderpaw is single-user. In v1.2 (February 2027), shared projects let you and one other person collaborate. But your genomes stay yours. If you WANT to share a successful genome — export it, send it to a friend — that's a manual export/import. There's no automatic gene pool.

**You don't see the fitness function itself in the UI.** It's in the Rust source. That was deliberate — the trust boundary requires it to be code, not user-editable in a text field. If you want to change what "better" means, you fork Cinderpaw or write a custom scorer plugin (docs coming).

## Death is a feature

Sometimes people ask: doesn't it feel weird to kill your agents? Like, ethically?

Honest answer: no, and here's why.

An agent in Cinderpaw is a configuration. It's not a subject. It has no persistent identity beyond the config. When I kill a genome, no continuous experience ends because there was no continuous experience. The word "death" is technically accurate but the emotional weight it carries doesn't apply.

I use "death" and "cemetery" because they're the right technical words for what happens (removal from the alive set, archival) and because sanitizing the vocabulary would be dishonest. Anthropic's alignment reports use words like "deprecation" and "model retirement" which mean the same thing but sound less like what's happening. I'd rather use the accurate word.

If you want to argue the ethics of evolutionary algorithms in agent design, the argument is legitimate — but it's about the mechanism, not the vocabulary. The mechanism runs whether or not I call it "death". Might as well be honest about it.

## Try it

The Lineage panel is in v1.1 preview. If you're on v1.0, update via Settings → About → Check for updates.

If you don't have Cinderpaw yet: [cinderpaw.dev](https://cinderpaw.dev). Windows, macOS, Linux. Free.

Post screenshots of your own lineages. I'm collecting good ones for the docs. Tag `#CinderpawLineage` on X or drop them in the Discord.

---

**Related:**
- [They Said AI Is Doing This In Secret. We're Doing It In The Open.](002-species-agi-response.md)
- [ADR-0006: Append-only provenance graph](../adr/0006-append-only-provenance-graph.md)
- [ADR-0008: Evolution runtime as DAG](../adr/0008-evolution-runtime-as-dag.md)
- [ADR-0019: Biological vocabulary](../adr/0019-biological-vocabulary.md)
