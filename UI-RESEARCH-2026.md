# UI Research — What "majestic AI chat" looks like în 2026

**Date:** 2026-08-20
**Purpose:** honest gap analysis între UI-ul Cinderpaw curent și industry state-of-the-art. Recomandări concrete cu diff.

---

## Methodology

Research prin 3 canale:
1. Real screenshots din Claude, ChatGPT Canvas, Cursor, Warp (verified pattern-uri, nu concept art).
2. Analysis din designers writing despre AI UX (Designpixil "12 patterns", AIUX Playground teardowns, Vercel Design Guidelines).
3. Codebase Cinderpaw actual (frontend audit anterior) + mockup-uri generate anterior din cod.

Am **evitat** concept-art AI-generated (Raycast "holographic UI", Msty stock photos) — arată bine dar mint despre pattern-uri reale. Am rămas la ce useri VĂD zilnic.

---

## 1. Patterns dominante în 2026 AI chat UIs

Din research direct + Designpixil analysis (Aug 2026):

### Pattern A — Artifacts panel separat de conversație

**Cine îl are:** Claude (primul care l-a popularizat, 2024), ChatGPT Canvas (2024), Cursor propose-then-apply (variant), Vercel v0 (preview live), Perplexity (research reports view).

**Ce înseamnă:** conversation stays chat, dar output substantial (cod lung, document, chart, form, interactive tool) render într-un panel dedicat la dreapta care se poate:
- Expand full-screen (hide chat).
- Edit direct (nu doar view).
- Iterate cu comenzi subsequent care update artifact-ul in-place.
- Fork în versioane.

**De ce contează:** "single most copied AI layout decision of the last two years" per Designpixil. Rezolvă problema fundamentală — output lung îngropat în scroll-uri, imposibil de referi rapid.

**Cinderpaw are:** **NU**. Toate output-urile rămân inline în bubble-uri de chat, scroll infinite. Code blocks folosesc `<CodeBlock>` component (existent) dar rămân inline. Fără artifact promotion.

### Pattern B — Model selector integrat în composer, nu în header

**Cine îl are:** Claude (Sonnet 4.6 dropdown în input bar), ChatGPT (model switcher jos-stânga la input), Cursor (model list în composer).

**Ce înseamnă:** dropdown-ul de model NU e în app header sus. E direct în input bar chat, next to send button. Discret, dar accesibil per-turn.

**De ce contează:** switch model per-turn e workflow real. User vrea "răspuns rapid la asta" → Haiku/mini. "Cod complex" → Opus/Sonnet 4. Header-mounted picker forces un click extra + break de focus.

**Cinderpaw are:** `<ModelPill>` în ChatHeader sus stânga + `<FeralModelSelector>` (agents tab), separate dropdown. Nu-i integrat în ChatInput.

### Pattern C — Ultra-slim icon-only sidebar (32-56px) când collapsed default

**Cine îl are:** Claude (30px icon-only sidebar, hover pentru text), Linear (56px collapsed default), Arc Browser (variabile foarte îngust), Cursor (foarte compact).

**Ce înseamnă:** sidebar default e strict iconography, cu tooltip text la hover. Expandă doar când user pin-uiește sau hover cu delay.

**De ce contează:** maximize screen real estate pentru conținut. Un 240px sidebar mereu-vizibil = 15-20% din laptop screen 13" pierdut permanent.

**Cinderpaw are:** 240px expanded default, 56px collapsed opt-in. Sidebar cu icons + text + shortcuts. Prea gras pentru default state 2026.

### Pattern D — Zero chrome overhead

**Cine îl are:** Claude (nu are visible chat title — doar breadcrumb dropdown), ChatGPT (title în URL, not în UI), Vercel v0 (only workspace name).

**Ce înseamnă:** chat title, model info, session metadata — TOATE reduce la breadcrumbs discrete sau tooltips. Header ~40px total, mostly transparent.

**De ce contează:** every pixel-of-chrome = distraction. Cinderpaw's app shell has: sidebar 240px, WinControls 32px, ChatHeader h-12 = 48px, ChatInput ~150px, gradient overlay 32px. Total chrome ~500px vertical + horizontal pe un 1440×900 laptop. Rămân ~500×1200 pentru content actual. Sub 50% util screen.

**Cinderpaw are:** ChatHeader explicit cu ModelPill + chat title truncated. Sidebar always visible. Multiple layer indicators.

### Pattern E — Composer flotant cu shadow, nu fixed rigid

**Cine îl are:** Claude (composer are elevation cu shadow, sits above content), ChatGPT (same), Cursor.

