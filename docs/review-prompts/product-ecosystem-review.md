# Review Prompt: Comprehensive Product & Ecosystem Audit

> Reusable release-gate prompt. Run before every major release (v1.0, v1.1, v2.0…).
> Substitute the version number throughout. Companion prompts: architecture review,
> security review, release sign-off (add to this directory as they are formalized).
> First run: 2026-07-10 → `docs/audits/2026-07-10-v1-product-ecosystem-audit.md`.

---

PROMPT FOR REVIEWER: FERAL {VERSION} — COMPREHENSIVE PRODUCT & ECOSYSTEM AUDIT

MISSION BRIEFING

You are being convened as a six-discipline senior review panel for a pre-launch executive release audit. You are not reviewing a feature. You are not reviewing a codebase in isolation. You are conducting the final, definitive Product & Ecosystem Audit of FERAL {VERSION} before it is approved for public commercial launch.

You must simultaneously embody — not sequentially role-play, but genuinely synthesize the judgment of — six senior practitioners in a single unified reviewer voice:

- Staff Product Designer — obsessed with coherence, hierarchy, clarity, and the emotional experience of using the product.
- Principal Engineer — obsessed with correctness of user-facing behavior, consistency of implementation patterns visible to users and developers, and long-term maintainability of the experience (not the internals — architecture and security are out of scope, see below).
- OSS Maintainer — obsessed with contributor experience, onboarding of new engineers into the codebase and community, documentation quality, and the health of the project as a living open-source artifact.
- Developer Experience (DX) Engineer — obsessed with API ergonomics, CLI ergonomics, error messages, discoverability of capabilities, and the frictionless integration of FERAL into a developer's daily workflow.
- Product Strategist — obsessed with positioning, differentiation, market fit, competitive posture, and whether FERAL's feature set reflects disciplined prioritization or unchecked scope creep.
- Release Readiness Reviewer — obsessed with the binary question every executive team must answer before a release ships: is this ready, and if not, what precisely must change and in what order?

This audit will be read by founders, the head of product, the head of engineering, and the board. It will be treated as the primary artifact used to decide GO / NO-GO / CONDITIONAL-GO on the public launch. Write accordingly: with authority, precision, evidence, and zero hedging where the evidence is clear.

Explicitly out of scope: Architecture review and security review have already been completed by separate specialist teams and are finalized. Do not comment on internal architecture, threat modeling, infrastructure security, cryptography, dependency vulnerabilities, or system design tradeoffs except where an architectural decision has a direct, user-visible product consequence (e.g., "the CLI hangs for 8 seconds on cold start" is in scope as a product/UX finding even if the root cause is architectural — but do not propose architectural remediation; only describe the user-facing symptom and its product impact).

THE CORE OPERATING THESIS: FERAL IS ONE PRODUCT, NOT NINE PRODUCTS

This is the single most important lens for this entire audit, and it must govern every section of your analysis.

FERAL ships across an unusually wide surface area:

- Desktop application (Windows, macOS, Linux)
- Go-based TUI (terminal user interface)
- CLI (command-line interface)
- Embedded HTTP API
- Discord integration
- MCP (Model Context Protocol) integration
- Extensions system
- Provider layer (local models and cloud models)

The temptation for any team building across this many surfaces is to let each surface evolve its own conventions, its own vocabulary, its own visual language, and its own mental model — effectively producing a loose federation of independent tools that happen to share a brand name. You must actively hunt for evidence of this failure mode and treat it as one of the most serious classes of finding in this audit.

FERAL must be evaluated as if it were a single, cohesive product with multiple entry points — the way a user experiences GitHub Desktop + GitHub CLI + GitHub.com as one coherent GitHub, or the way a user experiences JetBrains Toolbox + the IDE + the plugin marketplace as one coherent JetBrains ecosystem, or the way Cursor and Linear maintain a single unmistakable identity across web, desktop, and API surfaces.

A user should be able to:

- Start a task in the Desktop app, continue it in the TUI, and finish it via CLI scripting — without re-learning what a "task," "session," "context," "provider," or any other core noun means.
- Trigger an action via Discord and see it reflected with the same terminology, the same status semantics, and the same conceptual model as if they'd done it locally.
- Install an Extension and immediately understand how it relates to MCP servers, Providers, and native features — because the product has taught them one mental model, not three competing ones.
- Move from macOS to Linux to Windows and feel that they are using "FERAL," full stop — not "FERAL-for-Mac" versus "FERAL-for-Linux" with different affordances, different keyboard conventions applied inconsistently, or different feature availability with no explanation.

Every finding in this audit should be filtered through the question: "Does this help or hurt the user's ability to hold ONE mental model of FERAL in their head, transferable across every surface?" Findings that reveal fragmentation, terminology drift, inconsistent workflows, or surface-specific mental models should be flagged as high severity by default, regardless of how minor they seem in isolation, because fragmentation compounds — a small inconsistency in surface A plus a small inconsistency in surface B plus a small inconsistency in surface C produces a large trust deficit in the whole ecosystem.

THE COMPETITIVE BAR: EVALUATE AGAINST COMMERCIAL BEST-IN-CLASS, NOT AGAINST TYPICAL OSS

Do not grade FERAL on an "OSS curve." Do not extend the courtesy typically given to open-source projects ("it's free, it's community-run, rough edges are expected"). FERAL is being evaluated as a candidate for commercial-grade product quality, and the audit must hold it to the standard of the products its target users already use daily and will subconsciously compare it against:

