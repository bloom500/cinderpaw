# Cinderpaw Community — attraction & moderation strategy

**Status:** Draft
**Date:** 2026-08-20
**Related:** ADR-0016 (Community mesh), ROADMAP.md
**Owner:** Bloom Media (TBD dedicated community manager Q4 2026)

## Where we are today

- **Discord server exists** dar nu-i linked public în README (says "coming soon"). Membership current unknown la writing time.
- **GitHub Discussions** live at github.com/bloom500/feral/discussions.
- **X/Twitter** cont @BloomMedia66730 activ.
- **Connectors** built-in pentru Discord + Slack + WhatsApp — comunitatea deja poate operate agent-ul din chat existent.
- **License**: BSL 1.1 — visible în README badge, care e signal despre philosophy (non-vc, non-extractive).
- **Positioning**: local-first, no telemetry, no cloud middleman, BYOK optional. **Explicitly anti-corporate AI**.

Aceasta este substantial mai bine decât "from zero". Nu construim community — o **operationalizăm** și pregătim pentru Community feature launch.

## Guiding principles

1. **Substance over noise**: dev-audience distinguishes real content de marketing în seconds. Weekly banal AMA-uri sub 5 mesaje e worse decât nothing. Publish când ai ceva de spus.
2. **Show don't tell**: teardowns > announcements. "How we fixed the RSI proto leak" beats "we care about safety".
3. **Reciprocity**: reply everyone în first month. Ratio drops later, dar early acts define culture.
4. **No dark patterns**: no artificial urgency, no fake scarcity, no follower-farming hooks. Anti-corporate stance e brand — don't undermine it.
5. **Moderation predictable**: rules written, enforced consistent, appeals possible. No cliques, no vibes-based bans.
6. **Community-first vs product-first**: dacă un feature în ROADMAP e obviously worse pentru user experience decât alternative brought up în community, cede. Community trust > roadmap ego.

---

## Part 1 — Pre-launch content strategy (Q3 2026 → Q3 2027)

12 luni de content care build audience înainte de Community feature (v1.1 Alpha, mid-May 2027).

### Content pillars — 4 tipuri, distinct audiences

**Pillar A: Technical deep-dives** (audience: senior devs, AI researchers, security-conscious)
- **Cadence**: 1 post/lună (Substack sau own blog on cinderpaw.dev/blog).
- **Format**: 2000-4000 words + code snippets + diagrams.
- **Topics din backlog** (folosește existing audit findings ca material):
  - "Why local-first AI needs a Bounded RSI: our approach" (ADR-0007 territory)
  - "Building an immutable scorer în Rust: the trust boundary problem" (audit §180, §181)
  - "How we render a 22-state pixel mascot în 4KB of code" (mascot audit)
  - "Prompt injection în file uploads: the case for boundary tokens" (audit §227, §228)
  - "Bundle identifiers, hidden state migrations, and why Faza C of our rebrand took 3 weeks" (post-rebrand)
  - "Sandbox escapes we found în our own RLM notebook" (audit §142) — publishable POST-fix, high-value technical content.
  
**Publish-worthy = has technical substance + tells story of decision + shows work.** Not corporate.

**Pillar B: Release notes + changelogs** (audience: existing users, tech-curious)
- **Cadence**: with every release (v0.2, v0.3, ...).
- **Format**: markdown release notes + GIF/video demo of new features + upgrade notes.
- **Style**: prose not bullet lists. Explain the WHY of each change. Reference audit findings by number when relevant ("Fixed §142 — a proto-leak în the RLM notebook that could have escaped the sandbox").
- **Distribution**: GitHub Releases page + cross-post la Discord #announcements + X thread.

**Pillar C: Community showcase** (audience: everyone, aspirational)
- **Cadence**: 1 post/săptămână starting Q1 2027 (post multi-agents launch).
- **Format**: 200-500 words + screenshot/video, on X + Discord + Discussions.
- **Topics**: "Agent of the week" (once agents multi-personal shipping v0.4), "Skill spotlight", "User workflow" (cu permission), "Setup showcase" (cool BYOK combos, wild local hardware).
- **Post-Community-launch (v1.1+)**: "Featured public agent" cu attribution la publisher.

**Pillar D: Meta / brand / philosophy** (audience: anti-corporate AI folks, privacy-first devs)
- **Cadence**: 1 post/2 luni.
- **Format**: essay-style, 1500-3000 words, on blog + shared la HN.
- **Topics**:
  - "Why Cinderpaw uses BSL 1.1 instead of MIT / AGPL"
  - "The 'no telemetry' promise: what it actually costs us"
  - "Why we rebranded from Feral to Cinderpaw" (soft-launch la rebrand Faza D, 2027 Q1)
  - "Building an AI app without becoming an AI company"
  - "The middleman problem în AI apps (and how we avoid it)"

### Publishing timeline

