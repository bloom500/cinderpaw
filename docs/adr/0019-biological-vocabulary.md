# ADR-0019: Biological vocabulary in evolution runtime

**Status:** Proposed (target v1.1 November 2026)
**Date:** 2026-08-22
**Related:** ADR-0001 (RSI), ADR-0004 (Evolution event schema), ADR-0006 (Provenance graph), ADR-0008 (Evolution runtime as DAG), STRATEGY-PIVOT.md

## Context

Cinderpaw's evolution runtime (RSI subsystem) has been documented since ADR-0001 with generic tech vocabulary: `RSI`, `continual learning`, `hyperparameter search`, `iteration`, `agent config`, `provenance graph`, `fitness function`.

Two events converged in August 2026 that make renaming worthwhile:

1. **Species | Documenting AGI video** (2026-08-15, 179k+ views in 6 days) framed frontier AI as biological evolution: birth, death, generations, selection pressure. The video's framing is now anchored in AI discourse.

2. **User feedback (Darius, 2026-08-22, verbatim):**
> „Avem un runtime de agenți bazat pe genomi, literalmente agenți vechi care mor ca să updateze următoarea generație de agenți, e literalmente ce zicea ăla în video, doar că pe AI Agents nu pe modele AI."

The realization: Cinderpaw already implements exactly the mechanism the video describes as horrifying-when-hidden. The technical vocabulary we use hides this. Renaming to biological vocabulary aligns UX with what actually happens AND with the emerging public discourse.

## Decision

Full rename tech vocabulary → biological vocabulary across UI, docs, marketing, and internal terminology.

### Vocabulary mapping

| Old (tech) | New (bio) | Rationale |
|---|---|---|
| RSI panel | **Evolution** panel | Directly evocative of Species AGI framing |
| Agent config | **Genome** | Technically accurate — it's the heritable spec |
| Iteration | **Generation** | Standard evolutionary term |
| Hyperparameter search | **Selection cycle** | What it actually is |
| Fitness function | **Fitness function** (unchanged) | Universally understood |
| Agent instance | **Individual** or **agent** | „Individual" for the population-level context |
| Killing an underperformer | **Death** | Blunt, honest, technically accurate |
| Spawning new candidate | **Birth** | Symmetric with death |
| Config perturbation | **Mutation** | Standard genetic algorithm term |
| Two-parent inheritance | **Crossover** | Standard GA term |
| Provenance graph | **Lineage** | More accessible, evokes family tree |
| Dead genome archive | **Cemetery** | Honest, memorable, memeable |
| Fitness scorer | **Selection pressure** (in docs), **Fitness scorer** (in code) | Different audiences |
| Config lineage | **Genealogy** | Consistent bio metaphor |
| Trust boundary Rust scorer | **Immutable selection law** (marketing) / **Fitness scorer** (technical) | |

### Scope of rename

