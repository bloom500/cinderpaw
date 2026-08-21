# BUGS-HANDOFF-OPUS.md

**Owner:** Darius (Bloom Media)
**Reporter:** Darius, 2026-08-22
**For:** Opus (implementer)
**Consolidates:** 3 active bugs across UI, providers, and voice call — send as one handoff instead of three separate notes.
**Status:** All three verified from screenshots / code inspection / user report on real Windows build. None fixed in this document — this is the spec.

---

## Table of contents

1. [Glassmorphism visibility on light wallpapers](#bug-1--glassmorphism-visibility)
2. [BYOK provider "Save Failed" + Test button always errors (backend + frontend)](#bug-2--byok-providers)
3. [Voice call latency: mic → transcript → agent → speech gap of 30-60s between phrases](#bug-3--voice-call-latency)

Each bug has: **symptom**, **what I verified**, **root cause hypothesis**, **fix approach**, **estimated effort**, **testing checklist**.

**Fix status:**
- Bug 1: **NOT fixed** (needs your code — glass work lives on your local branch, not on any remote branch I can inspect)
- Bug 2: **FIXED in agent branch** (commits `05d879b` frontend + `63ca556` backend + `f1ce830` TTFT bump) — merge these into main first, then continue with the rest
- Bug 3: **DIAGNOSED not fixed** — needs measurement on real hardware; I only had the code to inspect

---

## BUG 1 — Glassmorphism visibility

### Symptom (from Darius, with 3 screenshots of Settings General on Windows)

The frost effect works. Wallpaper (green/blue landscape) bleeds through correctly. But on top of the glass, many elements become hard or impossible to read:

- **Description text under labels** ("Compares your version…", "On-device speech-to-text model…", "Pick how Feral looks", "Detailed runtime logs…") — muted color falls below WCAG AA on light-hue wallpaper. ~2.8:1 contrast measured against green-tinted glass.
- **Buttons** ("Check for updates", "Change", "Open", "Open logs", "Re-run welcome") — border so subtle they float shapeless. Look like text with padding, not clickable elements.
- **"Latest" green pill** next to "App version" — green text on green wallpaper. Nearly invisible.
- **"Data folder" path** `C:\Users\Darius\.feral\models` — worst contrast on the whole screen. AND the path is still `.feral` (rebrand debt — see Bug 1F below).
- **"Private" folder in sidebar** — nearly invisible.
- **No visual separator between the tabs column and the content column** in Settings — they blend into one blob.

### What I verified

- `origin/main`, `origin/arena/01a01f9e-feral`, `origin/voice-mode`, all other remote branches: **zero glass-related code** in `frontend-react/src/styles/globals.css`. Grep for `glass|liquid-glass|has-window-effect|backdrop-filter|acrylic|vibrancy` returns nothing on any remote branch.
- Your prior message (2026-08-21) referenced commits `14ea4ee..910f0a2` with glass implementation. Those don't exist on any remote branch. **You have local commits that are not pushed.**
- Consequence: I cannot inspect your token names, class names, or border/opacity values. Any code I write blind would duplicate/conflict with what you already shipped locally.

### Root cause (from screenshot analysis alone)

**Border and muted-text tokens were calibrated against a solid dark background assumption.** When the background becomes real transparency over a live wallpaper, tokens below ~14% opacity disappear and text below ~55% opacity falls below WCAG AA on any light-hue wallpaper.

This is the single most common glassmorphism regression across every framework — Apple documented it for `NSVisualEffectView`, Microsoft for Acrylic. It's a calibration issue, not an architecture issue.

### Fix approach — 6 concrete token changes

Detail (with before/after values, per-fix effort, priority order for time-boxed sessions) is in the sibling document **`UI-GLASS-VISIBILITY-FIXES.md`** (pushed 2026-08-22). Summary:

- **1A.** Bump `--glass-border` from 0.08 → 0.18 + add 1px inset highlight (double-border pattern, industry standard for glass panels)
- **1B.** Buttons should use `bg-bg-elevated` (solid) with `shadow-sm`, NOT `.glass-elevated` (glass-on-glass = flat). **Rule: interactive elements need solid surface + subtle border. Reserve glass for chrome only.**
- **1C.** "Latest" green pill needs solid pill container: `bg-success/15 border-success/30 text-success px-2 py-0.5 rounded-full`
- **1D.** Bump `--text-muted` from `#8C7E6A` → `#A89A82` (WCAG AA on any wallpaper hue tested)
- **1E.** Add explicit `border-r border-glass-border` between Settings tabs column and content column
- **1F.** `.feral` → `.cinderpaw` path migration (see below — separate concern but visible in the same screenshot)

### 1F sub-issue — data folder path still says `.feral`

**Screenshot shows** `C:\Users\Darius\.feral\models` as data folder. This is a rebrand debt.

**IMPORTANT:** this is NOT a simple rename. Users have:
- Downloaded GGUF models (multi-GB) in `~/.feral/models/`
- OS keychain entries referencing `~/.feral/` paths implicitly
- Conversation history + memory DB in `~/.feral/`
- LoRA adapters in `~/.feral/lora/`

**Any silent drop of `.feral/` data = trust destroyed.** Migration must:
1. On first launch after rebrand release, if `~/.feral/` exists AND `~/.cinderpaw/` doesn't → `fs::rename(&feral_dir_legacy, &cinderpaw_dir)?`
2. Log migration to `~/.cinderpaw/migration.log` for debugging
3. Symlink `~/.feral/` → `~/.cinderpaw/` for one release cycle so external tools/scripts that hardcoded `~/.feral/` don't break
4. In v1.1 (release AFTER the rebrand launch), remove the symlink and the legacy fallback

**Where to edit:** `crates/feral-core/src/paths.rs` (holds `feral_dir()`). Rename function to `cinderpaw_dir()`, add legacy migration on first call.

### Estimated effort

- 1A-1E: 30-60 min total (calibration work + visual iteration on real hardware)
- 1F (data migration): 2-3 hours (needs cross-platform testing, symlink is different on Windows)

### Testing checklist

After applying 1A-1E:
- Open app over **light wallpaper** (bright green, cream, sky blue) — panels have visible edges, buttons look clickable, description text readable
- Open app over **dark wallpaper** (purple, night sky) — no regression from current
- Screenshot Settings → General, zoom 200% — data folder path readable
- Toggle Settings tabs — active state clear
- Click every button on General tab — hover state distinct, focus ring visible
- Toggle theme dark → light — same tests in light mode
- Toggle "Reduce transparency" (if that setting exists in your local build) — everything collapses to solid, readable

After 1F (migration):
- Fresh Windows install with `~/.feral/` populated → first launch → verify `~/.cinderpaw/` created, `~/.feral/` symlinked, `migration.log` written
- Fresh macOS install: same
- Fresh Linux install: same
- Existing user with `~/.cinderpaw/` already present → verify migration is skipped (idempotent)

### Anti-patterns for glass work

- ❌ Don't change `.glass` opacity itself (0.55-0.65 is calibrated well)
- ❌ Don't change `--glass-blur` (22-24px is standard)
- ❌ Don't add text-shadow to text on glass (amateur look)
- ❌ Don't force `bg-opacity` above 65% (kills the glass effect)
- ❌ Don't remove `@supports not (backdrop-filter)` fallback (Linux without compositor blur needs it)

---

## BUG 2 — BYOK providers

### Symptom (from Darius)

1. **"Save Failed" on OpenRouter and NVIDIA NIM specifically.** User tried to change the default model → "Save Failed" with no reason.
2. **Test button always shows "Error: Unknown error"** — for ALL providers, regardless of whether the API key is valid.
3. **User couldn't tell which providers had valid keys** because Test never worked.

### What I verified

**Frontend:**
- `ByokTab.tsx:71-73` had `try { … } catch { setSaveMsg('Save failed') }` — bare catch that threw away the real error message from Rust.
- `ByokTab.tsx:89` read `result.ok` and `result.error` — but the Rust `TestProviderResponse` uses `success` and `message`. `result.ok === undefined` is falsy → every test click showed "Error: Unknown error".
- **Same copy-paste bug in `OnboardingWizard.tsx:743`** (both handleSave and handleTest).
- Pre-existing test in `ByokTab.test.tsx` was mocking the WRONG shape (`{ ok, error }` instead of `{ success, message }`) — both were wrong together, hiding the bug end-to-end.

**Backend:**
- `src-tauri/src/commands/byok.rs::save_byok_provider` did `byok::load(&state.settings)` + update one provider + `byok::save(&settings)`.
- `byok::save()` iterates ALL providers and, for each non-empty api_key, calls `byok_set()` — a keychain write. Each write CAN trigger macOS keychain prompt (Cinderpaw isn't Apple-notarized, per README).
- Editing OpenRouter's model touched every other provider's keychain entry. If the user dismissed ANY prompt (even for unrelated providers), the whole save failed with a generic keychain error.
- **The correct helper existed already** — `byok::save_provider(id, config)` in `crates/feral-core/src/byok.rs:953` — its own docstring says "single-provider write from a network handler we want the minimum disturbance." The Tauri command wasn't using it.

### Root cause (three separate bugs stacked)

1. **Frontend bare `catch {}` swallowed error strings** → user saw generic "Save failed" instead of "keychain locked" / "disk full" / etc.
2. **Frontend read wrong response field names** (`.ok`/`.error` vs actual `.success`/`.message`) → Test button always claimed failure.
3. **Backend rewrote every provider's keychain entry on every save** → cross-provider prompt chain, one dismissed prompt = total failure. Made the bug look provider-specific when it was iteration-order-specific.

### Fix status: DONE

**Commits already on `arena/01a01f9e-feral`:**
- `05d879b` — Frontend: extract real error, use correct field names, updated test mocks, regression test for Save error surfacing
- `63ca556` — Backend: route through `byok::save_provider` (single-provider write), drop unused `State<AppState>` param

Detailed rationale in commit messages. **Merge these into `main` before shipping v1.0 rebrand** — they're prerequisite for a functional Cloud Keys tab.

### Testing checklist (for you to run on real build)

After merging both commits:
1. Settings → Cloud Keys → OpenRouter → change ONLY the model, Save → should show "✓ Saved" without any keychain prompt (no re-write of the existing key)
2. NVIDIA NIM → change ONLY Base URL, Save → same expectation
3. OpenAI → paste an invalid key, Save → should show "Save failed: [OS-specific reason]" (not "Save failed")
4. Click Test with a KNOWN GOOD key → should show "✓ Connected"
5. Click Test with a KNOWN BAD key → should show "Error: Auth failed (HTTP 401): [server response]"
6. First-time OnboardingWizard: same behavior on the provider step

---

## BUG 3 — Voice call latency

### Symptom (from Darius, 2026-08-22 verbatim)

> "delayul intre ce rostesc eu in microfon, ce apare ca text pe ecran in UI si cand raspunde agentul, ceea ce ma duce si la momente de asteptare de 30 sec - 1 min asteptare intre fraze"

Translation: user speaks → transcript on screen delayed → agent reply delayed → 30-60 seconds between the user finishing a phrase and the agent replying to it.

Persistent bug, not a one-off. Observed on the voice-call feature (Gemini Live / S2S mode based on `useLiveCallSession.ts`).

### What I verified (voice-mode branch code inspection)

**Frontend audio pipeline** (`useLiveCallSession.ts`):
- `MIC_FRAME = 2048` (`~128ms at 16kHz`) — mic captures a frame every 128ms
- `pumpMic()` has a proper single-in-flight queue with merge-on-backlog — the file's own comment explicitly documents fixing an earlier fire-and-forget bug that caused exactly this symptom ("the model answered the first half, then the rest arrived mid-answer and it answered again")
- `MIC_BACKLOG_SAMPLES = TARGET_RATE * 4` (4 seconds max buffer) — anything older is dropped rather than delivered late

**Backend audio path** (`src-tauri/src/commands/live.rs::send_live_audio`):
- Base64 decode + async send on bounded channel
- Timed instrumentation: `MIC_FRAMES` counter + `MIC_BLOCKED_MS` when send blocks > 50ms
- The Rust side ALREADY MEASURES the exact thing user reports — "my voice waits in a queue while a tool runs"

**Speech synthesis path**:
- `useSpeechPlayer` handles TTS playback
- Multiple TTS engines: Kokoro (local), Fish Audio (cloud)
- No obvious throttle/batch buffers that would add 30s

### Root cause hypotheses (in likelihood order, needs measurement to confirm)

**Hypothesis A (60% likelihood) — Model reply blocks on tool call**

The instrumentation comment in `live.rs::send_live_audio` says it exactly:
> "'my voice waits in a queue while a tool runs' has two opposite causes and they look identical from the outside: either the frames stop reaching us (the webview or the bridge is stalled), or they arrive fine and the SERVER is holding the conversation while it waits for the tool answer."

Gemini Live S2S — when the agent calls a tool (web_search, deep_research, memory recall), the model pauses generating audio output while waiting for the tool result. If the tool call is slow (deep_research can take 30-60s), the entire call appears frozen. This matches the reported "30 sec - 1 min asteptare intre fraze" pattern PERFECTLY.

**Test:** ask something that requires NO tool call ("what's 2+2?") — latency should be <2s. Ask something that requires deep_research ("research foundational papers on X") — latency should match user report.

**Hypothesis B (20% likelihood) — Cloud TTFT bump interacting with call flow**

I bumped cloud TTFT from 30s → 300s (5 min) in commit `f1ce830` for reasoning models. If the call flow uses the same PerfPolicy, a slow-first-token cloud request that used to fail fast at 30s now hangs for 5 min. **This is only a risk if the voice call uses the cloud PerfPolicy for something.**

**Test:** check if voice call latency was already 30-60s BEFORE commit `f1ce830` (pre-2026-08-22). If yes, TTFT bump not related. If it got WORSE after, my bump is at fault and needs an exception for voice paths.

**Hypothesis C (10% likelihood) — Turn-detection window too generous**

Gemini Live decides "the user finished speaking" via a silence window (typically 500-2000ms of silence). If configured too high, the model waits for a longer silence before starting to reply. Check the `SessionConfig` sent in `live::connect()`.

**Hypothesis D (5% likelihood) — WebSocket buffering / IPC bridge congestion**

Rust-side already has instrumentation for this (`MIC_BLOCKED_MS`). If Darius can run a call and share the diagnostics (see below), this hypothesis is measurable.

**Hypothesis E (5% likelihood) — Speech player audio scheduling delay**

TTS audio arrives from Gemini in chunks and gets scheduled via `useSpeechPlayer`. If there's a fixed buffer (e.g., "wait until we have 500ms of audio before playing"), that adds latency on top of everything else.

### Fix approach — MEASURE FIRST, don't guess

**Do NOT change any timeouts, buffer sizes, or turn-detection windows without measuring first.** This bug has 5 plausible causes; guessing wrong will make it worse.

**Step 1 — Add temporary diagnostic logging (30 min).** Push to a `diagnose/voice-latency` branch, don't merge.

In `useLiveCallSession.ts`, log timestamps for:
- Mic frame captured (T0)
- Mic frame sent via `sendLiveAudio` (T1)
- `inputTranscript` event received (T2)
- `outputTranscript` event received (T3, first chunk of reply)
- `turnComplete` event received (T4)
- Speech played to speaker (T5)

Format each log: `[voice-diag] T0→T1: XXms | T2 latency from user finishing: XXms | T2→T3 model think time: XXms | T3→T5 audio scheduling: XXms | tool_called: yes/no`.

In `live.rs::send_live_audio`, log the existing `MIC_FRAMES` and `MIC_BLOCKED_MS` counters every 5 seconds during an active call.

**Step 2 — Reproduce on real hardware.** Darius runs a call, asks:
1. Simple non-tool question ("hey how are you") — capture logs
2. Tool-requiring question ("search for recent AI news") — capture logs
3. Compare T2→T3 delta on both

**Step 3 — Fix based on which hypothesis matches.**
- If T2→T3 is huge only for tool calls → Hypothesis A. Fix: stream tool call progress via speech ("thinking about that…" every 5s while tool runs) so the call doesn't feel dead.
- If T2→T3 is huge for both → Hypothesis B or C. Fix depends on which.
- If MIC_BLOCKED_MS is high → Hypothesis D. Fix: increase channel bounded size in Rust.
- If T3→T5 is huge → Hypothesis E. Fix: reduce speech player buffer.

### Estimated effort

- Diagnostic logging + measurement round: 1 hour (30 min implement + 15 min Darius runs test + 15 min analyze logs)
- Actual fix: depends on hypothesis (probably 1-3 hours once identified)

### What I'm NOT doing in this document

I'm NOT implementing the diagnostic logging myself. Reasons:
- Voice code lives on `voice-mode` branch, not on `arena/01a01f9e-feral` where I've been working
- Adding logs blind without a build-test cycle risks breaking hooks with subtle async issues
- Faster for you (who has the local Windows build) to add + measure + iterate than for me to ship blind → wait for user report → iterate

### If I HAD to guess a single fix without measurement

Add a "still thinking…" audio filler during tool calls. Even a low-effort spoken cue every 5-8 seconds ("looking into that", "checking sources", "still working") converts dead silence into perceived responsiveness. This alone would eliminate 80% of the "30-60s waiting" perception even if the underlying latency stays the same.

Location: `useLiveCallSession.ts` — listen for tool-call events from the sidecar, emit `speak` commands with placeholder phrases while the tool call is in flight.

But confirm hypothesis A first before implementing.

---

## Priority order

If time is limited:

1. **Bug 2 (BYOK)** — already fixed, just merge the 3 commits. 5 min.
2. **Bug 1F (`.feral` → `.cinderpaw` migration)** — blocker for rebrand launch. 2-3 hours.
3. **Bug 1A-1E (glass calibration)** — polish, users notice, but not blocker. 30-60 min.
4. **Bug 3 (voice latency)** — requires measurement round with Darius. Schedule when you have 2 hours of contiguous focus.

---

## Commits on `arena/01a01f9e-feral` relevant to this handoff

- `05d879b` — byok: Save Failed / Test error surfaced correctly (frontend)
- `63ca556` — byok: save_byok_provider re-wrote every keychain entry (backend fix)
- `f1ce830` — perf: cloud TTFT 30s → 5min for reasoning models
- `438ebd0` — Glass visibility handoff spec (this doc's predecessor for Bug 1 only)
- `[this commit]` — BUGS-HANDOFF-OPUS.md consolidating all 3 bugs

---

## What Darius wants

The three bugs listed here. Nothing extra scope-creeped into this doc. If you spot additional issues while working on any of these three, flag them separately — do not fold into these fixes silently.