```
Q3 2026 (v0.2 rebrand cosmetic)
├── Blog post 1: "Introducing Cinderpaw (formerly Feral)" — soft rebrand announcement
├── Discord: link Discord public în README + welcome campaign
└── X thread series: "10 things we shipped în v0.2" per feature

Q4 2026 (v0.3, v0.4)
├── Blog post 2: "How we designed our Brain Stack" (ADR-0014 material)
├── Blog post 3: "22 pixel-art states for one mascot" (mascot deep-dive, fun content)
├── Release notes v0.3 + v0.4 (2 releases)
├── HN Show HN: "Cinderpaw v0.4 — multi-agent AI workspace, local-first"
└── Podcast pitch: reach out la Latent Space / Practical AI / etc.

Q1 2027 (v0.5, v0.6, v0.7)
├── Blog post 4: "Multi-agent design: from 1 agent to a team on your machine"
├── Blog post 5: "Migrating ~/.feral to ~/.cinderpaw without breaking users"
├── Blog post 6: "RSI integration: how routing metrics feed evolution"
├── "Agent of the week" series LAUNCH (weekly)
└── Podcast appearances (2-3)

Q2 2027 (v1.0 GA + Community v1.1 Alpha)
├── Blog post 7: "Cinderpaw v1.0 — what took us 12 months"
├── ANNOUNCEMENT: cinderpaw.dev/community — Alpha invite waitlist opens
├── HN launch: front page attempt
├── ProductHunt launch (day-of coordination)
└── Founding publisher applications open

Q3 2027 (v1.2 Beta → v1.3 GA)
├── Weekly "Featured agent" post
├── Publisher stories (interview-style)
├── Blog post 8: "Trust în agent marketplaces: what we've learned from 3 months of Alpha"
└── Conference presence: attempt CFP la a AI/ML conference
```

### Content operations

- **Ownership**: initial writes done by co-founder(s). Nu outsource content (voice/authenticity matter).
- **Cross-post protocol**:
  1. Publish canonical on blog (own domain).
  2. Post excerpt + link la X.
  3. Post link la Discord #showcase channel.
  4. Post link la r/LocalLLaMA sau r/selfhosted (subreddits fit).
  5. HN submit ONLY for pieces cu real technical substance (Pillar A + D). NEVER release notes.
- **SEO**: canonical URLs, OpenGraph tags per post, sitemap. Nu joacă keyword games — write for humans.
- **Analytics**: opt-in only (aliniat cu no-telemetry stance). Use Plausible sau own logs. Track: unique visits per post, referrer sources. NU track individual users.

### Amplification levers

- **Cross-mention**: dacă un content creator vorbește about Cinderpaw, boost signal (RT + reply thoughtfully, not sycophantic).
- **Guest posts**: allow trusted community members să write for the blog (with editorial review). Distributes voice.
- **Repost from Discord**: cel mai bun content organic (member helping member, technical discussion) — cu permission, elevate la blog "Community wisdom" series.

---

## Part 2 — Discord: converting from casual server to Community platform

Discord is now — user says "aveam deja". Need to prepare it pentru scale + prepare it ca pipeline pentru Community feature launch.

### Channel structure (recommended)

```
📢 INFO
├── #welcome (rules, links, intro flow)
├── #announcements (staff-only posting, all subscribers)
└── #changelog (auto-post release notes)

💬 GENERAL
├── #general-chat (chatter, off-topic OK în moderation)
├── #introductions (new member post here first, moderator welcome flow)
└── #showcase (users show setups, screenshots, cool workflows)

🛠 SUPPORT
├── #help (main support channel, threaded discussions)
├── #bugs (issue reports; moderator escalates to GitHub Issues)
├── #installation (specific to install pain, common OS-per-OS problems)
└── #byok-config (BYOK setup help — high-friction area)

🧠 DEEP
├── #brain-stack (routing, models, config)
├── #agents (multi-agent workflows, agent design)
├── #skills (custom skills, self-taught patterns)
├── #rsi (advanced: RSI/evolution engine, dream cycle discussions)
└── #dev (contributors, PR discussion, technical direction)

🌟 COMMUNITY (post v1.1)
├── #community-agents (announce new published agents)
├── #agent-requests ("looking for an agent that does X")
├── #trust-and-safety (report abuse, moderation transparency)
└── #publishers (private, publishers-only, best practices sharing)

🎙 EVENTS
├── #events-announcements
└── voice channels: Stage / Office Hours / Coworking
```

### Roles & permissions

**Automatic on join:**
- `@Member` — default, can post în #general, #introductions, #showcase, #help.

**Verified tiers** (map la ADR-0016 identity tiers):
- `@Verified-Email` — after email verify.
- `@Verified-GitHub` — after linking GitHub (via OAuth bot).
- `@Verified-Domain` — after `.well-known` verification.
- `@Team-Verified` — Cinderpaw team members (visible star).

**Contribution-based (earned):**
- `@Helper` — 20+ helpful replies (nominated by staff, quarterly review). Access la #dev.
- `@Contributor` — 3+ merged PRs sau significant Discord contributions. Access la #dev + preview releases.
- `@Founding-Publisher` — first 500 Community Alpha publishers. Permanent badge. Access la #publishers.
- `@Moderator` — trust + activity (see moderation section).

**Restricted:**
- `@Muted` — cannot post except în #appeals for X period.
- `@Restricted` — read-only în all except #appeals.

### New member onboarding flow

Automated via bot (recomand Wick sau MEE6 for base, custom bot pentru advanced):

```
Step 1 (join):
  Auto-DM welcome message:
    "Welcome la Cinderpaw! Please read #welcome pentru rules,
     then say hi în #introductions.
     Support goes în #help — use threads pentru multi-turn issues.
     Enjoy your stay 🐾"

Step 2 (rules acknowledgment):
  In #welcome: emoji react ✅ pe rules post → auto-assign @Member role.
  Without react: user cannot post în other channels.

Step 3 (intro):
  In #introductions: template message
    "👋 Hi I'm ...
     Using Cinderpaw for ...
     Stack: [Windows/Mac/Linux] + [BYOK/local model]"
  Moderators react cu 👋 (light-touch acknowledgment). Non-obligatory.

Step 4 (30 days later):
  Bot survey via DM (skippable):
    "How's your Cinderpaw experience so far?
     Anything we should fix? Any features you'd love?"
  Feedback flows la #dev + team feedback board.
```