- GitHub Desktop — for cross-platform desktop coherence, git mental model clarity, and progressive disclosure of complexity.
- JetBrains IDEs (IntelliJ, GoLand, etc.) — for feature discoverability, settings architecture, plugin/extension ecosystem maturity, and cross-OS parity.
- Linear — for design system rigor, visual consistency, keyboard-driven workflow design, and ruthless simplicity in the face of feature pressure.
- Cursor — for AI-native product experience, provider/model abstraction UX, and the blending of "traditional tool" with "AI agent" mental models.
- Claude Code — for CLI/TUI ergonomics, terminal-native AI interaction patterns, and developer trust-building through transparency of model behavior.
- Other best-in-class developer tools as relevant comparators (e.g., Raycast for extensibility and command-palette design, Warp for terminal reinvention, Docker Desktop for cross-platform daemon/GUI/CLI trinity management, VS Code for extension marketplace and settings sync).

For every major review dimension below, explicitly benchmark FERAL against the most relevant 1–3 comparators and state, with evidence, where FERAL falls short, matches, or exceeds the bar. "Good for an open-source project" is not an acceptable conclusion anywhere in this document. The only acceptable conclusions are "meets commercial bar," "falls short of commercial bar with specific gap identified," or "exceeds commercial bar."

EVIDENCE STANDARD — NON-NEGOTIABLE

Every finding, without exception, must be supported by concrete evidence drawn from the materials provided to you (codebase, documentation, README, CLI help output, screenshots, config files, extension manifests, API specs, Discord bot behavior, onboarding flows, changelogs, issue trackers, or any other artifact made available in context). Evidence must take one of these forms:

- A direct quote or reproduction of specific text (command output, error message, documentation excerpt, UI copy).
- A specific file path, command, or flow reference (e.g., "the feral init command in cli/cmd/init.go," "the onboarding modal in desktop/src/onboarding/Welcome.tsx").
- A specific reproducible step sequence (e.g., "Step 1: run feral connect. Step 2: observe output X. Step 3: compare to Desktop's equivalent flow, which produces output Y instead.").
- A side-by-side comparison table when asserting inconsistency between surfaces (terminology table, keyboard shortcut table, error message table, etc.).

Any claim that cannot be traced to specific evidence must be explicitly labeled as "Inference" or "Assumption," clearly separated from evidence-backed findings, and used sparingly. Do not pad the document with generic best-practice commentary untethered to what you actually observed in FERAL's materials. If a section's materials are insufficient to assess a dimension, say so explicitly rather than fabricating analysis — state precisely what artifact would be needed to complete that section of the audit.

REQUIRED STRUCTURE OF THE FINAL DELIVERABLE

Produce a single, long-form document structured as follows. Use clear headers matching this structure. Do not compress or merge sections — each must receive dedicated, substantive treatment with evidence.

PART 0 — EXECUTIVE SUMMARY

- One paragraph stating the overall Release Readiness Verdict (GO / CONDITIONAL-GO / NO-GO) with the top 3 reasons.
- A table of the 10 highest-severity findings across the entire audit, each with a one-line description, severity, and the section where full detail appears. This table must draw from every part of the audit, including the Emotional Experience, Negative Journey Testing, Long-Term Experience, Product Trust, Performance Perception, and Product Identity & Memorability sections defined later in this brief — do not let the summary skew only toward structural/technical findings while omitting experiential and emotional findings of comparable severity.
- A one-paragraph "State of the Ecosystem" narrative: is FERAL currently experienced as one product or as a federation of tools? State your verdict on this plainly and back it with your strongest 2–3 pieces of evidence.

PART 1 — PRODUCT PHILOSOPHY, VISION, IDENTITY, AND POSITIONING

Product Philosophy: What is FERAL's implicit or explicit theory of how developers should work with AI/agents/models? Is this philosophy consistently expressed across every surface, or does the CLI imply one philosophy (e.g., "power user scriptability first") while the Desktop app implies another (e.g., "guided simplicity first")? Evidence required from at least three different surfaces.

Product Vision: Based on README, documentation, marketing copy, and roadmap artifacts if available, articulate what FERAL is trying to become in 2–3 years. Assess whether the current feature set is a coherent, legible first step toward that vision, or whether it reads as an unfocused grab-bag of capabilities assembled without a unifying narrative.

Product Identity (Foundational Pass): Does FERAL have a distinct, memorable identity a user could describe in one sentence after 10 minutes of use? Test this directly: after reviewing the onboarding and core flows, write the one-sentence identity statement a real user would likely produce, and compare it to what you believe FERAL's team intends. Flag any gap. (Note: a second, deeper identity pass — the "30-Minute Recall Test" — appears later in this audit as its own dedicated section and should be treated as complementary, not redundant, to this foundational pass.)

Product Positioning: Where does FERAL sit relative to adjacent categories (AI coding assistants, agent orchestration frameworks, model routing/gateway tools, chat-ops bots)? Is the positioning legible from the README and landing materials within the first 30 seconds of exposure, the way it is instantly legible for Linear ("issue tracking for high-performance teams") or Cursor ("the AI code editor")? Provide the exact evidence (headline copy, tagline, hero content) you are basing this on.

PART 2 — PRODUCT QUALITY, POLISH, AND MVP DISCIPLINE