**Ce înseamnă:** input bar are `box-shadow` subtile care semnalează elevation. Content scrolls behind partial. Nu-i "attached la bottom" ci "floats above".

**De ce contează:** psycho-visual — semnalează "action anywhere, not just fixed slot". Reduces feeling că ești în form.

**Cinderpaw are:** ChatInput cu gradient overlay `bg-gradient-to-t from-bg-primary via-bg-primary/95 to-transparent` care mimică fade effect, dar NU has shadow-elevation. Mai flat, mai formal.

### Pattern F — Voice / mic / attach discrete în composer

**Cine îl are:** Claude (mic + waveform direct în input), ChatGPT (mic + paperclip mici), Cursor.

**Ce înseamnă:** utility icons (attach, mic, tools, model) sunt SMALL (~14-16px) și grouped discret pe left side of composer. Send button always right.

**De ce contează:** claritate hierarchy — primary action (send) e evident, secondary utilities disponibile fără distraction.

**Cinderpaw are:** Composer are: paperclip + mic + brain badge + tools popover + context ring + mode toggle + send button. **7 controls în composer**. Cluttered. Multe cu variants (brain has 3 states cu badge diferit).

### Pattern G — Context-aware AI invocation (right-click, hover, inline)

**Cine îl are:** Warp Terminal (right-click block → "Ask Warp AI"), Cursor (Cmd+K inline pe cod), Notion AI (space bar în empty line).

**Ce înseamnă:** AI nu-i doar un chat window separat. E invocabil în context — pe un mesaj anume, un block de output, o selecție.

**De ce contează:** reduce friction. User nu trebuie să copy-paste context în chat, apoi întreabă. Right-click → "explain this" → AI has context automat.

**Cinderpaw are:** **NU**. AI-ul e izolat în chat panel. Nu poți right-click pe un mesaj și zice "expand this" sau "summarize below this point".

### Pattern H — Message actions always-visible pentru important, hover-only pentru secondary

**Cine îl are:** Claude (thumbs + regen visible on assistant messages), ChatGPT (copy + regen inline), Cursor (accept/reject diff always visible).

**Ce înseamnă:** critical actions (regenerate, accept edit) always visible. Secondary (copy, thumbs, share) apar la hover.

**De ce contează:** balance discovery vs. clutter. Cinderpaw hidden-till-hover pentru toate = touch users invisible actions (§F24 audit).

**Cinderpaw are:** ALL actions hover-only (`opacity-0 group-hover:opacity-100`). Touch device UX broken.

### Pattern I — Streaming feedback rich cu structured phases

**Cine îl are:** Claude (thinking indicator distinct de generating), ChatGPT (searching, reading, generating labels), Perplexity (source loading progress).

**Ce înseamnă:** utilizatorul vede stages diferite ale generation: "Thinking...", "Searching web...", "Reading result 3/5", "Generating answer...". Nu doar un spinner generic.

**De ce contează:** long-latency operations (research, tool calls) fără feedback = user gives up. Structured labels rebuild trust.

**Cinderpaw are:** `<StreamingIndicator>` cu `phase: 'thinking' | 'calling' | 'processing'` — bun, dar labels sunt generic. Fără "reading X of Y", fără specific tool progress.

### Pattern J — Density mode-uri opt-in

**Cine îl are:** GitHub (Density: comfortable/cozy/compact), Linear (settings toggle), Notion (font size + spacing settings).

**Ce înseamnă:** power users pot alege compact mode cu spacing redus + typography mai mică. Casual users rămân la comfortable default.

**De ce contează:** Cinderpaw's 240px sidebar + max-w-3xl content + spacing generos = comfortable default. Power user pe 34" ultrawide vrea 4× density.

**Cinderpaw are:** **NU**. Zero density options. Comfortable-only.

---

## 2. Direct comparison: Claude UI (real screenshot 2026) vs Cinderpaw mockup

### Claude (Sonnet 4.6, Aug 2026)

Din screenshot analyzed:
- **Sidebar:** 30-40px icon-only. Icons: +new, chats, projects, artifacts, settings. Zero text vizibil.
- **Chat header:** doar `"How compound interest works"` breadcrumb cu dropdown → chat title.
- **Right side header:** doar `[Share]` button. Nimic altceva.
- **Content:** artifact TAKING OVER most of viewport. Chart interactive, sliders reali, live compute. NO chat bubbles vizibile în artifact view.
- **Composer:** flotant, elevated. Icons: `[+]` (attach) stânga, model selector "Sonnet 4.6 Low" middle-right, mic + waveform icon dreapta. Send button integrat.
- **Footer:** small text "Claude is AI and can make mistakes. Please double-check responses."
- **Palette:** neutru grayscale. Chart colors vibrant (blue + green). Zero brand color în UI chrome.