### Rules (public, prominently displayed în #welcome)

```
🐾 Cinderpaw Community Rules

1. Be respectful. Zero tolerance pentru harassment, hate speech, personal attacks.
2. No spam. Repeated identical messages, promo dumps, DM-bombing → mute + warning.
3. Support goes în #help (threaded). Don't DM staff pentru support unless directed.
4. English preferred for readability. Other languages fine în off-topic + intros.
5. Content policy: no CSAM, no doxxing, no facilitating harm. Serious violations = permaban + report to Discord T&S.
6. Constructive criticism welcome. "This sucks" without detail = removed.
7. NSFW: not this server. Take it elsewhere.
8. Don't share BYOK keys accidentally. Bot will auto-detect + delete common key formats.
9. Piracy discussion (of models, of software) allowed în moderation. Distribution links = removed.
10. Publisher content în Community feature must follow platform ToS + local law. See #trust-and-safety.

Appeal process: DM @Moderator sau post în #appeals.
Repeated warnings → mute → restrict → ban. All actions logged și appealable.
```

### Moderation infrastructure (user's focus area)

Since user specifically asked pentru moderation improvements, deep dive:

#### Automated moderation (bots)

**Wick (or similar anti-raid bot)**:
- Anti-raid: block > 5 joins/minute from same fingerprint.
- Alt-account detection: same IP + account age < 24h + no verified email → auto-restrict pending manual review.
- Slowmode auto-enable on channels experiencing spam bursts.

**Custom Cinderpaw bot** (built-in-house, integrates cu Community platform post-v1.1):
- Auto-delete messages matching common BYOK key patterns (`sk-...`, `sk-ant-...`, `AIza...`, `sk-or-...`) cu warning DM la sender.
- Auto-flag messages containing `discord.gg/` links from non-verified members (link spam).
- Auto-flag prompt-injection-like patterns în shared agent configs (leverages same LLM classifier ca ADR-0016 C5).
- Cross-post GitHub Issues cu label `community-reported` when moderator escalates un bug report.