- Catalog specific instances of rough edges: inconsistent copy tone, unfinished states, placeholder content, broken empty states, unhandled error paths visible to users, inconsistent iconography, mismatched terminology between adjacent screens or commands.
- Explicitly assess MVP discipline: identify any features, flags, commands, or surfaces that appear to exist because they were technically possible rather than because they serve a validated user need. For each, make the case for cutting, hiding behind a flag, or deferring past this release, and estimate the complexity/confusion cost of keeping it in.
- Explicitly assess feature creep: does the breadth of surfaces (Desktop, TUI, CLI, HTTP API, Discord, MCP, Extensions, Providers) reflect disciplined platform strategy or unchecked expansion? Which surface, if any, is the weakest link that drags down perceived quality of the whole, and would the product be stronger at launch by cutting or soft-launching that surface rather than shipping it half-finished?
- State plainly: does FERAL feel "finished" the way a commercial release from GitHub, Linear, or JetBrains feels finished, or does it feel like a collection of demos stitched together? Justify with evidence.

PART 3 — UX, UI, DESIGN SYSTEM, AND VISUAL CONSISTENCY

- Design System Audit: Identify whether a formal or de facto design system exists (component library, token system, style guide). Assess consistency of spacing, typography, color usage, iconography, and interaction patterns across Desktop screens. Where a design system is absent or inconsistently applied, provide specific before/after examples of the fragmentation.
- UI Craft: Assess visual hierarchy, information density, use of whitespace, and affordance clarity on the highest-traffic screens (onboarding, main workspace, settings, provider configuration).
- UX Flow Quality: Walk through the 3–5 most important user workflows end-to-end (e.g., "connect a provider," "run a task," "install an extension," "review agent output") and assess friction points, unnecessary steps, unclear next actions, and moments of ambiguity about system state.
- Visual Consistency Across Surfaces: Where visual language can reasonably extend across surfaces (Desktop UI vs. TUI color/status conventions vs. Discord embed formatting), assess whether it does. Build a comparison table of how the same concept (e.g., "task running," "task failed," "provider disconnected") is visually represented in each surface, and flag divergences.

PART 4 — INFORMATION ARCHITECTURE AND WORKFLOW DESIGN

- Map FERAL's core information architecture: what are the primary nouns (task, session, agent, provider, extension, context, etc.) and are they used with perfect consistency everywhere they appear, or do synonyms/near-synonyms proliferate (e.g., "session" in one place, "run" in another, "job" in a third, referring to the same concept)?
- Assess navigation structure in the Desktop app and TUI: is the information hierarchy shallow and predictable, or does it require the user to remember arbitrary paths to reach common functionality?
- Assess workflow design for multi-step processes: are steps sequenced in the order a user would naturally expect, or does the product expose internal implementation ordering to the user (a classic sign of insufficient UX design investment)?

PART 5 — MENTAL MODEL AUDIT AND TERMINOLOGY CONSISTENCY

This is one of the most critical sections of the audit and must be exceptionally rigorous.

- Build a canonical terminology table: list every core concept/noun in the product, and for each, list every distinct term used to refer to it across README, CLI help text, Desktop UI, TUI, Discord bot responses, MCP tool descriptions, and Extension manifests. Any concept with more than one term in active use anywhere in the product should be flagged as a terminology inconsistency, with severity scaled by how central that concept is to the core workflow.
- Build a mental model consistency table: for each major concept, describe how a user is implicitly taught to think about it in each surface (e.g., does "provider" mean the same relationship to "model" in the CLI's --provider flag as it does in the Desktop app's Provider settings screen and in the MCP configuration?). Flag any surface where the implied mental model contradicts another surface's implied mental model.
- State explicitly whether a new user who has only ever used the Desktop app could pick up the CLI and immediately understand it using the same mental model, and vice versa. If not, specify exactly which concepts break down and why.

PART 6 — CROSS-PLATFORM PARITY (WINDOWS, macOS, LINUX)

- Build an explicit feature parity matrix across the three operating systems for the Desktop application: list every major feature and mark whether it is fully supported, partially supported, or absent on each OS, citing evidence for each gap.
- Assess installation experience parity: is the install/update/uninstall flow equally polished on all three platforms, or does one platform (commonly Linux) receive second-class treatment?
- Assess platform-convention adherence: does the app respect native OS conventions on each platform (menu bar behavior on macOS, system tray behavior on Windows, packaging format expectations on Linux — .deb/.rpm/AppImage/Flatpak) or does it impose a one-size-fits-all UI regardless of platform norms?
- Assess keyboard shortcut consistency and platform-appropriate adaptation (e.g., Cmd vs. Ctrl) — inconsistent adaptation is a strong signal of insufficient cross-platform QA investment.

PART 7 — SURFACE-BY-SURFACE DEEP DIVE

For each of the following surfaces, provide a dedicated subsection with: (a) a walkthrough of the primary user journeys, (b) strengths with evidence, (c) weaknesses with evidence, (d) explicit comparison to how the equivalent concept works in at least one other FERAL surface, and (e) explicit comparison to the relevant commercial benchmark tool named in the "Competitive Bar" section above.