**UI (frontend-react):**
- Settings > RSI → Settings > Evolution
- MemoryLayersPage / RSI status panels → Evolution / Lineage panels
- All in-app strings referencing „iteration" → „generation"
- All in-app strings referencing „agent config" → „genome" (when in evolution context; regular chat context stays „agent")
- New UI: **Lineage panel** with 4 columns (Alive Genomes, Cemetery, Genealogy Tree, Diff View) — see UI-FIXES-CINDERPAW.md Section H

**Docs (public):**
- README.md — RSI section renamed to Evolution
- All ADRs from 0019 onwards use bio vocabulary primarily, tech secondarily in parens
- Old ADRs (0001-0018) get a header note „terminology updated per ADR-0019 in v1.1"
- Blog posts consistently use bio vocabulary

**Code (internal):**
- File names stay (rsi/, evolution/) — code renames are churn without value
- Rust struct names stay (`FitnessScorer`, `PersistedEngineState`) — internal
- User-facing strings via i18n keys renamed
- Comment/docstrings gradually updated (not breaking change)

**Marketing (external):**
- All blog posts from 002 onwards use bio vocabulary
- Landing page copy updated
- Twitter/X threads use bio vocabulary consistently
- CHANGELOG.md uses bio vocabulary for evolution-related changes

### What we don't rename

- **Base LLM models** stay as models. Cinderpaw's evolution is on AGENTS, not on underlying LLMs. Confusing these damages the accuracy claim.
- **Skills / Extensions** stay as skills. They're user-installable, not evolutionarily derived.
- **Memory** stays as memory. Bio metaphor („instincts"? „knowledge"?) doesn't add clarity.
- **Tools** stay as tools. Ditto.
- **Rust code** at the file/function level. Internal churn without user benefit.

## Consequences

### Positive

- **Discoverability boost:** users who watched Species AGI video will immediately recognize the terminology and understand Cinderpaw's mechanism
- **Honest UX:** the vocabulary matches the mechanism instead of hiding it behind sanitized tech jargon
- **Meme potential:** „my agent died today" is a shareable phrase. „my hyperparameter iteration failed" is not.
- **YC narrative alignment:** aligns with STRATEGY-PIVOT.md „evolution AI companies won't show you" positioning
- **Educational side effect:** users learn evolutionary algorithms terminology by using Cinderpaw. Broader AI literacy.

### Negative

- **One-time UX churn:** existing users have to relearn some panel names
- **Some words feel edgy:** „death", „cemetery" are stronger than „retirement", „archive". Some users might find this off-putting. Mitigation: it's technically accurate. Sanitizing would be dishonest.
- **Marketing lock-in:** once we go bio, going back to tech vocabulary later would look like a retreat. Commit fully.
- **Doc migration cost:** 15+ existing docs need updating. Estimated 4-6h.

### Risks explicitly accepted

- **„Isn't calling it death insensitive?"** — no, it's the accurate technical term. Anthropic uses „deprecation" which is a euphemism. We prefer accuracy. Discussed in blog 003.
- **„You're just doing marketing spin"** — the mechanism was documented in ADR-0001 through ADR-0008 well before this rename. The mechanism doesn't change. Only the labels.
- **„This scares users"** — good. If evolution is happening in the AI you use, you should know. Fear-of-the-mechanism is misplaced; the mechanism is neutral. Fear-of-hidden-mechanism is the correct fear.

## Rollout plan

### v1.1 (November 2026) — soft rollout

- New Lineage panel ships with bio vocabulary from day one
- Existing RSI panel gets a rename to „Evolution" in header, with tooltip: „Previously called RSI"
- README + ADRs updated in same release
- Migration note in CHANGELOG

### v1.2 (February 2027) — full commitment

- All lingering „RSI" references in UI removed
- Legacy tooltips removed
- Docs cleaned up
- Marketing has been consistent since blog 002 (Aug 2026)

### Beyond

- If bio vocabulary meets resistance in first 3 months post-v1.1, revisit. Data > speculation.
- If it goes well, extend metaphor: „ecosystem" for multi-agent teams, „species" for genome families, etc. Only if warranted.

## Open questions

1. **Do we localize?** In Romanian, „moarte" and „cimitir" are similarly stark. In German, „Tod" and „Friedhof". Some cultures may find this too dark. Recommendation: keep English vocabulary, translate carefully with cultural adaptation for launch localization.

2. **Do we add „conservation" as a concept?** Some genomes shouldn't die even if fitness dips (e.g., „safety-critical genome, never retire"). Naming: „conservation status: protected"? Overkill for v1.1.

3. **Do individual dead genomes get memorials?** Some users might want a „memorial page" for a genome that served them well. Cute idea, probably distracting. Defer.

## References

- STRATEGY-PIVOT.md — canonical framing including „Poziționare împotriva frontier AI"
- ADR-0001 through ADR-0008 — original mechanism specs
- docs/blog/002-species-agi-response.md — public introduction of vocabulary
- docs/blog/003-lineage-panel-launch.md — public introduction of Lineage panel
- Species | Documenting AGI video (2026-08-15): https://www.youtube.com/watch?v=9XlOaVItUgI