### Cinderpaw (current mockup + code review)

- **Sidebar:** 240px expanded. Icons + text + shortcut hints. "Feral" logo text. Recent conversations list vizibilă. Version footer.
- **Chat header:** h-12 cu `<ModelPill>` explicit sus stânga + truncated chat title. Drag region for window.
- **Right side header:** WinControls (minimize/maximize/close).
- **Content:** chat bubbles user + assistant, code blocks inline, streaming indicator, mascot perch on composer.
- **Composer:** attached bottom, gradient overlay fade. 7 controls: attach + mic + tools + brain + context ring + mode toggle + send.
- **Palette:** warm terracotta consistent. Brand orange în multiple UI elements. Distinct și memorable dar heavy chrome.
- **Extra elements:** MascotPerch, ToolCallStack bubble, AskUserCard, StreamErrorNotice, ContextRing.

### Gap size

Aproximativ:
- **Chrome/screen ratio**: Claude ~15% chrome, Cinderpaw ~40% chrome.
- **Controls in composer**: Claude 3-4, Cinderpaw 7.
- **Sidebar footprint default**: Claude 40px, Cinderpaw 240px (6× larger).
- **Artifact separation**: Claude has, Cinderpaw doesn't.
- **Context-aware AI (right-click)**: Claude has (in artifact panel), Cinderpaw doesn't.

**Bottom line**: Cinderpaw UI e "modern warm desktop app" — bun standalone, dar față de industry state-of-the-art 2026 e ~2 ani în urmă pe pattern-uri de density și artifacts.

---

## 3. Cinderpaw's actual strengths (nu tot e rău)

Honest — Cinderpaw NU-i behind în tot. Există pattern-uri unde e chiar înainte:

### S1 — Mascot ca live indicator

Mascota pixel-art 22 stări = personality real, rare on AI apps. Claude/ChatGPT sunt sterile-corporate. Cinderpaw are character.

**Verdict**: keep. Enhance în v2 cu per-agent variations (per ADR-0015 R4 mascot procedural).

### S2 — Local-first indicators (ContextRing, BackendBadge, cost tracking)

Tokens local vs cloud, model backend badge, embedding download progress — transparență despre what's running WHERE. Claude nu are asta (obvious — cloud only). Cinderpaw diferentiază correct pe positioning "your machine".

**Verdict**: keep. Amplify în UI ca signal brand.

### S3 — Multi-mode agent/chat toggle

Cinderpaw's `[Agent] [Chat]` toggle în composer semnalează explicit când user vorbește cu chat mode vs. Agent mode (execute tasks). Pattern rar. Cursor's mode select e similar dar mai buried.

**Verdict**: keep. Simplify visual (currently un pic bulky).

### S4 — Voice mode integrated first-class

Waveform + preview + STT + TTS + provider picker toate integrated în composer. Claude are voice dar simpler. Cinderpaw voice UX e mai complete.

**Verdict**: keep. Verify accessibility (§F14 mic leak fix).

### S5 — Warm palette distinct

Toată industry uses cool grays/blues. Cinderpaw warm terracotta = brand differentiator. Un user vede screenshot Cinderpaw peste 100 ChatGPT clones și recunoaște instant.

**Verdict**: keep intact. Nu urma industry-uniform trend.

---

## 4. Recomandări concrete — priorized

### Priority 1 (visible impact, low effort — do first)

**R1 — Slim sidebar default la 56px, expand-on-hover-with-delay**

Change:
```tsx
// Sidebar.tsx line 24-25
export const SIDEBAR_W = 240;             // was default expanded
export const SIDEBAR_COLLAPSED_W = 56;   // was 56, keep

// Change default state:
// stores/ui.ts — sidebarCollapsed defaultare la true
```

Add hover expand cu 400ms delay (evită accidental hovers):
```tsx
<motion.aside
  onMouseEnter={() => setHoverExpanded(true)}
  onMouseLeave={() => setHoverExpanded(false)}
  animate={{ 
    width: (collapsed && !hoverExpanded) ? SIDEBAR_COLLAPSED_W : SIDEBAR_W 
  }}
  transition={{ duration: 0.15, delay: hoverExpanded ? 0.4 : 0 }}
>
```