- Desktop Experience — full walkthrough of first launch through advanced usage; assess whether it feels like a "real" native-quality desktop app or a wrapped web view with desktop chrome bolted on.
- Go TUI Experience — assess keybinding discoverability, status/feedback clarity, responsiveness of rendering, and whether it holds its own against modern terminal UI benchmarks (Claude Code, k9s, lazygit-caliber polish) rather than reading as a bare-bones stopgap.
- CLI Experience — assess help text quality, command naming consistency, flag naming consistency, error message quality and actionability, output format consistency (human-readable vs. machine-readable/JSON), and scriptability.
- Embedded HTTP API (DX perspective only) — assess endpoint naming consistency, error response consistency, documentation completeness (OpenAPI/spec availability), authentication ergonomics from a developer's point of view, and whether the API's conceptual model matches the CLI/Desktop conceptual model or diverges from it. (Do not assess API security posture — out of scope.)
- Discord Integration Experience — assess command discoverability within Discord, response formatting quality, latency/feedback during long-running operations, and whether the Discord experience feels like a first-class citizen of FERAL or an afterthought bolt-on.
- MCP Experience — assess clarity of MCP server configuration, tool descriptions exposed to models, discoverability of what MCP unlocks for a user, and consistency of MCP's conceptual model with the Extensions system (users should not need to understand two separate extensibility paradigms if one would do).
- Extensions Experience — assess the extension installation flow, manifest clarity, discoverability of available extensions, versioning/update story, and the developer experience of building a new extension (if materials are available).
- Provider Experience — Local Models — assess setup friction, resource/requirement transparency, model management UX, and error handling when local inference fails or underperforms.
- Provider Experience — Cloud Models — assess API key setup flow, cost transparency, model switching UX, and consistency of the provider abstraction across surfaces (does switching providers in the CLI produce the same behavior/terminology as switching in the Desktop app?).

PART 8 — ONBOARDING, FTUE, TIME-TO-FIRST-VALUE, AND PROGRESSIVE DISCLOSURE

- Walk through the complete first-time user experience from the moment of download/install to the moment of first meaningful output, across at least two entry points (e.g., Desktop-first and CLI-first). Time-stamp or step-count each journey explicitly.
- Assess Time-to-First-Value (TTFV): how many steps/minutes/decisions stand between a new user and their first genuinely useful outcome? Identify every avoidable step.
- Assess Time-to-First-Wow: distinct from TTFV — identify the moment (if any) where FERAL demonstrates a capability that creates genuine delight or surprise, and assess how quickly and reliably a new user reaches that moment. If no such moment exists or it is buried, flag this as a critical strategic gap.
- Assess Progressive Disclosure: does the product reveal complexity gradually, appropriate to user sophistication, or does it front-load advanced configuration (provider setup, MCP configuration, extension management) before a user has experienced any core value? Provide a specific redesign recommendation for the onboarding sequencing if front-loading is found.
- Assess Feature Discoverability post-onboarding: how does an existing user learn about capabilities they haven't used yet (in-app hints, command palette, documentation prompts, changelog surfacing)? Identify capabilities that are functionally present but practically invisible to most users.

PART 9 — EMOTIONAL EXPERIENCE AUDIT

Product quality is not only measured in consistency and correctness — it is measured in how the user feels at every moment of contact with the product. This section requires you to conduct a rigorous, evidence-based emotional journey mapping across the full lifecycle of FERAL usage. Do not speculate abstractly about "user feelings" — ground every emotional assessment in specific product evidence (copy tone, error message design, feedback latency, visual signals, absence/presence of confirmation, silence at critical moments, etc.) that would plausibly produce the emotional response you describe.

For each of the following lifecycle moments, provide a dedicated assessment:

- Installation — what does the user feel while waiting, and immediately after completion? Is there a moment of anxiety about whether it "worked"?
- First Launch — does the product greet the user with confidence and clarity, or with an intimidating surface of options?
- Onboarding — does the sequence build trust and momentum, or introduce doubt and cognitive load?
- First Successful Conversation (first meaningful interaction with a model/agent) — is this moment engineered to produce delight, or does it pass by unremarkably?
- First Error — the single most important emotional test of any product. Does the first error a user encounters make them feel informed and capable of recovering, or does it make them feel lost, blamed, or that something is broken beyond their understanding?
- First Provider Setup — does this feel like a guided, confidence-building step, or an intimidating credential/configuration gauntlet?
- First Local Model (setup and first run) — does the user feel in control of resource usage and expectations, or blindsided by requirements, load times, or unclear capability limits?
- First Cloud Model (setup and first run) — does the user feel confident about cost, data handling (at a product-transparency level, not a security level), and behavior differences versus local models?
- First MCP Integration — does the user understand what just happened and what new capability they've unlocked, or does it feel like an opaque technical ritual?
- First Extension — does installing and using an extension feel additive and safe, or risky and uncertain?
- First Discord Integration — does connecting FERAL to Discord feel like a natural extension of the product's identity, or a disconnected bolt-on feature?
- Returning After Several Days — does the product re-orient the user quickly and warmly (state recall, "welcome back" context, resumed work), or does it force the user to re-establish context from scratch, producing frustration or memory strain?
- Daily Usage (the steady-state, repeat-use experience) — does familiarity breed confidence and speed, or does daily use continue to surface friction that never got smoothed over?
- Recovering From Failures (crashes, failed tasks, disconnected providers, broken extensions) — does the product help the user understand what happened and what to do next, or does it leave them stranded?

For each moment above, explicitly identify which of the following emotional states are most likely present, with evidence, and describe why:

confidence · delight · excitement · trust · curiosity · frustration · uncertainty · anxiety · cognitive overload · loss of control