**AutoMod (native Discord)**:
- Keyword filter pentru slurs (custom list, not just Discord's defaults).
- Mention spam: >5 @mentions per message → auto-delete + warn.
- CAPS lock filter: > 70% caps în messages > 20 chars → delete cu warning.

#### Human moderation tiers

**Tier 1: Community-elevated helpers** (`@Helper`)
- Nominated by staff based on:
  - 20+ helpful replies în #help sau #installation.
  - Zero moderation actions against them.
  - Active > 60 days.
- Permissions: can send warnings, request mute (staff executes).
- No ban power. No message deletion power except own.

**Tier 2: Moderators** (`@Moderator`)
- Selected from `@Helper` pool after minimum 90 days.
- Application process: private discussion cu staff, cu 2 existing mods approving.
- Permissions: mute, timeout, message delete, ban (with 2nd mod confirmation via `!ban` command that requires ack).
- **Mandatory training** — 1-hour session cu head-of-community, discussion despre appeals process, escalation criteria, burnout prevention.

**Tier 3: Staff** (`@Team-Verified`)
- Cinderpaw team members.
- Full permissions.
- Handles appeals, cross-platform issues (Discord ↔ Community platform bans).

#### Moderation ops guidelines (prevent mod burnout)

- **No 24/7 expectation**. Cover major timezones cu 3-4 mods min. Off-hours = automated + queue pentru next-day review.
- **Rotation weekly**: 1 mod on "primary" duty for the week, others backup. Prevent hero-mod syndrome.
- **Public mod log** (redacted): every action posted în #mod-log-public cu reason (no personal details). Transparency = trust.
- **Appeals within 48h SLA**. Real answer, not template. Mods can escalate hard cases la staff.
- **Mods' mental health**: encourage breaks. Anyone can step down without shame. Yearly "mod appreciation" gesture (T-shirts, gift cards ~$50).

#### Moderation policies for Community feature (post-v1.1)

Beyond Discord general moderation, when Community launches un extra layer:

- **Published agent moderation lives on Community platform**, NOT Discord. But Discord #trust-and-safety channel bridges — user reports agent via Discord, mods triage + escalate la platform team.
- **Cross-ban policy**: severe Discord violations (racism, doxxing, targeted harassment) → Community platform ban too. Consistent voice.
- **Publisher offenses**: bad publisher on Community → Discord role removed too (`@Founding-Publisher` revoked, prevents recruiting others).
- **Discord-only offenses**: don't auto-cross-ban la platform (Discord issues stay Discord).

Rationale: link identity via linked GitHub OR email verified. But keep some separation — someone can be bad on Discord (immature chat) fără să fie bad publisher, and vice versa.

#### Handling common scenarios (playbook draft)

**"New user posts BYOK key în #help"** (happens weekly):
1. Bot auto-deletes message.
2. Bot auto-DMs sender: "We removed your message because it contained an API key. **Rotate that key immediately** — anyone who saw the channel could have copied it. Then repost your question without the key. Here's how to attach config safely: [link]."
3. Bot logs în #mod-log-private for staff review.
4. If repeated: `@Helper` reaches out la user cu direct assistance.

**"Someone reports another user în DM"**:
1. Mod acknowledges receipt within 24h.
2. Mod reviews mentioned messages, DMs cu context.
3. Decides action (warn, mute, ban).
4. Posts anonymized outcome în #mod-log-public.
5. Notifies reporter cu decision.

**"Toxic drama unfolds în #general-chat"**:
1. First mod on scene locks channel with slowmode 30s.
2. DMs primary actors: "Cool down for 30 min. Let's talk after."
3. Documents thread în #mod-log-private.
4. If continued after cool-down: mute involved parties 24h.
5. Post-mortem în #mod-team channel: was our response proportionate? What could improve?

**"Someone complains about a moderation decision loudly în public"**:
1. Do NOT engage publicly în that channel.
2. DM: "Sorry you're frustrated. Appeals go în #appeals. I'll respond within 48h."
3. Handle în #appeals.
4. Update policy dacă appeal reveals mod error.

**"Cinderpaw team member (staff) disagreement publicly în server"**:
1. Take it la #dev sau private staff channel immediately.
2. Never contradict another team member publicly — presents united front, resolve internally.
3. If policy disagreement, escalate to head-of-community for arbitration.

### Discord growth strategy

**Phase 1 (Q3 2026 — v0.2 rebrand)**:
- Discord invite public în README.
- Discord invite în-app (Settings → About → Community).
- Cross-post from GitHub Discussions to Discord for high-engagement threads.
- Goal: 200 members by end Q3.

**Phase 2 (Q4 2026 — v0.3, v0.4)**:
- Blog post 1 & 2 include Discord CTA.
- Reddit AMA (r/LocalLLaMA) with Discord link.
- Goal: 500 members by end Q4.

**Phase 3 (Q1-Q2 2027 — v0.5 → v1.0)**:
- Podcast appearances mention Discord.
- Weekly "Agent of the week" showcases from Discord community.
- Goal: 2000 members by v1.0 GA.

**Phase 4 (Q2-Q3 2027 — Community launch)**:
- Community Alpha invitations run via Discord (must be member to apply).
- Founding Publisher role exclusive Discord perk.
- Voice channel office hours weekly during Alpha.
- Goal: 5000 members by v1.3 GA.

**Growth limits**:
- Do NOT chase raw count. Toxic scaling ruins culture.
- Prefer: 2000 engaged members > 20000 lurkers.
- Optional: cap at 10k members with waitlist gate for signal-preserving.

---

## Part 3 — Founding Member program

Kicks off la v1.1 Community Alpha launch (May 2027).

### Selection criteria (transparent):

**Tier: Founding Publisher (500 slots)**
- Application form via Discord (short: what would you publish, why interested).
- Selection weights (approximate):
  - **50%**: quality of proposed agent(s) — technical merit, uniqueness, value la community.
  - **20%**: Discord engagement history (contributions, helpfulness, tenure).
  - **15%**: verification tier (GitHub-linked+ preferred).
  - **10%**: diversity considerations (skill areas, geography, use cases).
  - **5%**: staff intuition (people we trust because we've watched them 6 months).

**Applications open**: 2 weeks before Community v1.1 Alpha launch.
**Decisions**: 1 week after close, DM-notified.
**Waitlist**: rejected applicants queued pentru v1.2 Beta wave.

### Founding Publisher perks (permanent):

- Permanent `@Founding-Publisher` role în Discord (visible badge, subtle status).
- Permanent badge on Community platform profile ("⭐ Founding Publisher, joined 2027").
- Early access to future publisher features (2 weeks before public).
- Private #publishers channel access — direct line la team.
- Priority moderation SLA (24h vs standard 72h).
- Optional quarterly "publisher call" cu team (30 min, agenda user-driven).
- **Not perks**: NO revenue share bonus (payments come v2). NO free credits (avoid manipulation).

### Founding Member (non-publisher, 1000 slots)

For people who don't want to publish but want early access la Community feature (as invokers).

- Application: shorter form, mostly self-declared use case.
- Rolling admission (not batched).
- Perks: `@Founding-Member` role Discord badge, early access to platform features, direct feedback channel.

### Recognition post-launch

- Blog post at end of Alpha: "Meet the founding publishers" (opt-in, feature 10-15).
- Sticker/T-shirt care package for founders who ship > 3 agents cu 100+ invocations în first 6 months.
- Annual "Founder Reunion" în Discord voice channel (30 min chat cu team, retrospection).

---

## Part 4 — Ecosystem partnerships

20 target-candidate list, cu approach template.

### Content creators (approach: offer collaboration content)

Real people relevant to positioning:

1. **Simon Willison** (@simonw) — LLM tooling, local models. Approach: offer him a "Cinderpaw for LLM enthusiasts" tour cu his own agents demo.
2. **Andrej Karpathy** — big picture AI, respected. Long-shot but if bite = huge signal boost.
3. **Xe Iaso** — writes cu wit despre self-hosting, privacy, tech philosophy. Great cultural fit.
4. **Matt Rickard** — CLI tools, developer productivity. Cinderpaw's TUI + gateway CLI = his beat.
5. **Ben Bitdiddle podcasts** (Latent Space, Practical AI, MLST) — offer episode about Cinderpaw's philosophy (local-first, BYOK, no telemetry).
6. **Fireship, Theo Browne** — YT dev tutorial, would need concise 5-min demo of "Cinderpaw's coolest thing". Long-shot but audience millions.
7. **Web privacy activists** (EFF-adjacent, DHH-adjacent) — Cinderpaw's anti-telemetry stance appeals.

**Approach template**:
> Subject: Cinderpaw — local-first AI workspace, would love your take
>
> Hi <name>,
>
> I've been following your work on <specific project>. We're building Cinderpaw — an AI workspace that runs on your own machine, no subscription, no telemetry, BYOK optional. Multi-agent, self-improving, open source under BSL 1.1.
>
> Not a pitch — just wanted to send you an early build în case it resonates cu <specific angle relevant to them>. Zero expectations. If you like it, we'd love to hear feedback. If it's not for you, no problem.
>
> Link: <permanent demo build>
> Docs: https://cinderpaw.dev/docs
>
> - <name>, Cinderpaw team

Note: **NEVER ask pentru retweet, mention, review în first email**. Deliver value first, hope for reciprocity organic.

### Open source projects (approach: propose integration)

8. **Ollama** — natural integration partner (Cinderpaw already supports Ollama backend). Approach: PR into their docs cu Cinderpaw ca "one desktop UI for Ollama".
9. **LM Studio** — competitor, potentially. Approach: cordial coexistence, cross-link în docs.
10. **Continue.dev** (VS Code AI extension) — different form factor. Approach: propose Continue.dev cu Cinderpaw ca backend option.
11. **LangChain** — cross-community. Approach: PR into their LLM providers list — Cinderpaw gateway as backend.
12. **Huggingface** — Cinderpaw already integrates HF downloads. Approach: propose being listed în HF Spaces alternatives.
13. **llama.cpp** — Cinderpaw uses vendored llama.cpp. Approach: cross-reference în their community showcase.
14. **Aider, Continue, Cursor** — code-editing agents. Approach: propose being "your background agent" complementary la their in-IDE.

### Dev tool makers (approach: mutual promotion)

15. **Warp Terminal** — modern terminal. Approach: bundle promo (Cinderpaw în their marketplace).
16. **Raycast** — command palette. Approach: Cinderpaw extension for Raycast.
17. **Obsidian** — knowledge management. Approach: plugin integration (Cinderpaw's memory ↔ Obsidian vault).
18. **Neovim community** — Cinderpaw CLI has appeal. Approach: post în r/neovim + Neovim Discord.

### Niche communities (approach: bring value first)

19. **r/LocalLLaMA** (250k members) — target audience direct. Approach: 3 substantive posts before any promotion (help others, get known).
20. **r/selfhosted** (500k members) — Cinderpaw fits ethos. Approach: same pattern.
21. **Hacker News** — 1-2 major launches yearly. Approach: HN etiquette (Show HN, Ask HN, submit substantive content).
22. **AI-focused Discord servers** (Latent Space, LocalLLaMA Discord, HuggingFace Discord) — join, contribute, don't spam.

---

## Part 5 — Distribution channels

Where launches land, structured by ceremony required.

### High-ceremony launches (v1.0 GA + Community v1.3 GA)

**Sequence for GA launches (48-72h coordination)**:

**Day -14**: Blog post drafted, reviewed.
**Day -7**: Docs updated, install flow tested, screenshots retaken cu new features.
**Day -3**: Press-kit prepared (logo, screenshots, quotes-from-team, boilerplate). Sent la 5-10 relevant journalists (TechCrunch, The Register, ArsTechnica AI beat).
**Day -1**: Discord announcement stage, Twitter thread drafted, HN post drafted (do NOT submit yet).
**Day 0 (Tuesday morning US-east ~8am, avoiding Monday noise)**:
- 8:00 AM: Blog post published, canonical URL.
- 8:05 AM: HN Show HN submission (from co-founder account, no upvote ring).
- 8:10 AM: Twitter thread published.
- 8:15 AM: Discord announcement.
- 8:30 AM: Reddit posts (r/LocalLLaMA, r/selfhosted).
- 9:00 AM: ProductHunt launch initiated.
- 9:30 AM: DMs la partners și influencers care commit-uisera să boost (offer them link).
- All day: reply comments HN + Reddit personally. Fast, thoughtful, no defensive.

**Post-launch (Day +1 la +7)**:
- Daily check on HN comments, ProductHunt, GitHub Issues surge.
- Ready for hotfix release day +2 dacă critical bug apare.
- Follow-up thank-you thread day +7, summarize feedback themes.

### Medium-ceremony (per-release v0.3, v0.4, etc.)

- Blog post if substantive change.
- Twitter announcement thread.
- Discord #announcements.
- GitHub release notes.
- NO HN unless truly novel.

### Low-ceremony (small updates, hotfixes)

- Discord #changelog auto-post from GitHub.
- No blog, no Twitter.

### Never-ceremony (bug fixes, doc updates)

- Silent release. Docs speak.

---

## Part 6 — Community rituals

Regular events that give members reasons să return.

### Weekly
- **Agent of the week** (post-multi-agents v0.4): showcase în #showcase + X + blog.
- **#help office hours**: 1-2 hours per week, staff + `@Helper` on standby în voice channel.

### Monthly
- **Changelog recap**: what shipped, what's next, questions.
- **New member Q&A**: for people who joined în past 30 days.

### Quarterly
- **Publisher spotlight** (post-Community launch): interview cu top publisher.
- **Transparency report**: moderation actions, growth metrics, roadmap check-in.
- **Community survey**: 5-question NPS + open feedback.

### Yearly
- **Community summit** (virtual, 2-4 hours, multi-tracks): team keynote, publisher panels, breakout channels. First one Q4 2027 if reach 10k members.
- **Annual review blog post**: "Year în review, what we learned, what's next".

### Ad-hoc
- **Bug bash weeks**: pre-release, community invited to hammer beta build, bounties (rep + swag) for critical bugs.
- **Skill jams**: 48-hour prompted challenge (build agent for X category, best gets featured).

---

## Part 7 — Metrics + feedback loops

Track without becoming metric-obsessed.

### Growth metrics (report monthly în transparency updates)
- Discord total members + weekly active (DAU / WAU ratio).
- GitHub stars, watchers, contributors.
- Downloads per platform (macOS / Windows / Linux breakdown).
- Blog post views + referral sources.
- Community Alpha/Beta application count + acceptance rate (post-v1.1).

### Health metrics (private, mod team tracks)
- Moderation actions per week (by type: warn/mute/ban/appeal).
- Reply rate în #help within 24h.
- Appeal overturn rate (indicator of mod calibration).
- Mod team retention (how long mods stay active).
- Toxic-conversation incident rate.

### Product feedback loops
- Discord #dev channel: signals from power users → GitHub issues → roadmap.
- Blog post comments: signals from broader audience.
- Community survey quarterly: structured feedback.
- Direct emails to team address (published): 1:1 detailed feedback.
- Bug bash results: prioritized bug backlog.

### What NOT to optimize for
- Raw follower count. Vanity metric.
- Post frequency. Substance-per-post > post-per-day.
- Engagement rate on X. Twitter algo game corrodes voice.
- Discord message count. High-message toxic servers exist.

---

## Part 8 — Failure modes to avoid

Common community-death spirals + preventive practices.

### 1. Founder disappearance
**Failure**: co-founders busy building product, community starves of leadership. Members feel abandoned.
**Preventive**: 
- Commit publicly to fortnightly Discord check-in from founders (30 min, mostly listening).
- Delegate day-to-day to community manager (hire after 1000 members).
- Founder posts monthly "what I've been up to" — even short, presence matters.

### 2. Moderator burnout
**Failure**: 1-2 mods carrying whole load, get tired, quit, community becomes unmoderated, quality drops, downward spiral.
**Preventive**:
- Rotate on-duty weekly.
- Cap mods at 15 hours/week community time.
- Encourage sabbaticals.
- Recognize publicly.
- Yearly thank-you gestures.

### 3. Inner-circle formation
**Failure**: original members form clique, new members feel unwelcome, growth stagnates.
**Preventive**:
- Explicit welcome flow per new member.
- `@Helper` role rotation.
- New member survey at 30 days flags "did you feel welcomed?"
- Publicly celebrate first contributions.

### 4. Over-moderation → chilling effect
**Failure**: mods too aggressive, members self-censor, discussion becomes bland, real feedback stops.
**Preventive**:
- Public appeals process.
- Mod actions logged (redacted) în public.
- Quarterly review: was our moderation appropriate? Poll members.
- "Speak your mind" days occasionally: temporary loosening cu heavy moderator watch.

### 5. Under-moderation → toxic accumulation
**Failure**: rules exist but not enforced, toxic behaviors normalize, healthy members leave.
**Preventive**:
- Predictable enforcement: same infraction, same consequence, every time.
- Quick response: acknowledgment within 4h even dacă action later.
- Public mod actions log (redacted): signals rules are real.
- Zero tolerance items (racism, doxxing, harassment): NO warning, immediate ban.

### 6. Corporate voice creep
**Failure**: as team scales, communication becomes sanitized, PR-speak, loses voice. Community senses inauthenticity, disengages.
**Preventive**:
- Team members post as themselves (personal accounts, not brand account for everything).
- Publish rough drafts sometimes. Show work.
- Admit mistakes publicly.
- Never issue a "clarification" tweet post-controversy without actual accountability.

### 7. Over-monetization backlash (post-v2)
**Failure**: Community starts free, paid tier introduced, community feels betrayed even dacă free preserved.
**Preventive**:
- Explicit forever-free commitment written down (see Substack backlash for counter-example).
- Paid = added-value premium, never removed-from-free.
- Publisher revenue majority stays cu them (80%+ target).
- Transparency reports on platform financials (once stable).

### 8. Algorithmic curation traps (post-launch Community)
**Failure**: rank agents by invocation count → power laws → top 10 dominate, new publishers can't break in.
**Preventive**:
- Multiple sort options (trending, new, high-quality, cheap, editor-featured).
- "Editor featured" curated slot rotating weekly.
- New publisher boost — first-30-days agents get shelf placement above pure-metric ranking.
- Publish trust score formula so publishers understand how to improve.

### 9. Legal-shy moderation reactive
**Failure**: first lawsuit threat → panic delete + over-moderate → community feels moderation e capricious.
**Preventive**:
- Legal counsel retained BEFORE crisis.
- Written escalation procedure for legal threats.
- Never delete content without documented reason.
- Standard DMCA + DSA response templates prepared.

### 10. Cross-platform inconsistency
**Failure**: Discord permissive, Community platform strict → users confused, arbitrage happens.
**Preventive**:
- One unified Community Guidelines document că applies both.
- Sync ban list quarterly.
- Cross-platform moderation coordination weekly.

---

## Immediate actions (next 30 days)

Priority order:

1. **Add Discord invite public în README** (edit main branch): remove "coming soon", add real link.
2. **Set up rule react-gate în #welcome**: bot-driven, mentioned above.
3. **Draft "Cinderpaw Community Guidelines" document** based on Part 2 rules section. Publish on docs.
4. **Recruit 2-3 initial mods din current active Discord members**. Establish rotation.
5. **Write Blog post 1**: "Introducing Cinderpaw" (soft rebrand announcement). Publish end of Q3.
6. **Set up custom Cinderpaw bot v0.1** — auto-delete BYOK keys, welcome flow, mod log to private channel.
7. **Establish moderation policy document** (internal, for mod team) — decision criteria, escalation, appeals.
8. **Announce commitment**: monthly transparency post, quarterly retrospective survey.

Owned by: founder + volunteer community mods (Q3 2026 phase). Community manager hire target: Q1 2027 or when Discord hits 1500 members, whichever first.

---

## Part 9 — Learning from OpenClaw / Peter Steinberger playbook

**Why this section exists**: Cinderpaw literalmente vendored parts din OpenClaw (`FeralAgent/src/vendor/tool-call-repair/` under MIT license) și moștenește multe pattern-uri architectural (subagent delegation, `/compact`, hook registry, guided setup). E natural să învățăm din community-side playbook-ul care a produs 381k+ stars pentru OpenClaw în ~5 luni.

Peter Steinberger (steipete @ GitHub, ex-PSPDFKit founder, acum OpenAI) a construit OpenClaw ca "vibecoded într-o singură noapte" în Nov 2025 și l-a scalat la fastest-growing OSS project prin combinația de factori:
1. **Pre-existing audience** (52k+ followers din PSPDFKit years).
2. **Timing exact** — multi-agent era hot topic, WhatsApp integration hit unique niche.
3. **Voice technical honest** — nu marketing polish, ci "here's what I built, here's what's broken, help me fix it".
4. **Vibe coding as legitimate genre** — declarat public, făcut content despre proces.
5. **Foundation stewardship model** — după OpenAI hire, transferat la independent foundation. Community-owned trust.

### Ce se aplică direct la Cinderpaw

**A. Pre-audience gap — accept reality, don't fake it.**

Steinberger avea 13 ani de track record + 52k followers. Cinderpaw pornește de la ~zero personal-brand audience. Not fixable overnight.

Pattern realistic:
- **Anul 1**: build audience organic prin content technical. Target: 1000-3000 followers X.
- **Anul 2**: audience commited enough că un launch major (Community v1.1) generează 500+ signups organic. Target: 5000-10000 followers.
- **Anul 3**: audience compounded că fiecare release primește engagement natural. Target: 20000+ followers.

**Nu-i overnight. Steinberger a construit 13 ani înainte de OpenClaw moment.**

**B. Solo builder + solo content creator = burnout.**

User quote: "e foarte greu sa faci singur tot ngl, sa fac un fix, sa postez, sa fac un fix, sa postez".

Realitate: **Steinberger NU face totul singur.**
- OpenClaw are ~2000 contributors la 5 luni (per State of the Claw talk). Contributors produc content organic (bug reports, PRs, tutorials, YouTube videos, blog posts) care umple ecosystem-ul.
- Steinberger însuși post frequently DAR content-ul e strategic — teardown-uri lungi lunare, thread-uri viral saptamanal. Nu "1 tweet + 1 fix + 1 tweet" cadence.
- La OpenAI acum, are resurse enterprise (design, marketing, community teams) care handle-uiesc infrastructure. Sub numele lui pare solo, dar backend-ul e populated.

**Realistic model pentru un solo founder cu Cinderpaw:**

1. **Batching agressive** — nu "post + fix + post". În loc de asta:
   - **1 zi/săptămână content mode** — scrii 5-7 tweet-uri drafted + 1 thread lung + 1 blog draft. Publish scheduled sau când e momentul.
   - **4 zile/săptămână build mode** — cod, bug fixes, features. Nu se distrag.
   - **1 zi/săptămână community mode** — reply Discord, GitHub issues, engage cu partners.
   - **1 zi/săptămână off** — nu-i optional, e mandatoriu pentru sustainability. Fără el 3 luni max până burnout.

2. **AI ca co-content-writer** — Cinderpaw însuși poate scrie draft-uri:
   - "Given this audit finding §142, draft-mi un thread X în stil Steinberger technical honest"
   - "Turn my commit log din past week în un blog post outline"
   - Cinderpaw agent care ia audit rundele + release notes + Discord questions și produce prima draft de conținut.
   - Tu editezi + human-voice. **NU postezi AI-writing direct** (community senses immediately, tone off).
   - Reduce content creation timp cu 60-70%.

3. **Community contributions ca content pipeline** (post-Community-launch v1.1):
   - Founding Publishers scriu blog post-uri "How I built agent X" — cross-post pe blog Cinderpaw cu attribution.
   - Bug reporters get credit publicly, poate lead la case study.
   - Users cu use case interesant → interview-format piece (5-question survey → article draft).
   - **Community produce 40-60% din content post-v1.1** dacă infrastructure e set up.

4. **Delegare la Cubby + Paw literalmente**:
   - Paw = CS bot deja. Poate deveni și "community bot" care escaleaza content-worthy conversations la tine.
   - Cubby poate track issues cross-time + produce monthly summary drafts.
   - **Meta-narrativ**: "Cinderpaw's Cubby wrote the changelog for you". Autentic dacă chiar-face-asta.

5. **Renunță la ideal "post every day"** — Steinberger însuși nu postează zilnic. Cadence lui e ~3-5 posts/săptămână, dar quality high. Better 3 posts/săptămână care rezonează decât 10 care pass unnoticed.

### Ce NU face Steinberger (evită și tu)

- **NU** answers negative criticism defensively pe Twitter. Ignore sau mute. Engagement cu negativitate = feeding algorithm.
- **NU** posts "we're excited to announce" corporate-speak. Personal voice always.
- **NU** delete posts când greșește. Owning it e mai puternic decât hiding.
- **NU** face threads-of-threads-of-threads. Un thread cu depth > 3 thread-uri connected superficial.
- **NU** cere retweets, like-farm, follow-farm. Kills organic reach.

### Ce a făcut Steinberger unic care poate NU-i replicable

- **PSPDFKit exit** = $100M+ + 13 ani track record + reputation stabilit. Nu-i copyabil.
- **Timing perfect** — Nov 2025 era moment specific când multi-agent + WhatsApp era topic-hot. Se poate întâmpla să fie moment pentru Cinderpaw, dar nu-l poți force.
- **Vienna dev scene** — network local puternic din PSPDFKit. Depinde de geographic factors.
- **OpenAI acqui-hire** = amplifier post-viral. Rare accident. Nu strategie.

Concluzie realistic: nu vei replica trajectorial Steinberger. Poți învăța pattern-urile lui reproducable (batching, honest voice, community-driven content, foundation stewardship long-term). Restul e specific.

### Aplicație concretă la Cinderpaw în luna 1

Aleg 3 lucruri de făcut din Steinberger playbook, ignore restul:

**Lucru 1 — Un blog post lung, honest, technical, primul lună.**

Subject candidat: "Am făcut audit la propriul AI companion. Iată cele 260 buguri pe care le-am găsit."

Formula (Steinberger-adjacent):
- First person, personal voice.
- Data concrete: "10 runde audit, 259 findings, 40 CRITICAL, aici e cel mai grav (§142 sandbox escape) cu code snippet".
- Vulnerability + confidence: "Am făcut greșeli. Iată cele pe care le-am fixat, iată cele care sunt încă în backlog. Iată de ce le-am ratat prima oară."
- Cliffhanger / hook la restul: "Rebrand la Cinderpaw next month — separate post".
- Length ~2500-3500 words.
- Publish la blog Cinderpaw + submit HN (Show HN nu, Ask HN "audited my own AI companion, found 260 bugs — what's your approach?").

Timp de write: ~1 zi focused dacă drafteaza Cinderpaw însuși first, tu editezi.

**Lucru 2 — Twitter thread saptamanal, 12 săptămâni consistent.**

Formula:
- Un thread/săptămână, 5-10 tweet-uri.
- Content vine din: audit findings, rebrand progress, decision docs (ADRs), user Discord conversations interesante, Cubby-Paw meta stories.
- Publicare Marți sau Miercuri 9-11am UTC (optim pentru US + EU tech audience).
- Reply everyone în first 48h post-publish.

12 săptămâni x consistent = ~3 luni. Măsurabil: followers gained, replies received, DMs from potential partners.

Dacă la 12 săptămâni ai < 200 followers gained, revedere strategy. Dacă > 1000, dublează cadence.

**Lucru 3 — Discord public + welcome bot v0.1 (Cinderpaw as bot).**

Fă Discord public în README (5 min job). Cinderpaw Cubby deja există ca bot pe VPS-ul tău. Configure-l cu welcome flow + auto-delete BYOK keys + basic mod log. Dacă Paw deja handle-uiește CS, extend-l cu one command: `/agent-info` care returnează link la agent (post-Community-v1.1).

**Ce NU faci în luna 1**:
- Nu contactezi 20 partneriates simultaneous.
- Nu lansezi Community feature (nu-i built încă).
- Nu creezi Product Hunt account.
- Nu draftezi ToS și Privacy Policy (deferred pending legal counsel Q1 2027).
- Nu recrutezi moderatori formali (Discord < 200 members nu need formal mod tier).

**Priorities check post-lună 1**:
- Blog post 1 published? Y/N.
- 4 Twitter threads shipped? Y/N.
- Discord invite public + 50+ members? Y/N.
- Burnout level 1-10? Sub 6 = OK, peste 7 = trim scope next month.

Adjustare monthly bazat pe metrics reali, nu ambition.

### Cadence pe termen lung — sustainable

**Anul 1 (Q3 2026 → Q3 2027)**:
- Content mode: 1 zi/săptămână.
- Blog cadence: 1 post/lună.
- Twitter cadence: 3-5 posts + 1 thread/săptămână.
- Discord: reply everyone.
- Ecosystem: 2 partnerships attempted /trimestru.
- Burnout risk: MEDIUM. Weekly off day mandatory.

**Anul 2 (Q3 2027 → Q3 2028) — post-Community launch**:
- Content mode: 0.5 zi/săptămână (community produces 40%).
- Blog cadence: 1-2 posts/lună (una scrisă de tine, una de contributors).
- Twitter cadence: same 3-5/săptămână.
- Discord: reply-in-24h SLA vs everyone.
- Ecosystem: 5+ partnerships live.
- Burnout risk: LOWER. Delegation working.

**Anul 3+ (Q3 2028+)**:
- Hire dedicated community manager (Discord > 5000, Community platform > 500 publishers).
- Founder shifts la thought-leadership content only (talks, big blog posts, strategy).
- Content mode: 2h/săptămână.
- Focus long-term direction, less operational.

Above cadences sunt aspirational — real-world adjustment based on your energy + growth reality.

---

## Living document

This strategy updates quarterly în sync cu ROADMAP.md. Community input welcome — publish în docs, allow PR-style edits from `@Contributor` role.

**Note on the OpenClaw section**: added because Cinderpaw explicitly vendored parts of OpenClaw and shares architectural patterns. Learning from adjacent projects e legit + saves reinventing playbook. Cinderpaw NU e OpenClaw fork sau competitor — e project distinct cu positioning diferit (local-first personal AI vs OpenClaw broader agent framework). Coexistență respectuoasă.