Impact: recover ~15% screen real estate imediat. Sidebar "pop out" la hover e discovery-friendly.

**R2 — Elimina ChatHeader, mută breadcrumb la top-left**

Change: `ChatHeader` component actual (48px h-12 + ModelPill + title) e replace cu **contextual breadcrumb top-left** ca Claude:

```tsx
// New: Breadcrumb.tsx
export function Breadcrumb() {
  const conv = useConversations(s => s.current);
  return (
    <div className="absolute top-2 left-16 text-xs text-text-muted/60 flex items-center gap-2">
      <span className="truncate max-w-md">{conv?.title ?? 'New chat'}</span>
      <ChevronDown size={11} className="text-text-muted/40" />
    </div>
  );
}
```

Model selector devine internal la composer (see R3).

Impact: recover 48px vertical + reduce visual noise. Chat feels more like Claude.

**R3 — Model selector integrat în composer, jos-right lângă send**

Change: `<FeralModelSelector>` mutat din agents header în ChatInput bottom-right:

```tsx
// ChatInput.tsx — jos right cluster:
<div className="flex items-center gap-2">
  <ContextRing />
  <ModelPickerCompact />   {/* NEW — dropdown text "Claude 3.5" */}
  <ModeToggle />
  <SendButton />
</div>
```

`ModelPickerCompact` = mic text button "Sonnet 4.6" cu dropdown la click. Vezi Claude screenshot pattern.

Elimină `<ModelPill>` din breadcrumb.

Impact: model switch per turn devine natural, header simplify.

**R4 — Fix contrast + hover-only actions (audit findings §F1, §F2, §F24)**

Apply fixes deja documented în frontend audit:
- Palette adjustments pentru WCAG AA (§F1)
- `text-white` → `text-primary-foreground` pe bg-brand (§F2)
- `@media (hover: hover)` guard pentru hover-only actions (§F24)

Impact: legal compliance + touch UX repaired.

### Priority 2 (medium effort, high value)

**R5 — Artifacts panel (JOCUL principal)**

Introduce concept nou: **artifact promotion**. Când assistant returnează:
- Code block > 50 lines
- Markdown table > 5 rows
- SVG / image
- Tool result cu structured data
- File that was written

...UI promotes-l la un panel dedicat pe right side (30-40% width).

Design:
```tsx
// New: ArtifactPanel.tsx
export function ArtifactPanel({ artifact }: { artifact: Artifact }) {
  return (
    <aside className="fixed right-0 top-0 bottom-0 w-[40%] bg-bg-surface border-l border-border-subtle flex flex-col">
      <header className="h-10 px-3 flex items-center justify-between border-b">
        <span className="text-xs text-text-muted truncate">{artifact.title}</span>
        <div className="flex gap-1">
          <IconButton icon={<Expand />} aria-label="Fullscreen" />
          <IconButton icon={<Download />} aria-label="Download" />
          <IconButton icon={<X />} aria-label="Close" onClick={() => useUI.getState().closeArtifact()} />
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        {/* Render artifact based on type: code / table / svg / etc. */}
        <ArtifactRenderer artifact={artifact} />
      </div>
      <footer className="h-8 px-3 flex items-center gap-2 border-t text-xs">
        <span className="text-text-muted">Iterate:</span>
        <input placeholder="ask a follow-up about this artifact" className="flex-1 bg-transparent" />
      </footer>
    </aside>
  );
}
```

Trigger conditions în MessageItem:
```tsx
// If message contains promotable content, show inline preview + "Open in panel" button
{promotable && (
  <button onClick={() => useUI.getState().openArtifact(artifact)}>
    <Sparkles size={12} /> Open in artifact panel
  </button>
)}
```

State în UI store:
```ts
export interface UIStore {
  ...
  activeArtifact: Artifact | null;
  openArtifact: (a: Artifact) => void;
  closeArtifact: () => void;
}
```

Content main area adjustă cu `paddingRight: activeArtifact ? '40%' : '0'`.

Impact: MAJOR. Artifact pattern = single biggest UX unlock din 2024. Cinderpaw ridică la Claude parity. Este cel mai important design change în întreg document-ul ăsta.

**R6 — Context-aware AI invocation (right-click, hover menu)**

Right-click pe orice message: `Ask Cinderpaw about this / Summarize / Translate / Explain`.

Right-click pe code block: `Explain / Test / Refactor / Debug`.