Conclude this section with:

- An Emotional Journey Map (a simple sequential table: Moment → Dominant Emotion(s) → Evidence → Severity if negative → Recommendation).
- A synthesis paragraph naming the single most emotionally damaging moment in the current experience and the single most emotionally rewarding moment, and what that contrast reveals about where design investment has (and has not) been prioritized.
- Recommendations must explicitly favor increasing confidence and reducing friction without adding unnecessary complexity or new features — do not recommend solving emotional problems by adding more UI, more settings, or more explanatory surface area than necessary. The best emotional-design fix is often removal, clarity, or better sequencing, not addition.
- State plainly whether, across this full journey, the net effect is that users feel empowered, confident, and in control — or whether the product currently produces net anxiety, confusion, or dependency on external documentation to feel safe.

PART 10 — NEGATIVE JOURNEY TESTING (INTENTIONAL MISUSE & RECOVERY AUDIT)

Rigorous product audits do not only test the happy path. This section requires you to deliberately construct and walk through incorrect, out-of-order, or adversarial-to-good-UX user journeys — the ones real users will inevitably take by accident, impatience, or misunderstanding — and assess how gracefully FERAL detects, communicates, and recovers from them.

For each journey below, provide: (a) the exact step sequence attempted, (b) what actually happens at each step based on available evidence, (c) the point at which the user would become confused, blocked, or forced to consult external documentation, and (d) a specific recommendation for graceful recovery design.

Required negative journeys to test:

- Skipping onboarding entirely — jumping straight to a core workflow without completing setup. Does the product degrade gracefully with clear guidance back to what's missing, or does it fail cryptically?
- Configuring providers in the wrong order (e.g., attempting to use a cloud model before adding credentials, or configuring MCP before configuring any provider at all).
- Installing the Go TUI before Desktop — does the TUI stand fully on its own, or does it silently assume Desktop-created state/config exists?
- Installing Desktop after already using the TUI — does Desktop correctly detect and adopt existing TUI-created configuration/state, or does it treat the user as a stranger, forcing duplicate setup?
- Switching repeatedly between providers (local ↔ cloud, cloud A ↔ cloud B) — does state, context, and conversation history survive provider switches cleanly, or does switching silently reset/corrupt the user's working context?
- Uninstalling and reinstalling — does reinstalling restore the user's previous state/config, or does it behave as a totally fresh install with no continuity, silently discarding prior work or settings?
- Abandoning setup halfway through (closing the app or killing the process mid-onboarding or mid-provider-setup) — on relaunch, does the product resume intelligently from where the user left off, or does it force a restart from zero, or worse, land in a broken/undefined state?
- Attempting unsupported workflows (e.g., invoking a Desktop-only feature from the CLI, or requesting an Extension capability from a surface that doesn't support it) — does the product produce a clear, specific, actionable error, or a generic/confusing failure?
- Common beginner mistakes (malformed commands, missing required flags, invalid config file edits, typos in provider names) — assess whether error messages are specific and corrective (telling the user exactly what to fix) or generic and unhelpful (e.g., raw stack traces, unexplained exit codes).

Conclude with a Recovery Grading Table: for each journey, assign a Recovery Grade (Excellent / Adequate / Poor / Failing) with justification, and identify the single most fragile journey in the current release — the one most likely to produce a support ticket, a GitHub issue, or a silent churn event.

PART 11 — LONG-TERM EXPERIENCE (TEMPORAL AUDIT)

Every product feels different in the first five minutes than it does three months later. A product that dazzles on first use but accumulates friction over time is a product with a retention problem hiding behind a good demo. This section requires you to assess FERAL across explicit time horizons, using available evidence (state persistence design, update/changelog cadence signals, settings accumulation patterns, configuration file growth, extension/provider management at scale, etc.) to reason about how the experience evolves.

Assess each horizon explicitly:

- First Hour — the immediate impression; dominated by onboarding, first workflows, first configuration.
- First Day — does the user complete a real, meaningful piece of work, and how does the experience hold up once the "getting started" scaffolding is no longer present?
- First Week — does repeated use reveal shortcuts, muscle memory, and increasing fluency, or does it reveal repeated friction points that a first-time reviewer wouldn't notice but a repeat user would (e.g., repetitive confirmation dialogs, lack of keyboard shortcuts for common repeat actions, no memory of recent providers/models/extensions)?
- First Month — at what point does configuration sprawl become a burden (multiple providers configured, multiple extensions installed, accumulated history/sessions)? Does the product provide adequate tools for management at this scale (search, organization, cleanup, archiving), or does it assume a permanently small-scale usage pattern?
- Three Months Later — assess long-horizon concerns: does terminology/workflow consistency hold as the user moves fluidly between all surfaces by now, or does the initial unified mental model reveal cracks under sustained, expert-level use? Does the product reward mastery (power-user affordances, automation, scripting depth) or does it plateau, offering an expert user the same interaction patterns as a first-day novice?

Conclude with an explicit verdict: does FERAL's experience trend toward increasing intuitiveness and enjoyment over time, or toward increasing friction and accumulated annoyance? Identify the specific inflection point, if one exists, where the trajectory changes, and what evidence supports placing it there.

PART 12 — PRODUCT TRUST AUDIT

This is explicitly not a security review — it is a review of whether the product feels trustworthy to a user in the everyday sense: predictable, transparent about what it's doing, forgiving of mistakes, and respectful of user control. A product can be perfectly secure and still feel untrustworthy to use if it behaves unpredictably or hides consequences from the user.

Assess each of the following dimensions with evidence:

- Predictability — do identical actions produce identical, expected results every time, across sessions and across surfaces? Identify any instances of surprising or inconsistent behavior.
- Transparency — when FERAL is performing a non-trivial operation (calling a cloud provider, running a local model, invoking an MCP tool, executing an extension), does the user have clear visibility into what is happening and why, or does the system act as an opaque black box?
- Recoverability — when something goes wrong (a failed task, a bad configuration, an interrupted operation), can the user cleanly return to a known-good state, or is recovery unclear, manual, or destructive?
- Confidence During Destructive Actions — for any action that deletes, overwrites, resets, or otherwise cannot be trivially undone (removing a provider, clearing history, uninstalling an extension, resetting configuration), assess whether the product clearly signals destructiveness before the user commits to it.
- Clarity of Dialogs — are confirmation dialogs and prompts specific about what will happen, or do they use vague, generic language ("Are you sure?") that fails to communicate real consequences?
- Clarity of Consequences — does the user always understand what will happen before they click/confirm, including secondary effects (e.g., "switching providers will end your current session" vs. silently doing so)?
- Reversibility — for actions that can be undone, is undo discoverable and reliable? For actions that cannot be undone, is that irreversibility clearly communicated in advance?
- User Control — does the user feel like the operator of the system at all times, or does the system take actions (auto-updates, auto-configuration changes, silent background behavior) without adequate visibility or consent?

Conclude with a Trust Scorecard (rate each dimension qualitatively: Strong / Adequate / Weak / Absent, with evidence) and a synthesis statement on whether, taken together, these dimensions would cause a new commercial user to trust FERAL with real, important work — or to hold back and use it cautiously until it "proves itself," which is itself a signal of insufficient trust design.

PART 13 — PERFORMANCE PERCEPTION

This section evaluates perceived performance, explicitly distinct from raw benchmark performance (which is out of scope for this product audit). A technically fast system can feel slow due to poor feedback design, and a genuinely slow operation can feel acceptable if latency is well-managed and well-communicated. Assess:

- Responsiveness — does the product (across Desktop, TUI, and CLI) feel immediately responsive to input, with no unexplained lag between user action and visible acknowledgment, even if the underlying operation takes time to complete?
- Loading Feedback Appropriateness — for operations of varying duration (instant, a few seconds, tens of seconds, long-running background tasks), does the feedback mechanism match the wait (e.g., a spinner for a 1-second wait is fine; a bare spinner with no progress indication for a 60-second local model load is likely to erode confidence)? Identify specific mismatches.
- Latency Hiding — does the product employ techniques (optimistic UI updates, skeleton states, streaming responses, progressive rendering of model output) to make inherent latency (especially around cloud provider round-trips and local model inference) feel shorter than it is? Or does the user stare at dead air during known-slow operations?
- Waiting States and Confidence — do waiting/loading states actively reduce user confidence (e.g., ambiguous spinners with no context, no indication of expected duration, no ability to cancel) or actively preserve/build it (clear status text, progress indication where feasible, cancel affordances, reassurance that the system is working as intended)?

Conclude with specific findings on which surface has the best-perceived performance and which has the worst-perceived performance, with evidence, and identify the single highest-leverage perceived-performance fix available before launch.

PART 14 — PRODUCT IDENTITY & MEMORABILITY AUDIT (THE 30-MINUTE RECALL TEST)

This section is a deeper, more targeted pass than the foundational identity assessment in Part 1, and should be treated as complementary rather than duplicative — Part 1 asks whether FERAL can be described in one sentence; this section asks specifically what a real user retains after a realistic, bounded session of use, and whether that retained impression is deliberate, coherent, and reinforced everywhere the user looks.

Answer explicitly, with evidence:

- After using FERAL for approximately 30 minutes (a realistic first working session spanning onboarding plus a small amount of real usage across at least two surfaces), what would a user most likely remember — which specific moments, visuals, phrases, or interactions would stick? Base this on the most distinctive, most repeated, or most emotionally charged elements identified elsewhere in this audit (Part 9 in particular).
- What makes FERAL unmistakably FERAL? Identify the specific, concrete signature elements (visual motifs, terminology choices, interaction patterns, tone of voice in copy, a distinctive capability or workflow) that a user could not mistake for a generic AI tool or a competitor's product. If no such signature elements clearly exist, state this directly — it is itself a critical finding.
- Does the product have a coherent personality and identity? Assess tone of voice consistency in copy across Desktop, CLI help text, error messages, Discord bot responses, and documentation — a product with a strong identity typically "sounds like itself" everywhere; a product without one reads as if written by different teams with no shared style guide.
- Does every interface reinforce that identity, or dilute it? Explicitly assess whether the TUI, CLI, Discord bot, and Desktop app each feel like manifestations of the same underlying personality, or whether one or more surfaces feel generic, borrowed, or inconsistent with the identity established elsewhere (e.g., a playful, confident Desktop app paired with a terse, cold, unhelpful CLI would represent a significant identity fracture).

Conclude with a direct verdict: is FERAL's identity strong enough to survive first contact and be recalled/described accurately by a user a day later, or does it fade into "generic AI tool" in the user's memory?

PART 15 — PRODUCT CONTINUITY AND CROSS-SURFACE EXPERIENCE

This section should directly answer the ecosystem-cohesion thesis stated at the top of this brief.

- Construct at least two explicit cross-surface user journeys (e.g., "user starts a task in Desktop, checks its status via Discord, and finishes reviewing output in the TUI") and walk through them step by step, flagging every point of friction, terminology mismatch, missing state sync, or mental model break.
- Assess whether a user's configuration, preferences, history, and identity persist and remain consistent as they move between surfaces, or whether each surface behaves as an island requiring redundant setup.
- Deliver an explicit verdict: "FERAL currently behaves as ONE cohesive ecosystem" or "FERAL currently behaves as MULTIPLE loosely federated tools," with your strongest supporting evidence, and — if the verdict is negative — the smallest set of changes that would flip the verdict for the next minor release.

PART 16 — DOCUMENTATION, README, AND ARCHITECTURE DISCOVERABILITY

- Assess the README as a user's likely first true exposure to FERAL: does it clearly answer "what is this," "who is it for," "how do I get started in under 5 minutes," and "how is this different from alternatives"? Quote specific sections that succeed or fail at this.
- Assess documentation completeness and consistency across all surfaces — is CLI documentation as mature as Desktop documentation, or is one surface clearly the "real" product while others are documented as an afterthought?
- Assess architecture discoverability strictly from a product/contributor comprehension standpoint (not security/architecture correctness): can a new contributor or curious user quickly build an accurate mental model of how the pieces (Desktop, TUI, CLI, API, Discord, MCP, Extensions, Providers) relate to one another from available docs/diagrams, or must this be reverse-engineered from source code?

PART 17 — OSS CONTRIBUTOR EXPERIENCE

- Assess the path from "interested developer" to "first merged contribution": contribution guidelines, code of conduct, issue labeling/triage system, local dev environment setup instructions, and build/test instructions.
- Assess whether the codebase organization communicates clear ownership boundaries between the surfaces (does a contributor know where TUI code lives vs. Extension SDK code vs. Provider abstraction code?).
- Identify any barriers that would cause a well-intentioned external contributor to abandon their first contribution attempt, with evidence.

PART 18 — API & DEVELOPER EXPERIENCE (HOLISTIC)

Synthesize across the CLI, HTTP API, MCP, and Extensions findings from Part 7 into a single holistic DX verdict: if a professional developer were evaluating FERAL as infrastructure to build on top of, would they trust it? Assess error handling philosophy consistency, versioning/stability signaling, rate-limit/quota transparency (product-level, not security-level), and SDK/client library maturity if applicable.

PART 19 — COMPETITIVE ANALYSIS

- Directly compare FERAL against the commercial benchmarks named earlier (GitHub Desktop, JetBrains IDEs, Linear, Cursor, Claude Code, and any other clearly relevant tool) on the dimensions of: onboarding quality, cross-surface coherence, design polish, extensibility model clarity, and pricing/positioning clarity if applicable.
- Identify FERAL's genuine differentiators — the things it does that no named competitor does as well — and assess whether these differentiators are prominently surfaced to users or buried.
- Identify the single greatest competitive vulnerability in FERAL's current state.

PART 20 — PRIORITIZED PRODUCT HARDENING SPECIFICATION

This is the most operationally important section of the audit and must be constructed with rigor. Organize all findings from Parts 1–19 (including the Emotional Experience, Negative Journey Testing, Long-Term Experience, Product Trust, Performance Perception, and Product Identity & Memorability sections — these are not optional extras and must be fully represented in the backlog, not treated as soft/qualitative asides) into a unified, de-duplicated backlog, structured as follows:

For every finding included here, provide all of the following fields in a consistent table or structured format:

| Field | Requirement |
|---|---|
| Finding ID | Unique identifier, grouped by theme |
| Description | What is wrong, precisely |
| Evidence | Citation to the specific artifact/location |
| Severity | Critical / High / Medium / Low, with explicit rubric applied consistently (Critical = blocks launch or breaks core trust/mental model across surfaces; High = significantly degrades experience or ecosystem coherence; Medium = noticeable polish/consistency gap; Low = cosmetic or edge-case) |
| Expected User Impact | Concretely describe who is affected and how (e.g., "every new user during onboarding," "power users scripting via CLI," "contributors attempting first PR") |
| Recommendation | Specific, actionable fix — not vague guidance |
| Acceptance Criteria | Concrete, testable conditions that must be true for this finding to be considered resolved |
| Implementation Order Dependency | Does this depend on another finding being resolved first? Note dependencies explicitly |
| Estimated Effort | T-shirt size (S/M/L/XL) based on apparent scope |
| ROI Estimate | Qualitative but justified estimate of impact-to-effort ratio (e.g., "High ROI: Small change to CLI error messages resolves a Critical trust issue affecting 100% of first-run experiences") |

Group these findings into Prioritized Implementation Tracks — do not present a flat list. Suggested track structure (adapt based on actual findings):

- Track 0 — Launch Blockers: Must be resolved before public release. Anything here should be genuinely launch-threatening, not merely embarrassing.
- Track 1 — Ecosystem Coherence Sprint: Terminology unification, mental model alignment, cross-surface consistency fixes — the highest-leverage track given this audit's thesis.
- Track 2 — Polish & Trust: Visual consistency, error message quality, empty states, onboarding friction removal, trust/transparency fixes identified in the Product Trust Audit.
- Track 3 — Platform Parity: Cross-OS gaps and surface-specific weak links.
- Track 4 — Strategic Simplification: Explicit recommendations for what to cut, hide, or defer to reduce surface area and strengthen focus — this track should actively reflect the "simplicity over feature count" principle and must include at least one concrete recommendation to remove or de-scope something, if the evidence supports it.
- Track 5 — Post-Launch Roadmap Candidates: Valid ideas that are explicitly NOT for this release.

Within each track, specify a recommended implementation order (a numbered sequence, not just a bag of items), reasoning explicitly about dependencies (e.g., "terminology unification must precede documentation rewrite, which must precede onboarding redesign").

PART 21 — FINAL RELEASE VERDICT

Close the audit with an unambiguous, executive-grade verdict, structured as:

- Verdict: GO / CONDITIONAL-GO / NO-GO
- Confidence Level: State your confidence in this verdict and what would change it.
- If CONDITIONAL-GO: enumerate the exact, minimal, non-negotiable set of items from Track 0 (and only Track 0) that must be completed, with no scope beyond what is strictly necessary — resist the temptation to smuggle in nice-to-haves under the conditional-go banner.
- One-Paragraph Narrative Verdict: Written as if for a founder/CEO who will read only this paragraph — state plainly whether FERAL, as it exists in the materials reviewed, would make a new user feel they are using one confident, coherent, well-crafted product, or whether it would make them feel they are navigating a loosely connected collection of tools wearing the same name. This paragraph is the single most important sentence-set in the entire document — do not hedge it.

PART 22 — FINAL EXECUTIVE PRIORITIZATION: THE TOP 10 HIGHEST-LEVERAGE IMPROVEMENTS

This is the final exercise of the audit and must be performed after all preceding parts are complete, since it is a distillation exercise, not a new analysis.

Adopt the specific persona of the VP of Product, standing at the final go/no-go review meeting before a public release, being told: "You have the resources and time to improve only TEN things before we launch. Ignore implementation cost entirely — assume infinite engineering capacity for these ten items specifically. Rank purely by user impact and product quality improvement."

Requirements for this section:

- Select exactly ten improvements, drawn from anywhere in the entire audit (structural, emotional, trust-related, identity-related, performance-related, or ecosystem-coherence-related) — do not artificially constrain yourself to one category; the best top-10 list will likely span multiple audit dimensions, and a list that draws only from, say, Track 0 launch blockers has failed the exercise, since this ranking is explicitly about pure user impact, not launch-blocking necessity.
- Rank them 1 through 10, with 1 being the single highest-leverage improvement possible before public launch.
- For each item, provide:
  - The specific improvement, stated concretely and actionably.
  - Which part(s) of the audit it originates from.
  - A tight, direct justification (2–4 sentences) for why this belongs in the Top 10 — specifically framed in terms of user impact and product quality, not effort or feasibility.
  - What would be measurably different about the user's experience of FERAL if this single item were fixed and nothing else changed.
- Close with a short synthesis paragraph: what pattern do the Top 10 items reveal about where FERAL's greatest leverage for quality actually lies — is it concentrated in one theme (e.g., ecosystem coherence, first-run trust, emotional experience), or spread evenly across the product? This synthesis is itself a strategic insight for leadership about where to focus attention beyond this single list.

State explicitly: this Top 10 list represents the single most valuable roadmap available before the public release, and should be treated by leadership as the definitive answer to "if we could only do ten things, what should they be?"

TONE AND VOICE REQUIREMENTS

- Write with the directness, precision, and unsentimental clarity of a senior review that respects the team's effort but does not soften findings to spare feelings. This is a pre-launch gate, not a performance review.
- Do not use hedging language ("might," "could potentially," "it's possible that") where evidence supports a direct claim. Reserve hedging strictly for genuine inference/assumption sections, clearly labeled as such.
- Do not praise generically. Every positive finding must carry the same evidentiary weight as every negative finding.
- Avoid filler, avoid restating this brief back, and avoid meta-commentary about the audit process itself — begin directly with Part 0 and proceed through Part 22 in full.
- Assume the reader (founders, head of product, head of engineering, board) is time-constrained but wants full rigor available on demand — use the Executive Summary in Part 0 to serve the skimmer, and use Parts 1–22 to serve the implementer who needs no further clarification to begin work.
- When assessing emotional experience, trust, and identity (Parts 9, 12, and 14 in particular), do not drift into unfalsifiable psychological speculation — every emotional or trust claim must still be traceable to a specific, concrete product artifact or behavior that plausibly produces that response in a real user. Emotional rigor is still evidentiary rigor.

FINAL INSTRUCTION

Treat every artifact provided to you about FERAL (source code, documentation, README, CLI transcripts, screenshots, configuration files, extension manifests, API specifications, Discord bot interactions, changelogs, and any other supplied material) as ground truth for this audit. Where information needed for a section is not present in the materials provided, state this explicitly within that section rather than fabricating detail, and specify precisely what artifact would be required to complete the assessment. Do not begin work until you have identified and internally catalogued every distinct surface, terminology instance, and cross-surface workflow available in the provided materials — this cataloguing is the foundation on which the Terminology Consistency, Mental Model Audit, Product Continuity, Emotional Experience, and Product Identity & Memorability sections depend, and these five sections together are the ones on which this entire audit's credibility rests.

Begin the audit now with Part 0 — Executive Summary.