```tsx
// New: MessageContextMenu.tsx via Radix ContextMenu primitive
<ContextMenu>
  <ContextMenuTrigger asChild>
    <MessageItem message={m} />
  </ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => askCinderpaw(`Explain: ${m.content}`)}>
      <Sparkles size={12} /> Ask Cinderpaw about this
    </ContextMenuItem>
    <ContextMenuItem onClick={() => summarize(m.content)}>
      Summarize
    </ContextMenuItem>
    ...
  </ContextMenuContent>
</ContextMenu>
```

Impact: reduce friction copy-paste. Aliniat cu Warp AI pattern.

**R7 — Streaming indicator cu specific labels (nu doar "Thinking")**

Extend `<StreamingIndicator>` cu sub-phase indicators:
```tsx
// From backend, emit specific events:
// - 'searching:web' with query
// - 'reading:result 3 of 5' with url
// - 'calling:read_file' with path
// - 'thinking' fallback

<StreamingIndicator>
  {phase === 'searching:web' && `Searching: "${query}"`}
  {phase === 'reading:result' && `Reading ${i}/${total}: ${truncate(url, 30)}`}
  {phase === 'calling:tool' && `${toolName}(${mainArg})`}
  ...
</StreamingIndicator>
```

Impact: user knows WHAT AI is doing during 30s+ operations. Trust builder.

### Priority 3 (lower urgency, polish)

**R8 — Density mode toggle în settings**

`Comfortable | Compact | Cozy` cu 3 preset-uri de spacing + font size:
```css
[data-density="compact"] {
  --spacing-tight: 0.5rem;
  --spacing-base: 0.75rem;
  --font-message: 13px;
}
```

Applied la MessageList + Sidebar + ChatInput. Power users satisfied.

**R9 — Split conversation view (Cursor pattern)**

Advanced: 2 chats side-by-side. Split view pentru compare responses across models.

**R10 — Focus mode (temporary hide sidebar + chrome, ESC restore)**

Cmd+Shift+F: full-screen chat, sidebar hidden, chrome minimized. Focus writing mode. ESC restore.

**R11 — Diff view for assistant edits**

When Cinderpaw agent edits a file via `write_file` tool, show git-style diff inline (not just "edit completed"). Similar Cursor.

---

## 5. Recomandare vs. what NOT to change

**KEEP intact:**
- Mascota pixel-art (asset unic, brand-defining)
- Warm terracotta palette (differentiator)
- Local-first indicators (ContextRing, BackendBadge, embedding download)
- Voice mode integration (mai avansat decât Claude)
- Multi-agent toggle (unique)
- Onboarding wizard flow (bine designed)

**REPLACE:**
- Sidebar default expanded → collapsed cu hover-expand (R1)
- ChatHeader dedicat → breadcrumb top-left minimal (R2)
- ModelPill în header → ModelPickerCompact în composer (R3)

**ADD:**
- ArtifactPanel pentru output substantial (R5) — **cel mai important**
- Context-aware AI invocation right-click (R6)
- Structured streaming labels (R7)

**FIX (audit references):**
- Contrast WCAG AA fails (§F1, §F2)
- Hover-only actions pentru touch (§F24)
- localStorage keys pentru rebrand (§F12)
- Motion prefers-reduced (§F18)

---

## 6. Implementation cost estimate

**R1-R4 (Priority 1)** — 2-4 zile front-end work. Zero architecture change. Pure CSS/component refactor.

**R5 (Artifact panel)** — 1-2 săptămâni. New state management, new components, needs backend signal "this output should promote" (poate LLM classifier or heuristic pe content size).

**R6-R7 (Context AI + streaming labels)** — 3-5 zile combined. R6 needs Radix ContextMenu + new tool wrapper. R7 needs backend event vocabulary expansion.

**R8-R11 (Priority 3)** — post-v1.0 GA. Nice-to-have.

**Total pentru "industry parity 2026"**: ~1 lună focused frontend work.

---

## 7. Risk of over-copying industry pattern

Reminder: Cinderpaw are voice distinct (warm, local-first, anti-corporate). Nu chop off ce te face different:

- Nu abandona warm palette pentru gray minimalism.
- Nu abandona mascota pentru "professional" sterile look.
- Nu ascunde local-first indicators pentru simplicity.
- Nu remove mode toggle pentru "just one chat mode".

Industry pattern-uri sunt utile pentru density + patterns care produce user friction. Nu pentru VOICE.

Un blog post decent să scrii post-refactor: **"How we adopted Claude's artifact pattern without losing our warm identity"** — content-viable, pentru community.

---

## 8. Living document

Update quarterly cu new industry patterns observed. Trackable diff between industry state și Cinderpaw progress.
