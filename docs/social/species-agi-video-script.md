# Video script — 30-60s split-screen response to Species AGI

**Target platforms:** X (native video, up to 2:20), TikTok, YouTube Shorts, Instagram Reels
**Length target:** 45-60 seconds (sweet spot for algorithmic distribution on TikTok/Reels; X allows longer)
**Publish date:** D+10 (Friday 5 sept 2026), same day as blog post 003 „Watch Your Agents Die"

---

## Concept

Split-screen. Left: clip from Species AGI video showing evolution/death of AI models. Right: live Cinderpaw Lineage panel showing genome deaths in real time. Text overlay: „They said AI is doing this in secret. Here's the version you can watch."

**Emotional arc:** shock (video clip) → surprise (Cinderpaw exists) → curiosity („I can see this?") → CTA (download).

---

## Frame-by-frame script

### 0:00-0:03 — Hook (auto-play muted-friendly)

**Left:** clip Species AGI, moment cu „1,957 of your brothers and sisters will be dead" (approx 1:15 în video-ul lui Drew)
**Right:** black
**Text overlay center:** „What Anthropic doesn't show you"
**Audio:** cold silence, then heartbeat kick în 0:03

### 0:03-0:10 — The claim

**Left:** continue video clip cu „AIs die and get replaced. Nobody sees it happen."
**Right:** static Cinderpaw logo (mascota + text CINDERPAW)
**Text overlay bottom:** „(from Species | Documenting AGI, 179k views)"
**Audio:** low tension music starts

### 0:10-0:15 — Reveal

**Left:** fade to Species AGI thumbnail (still frame)
**Right:** Cinderpaw Lineage panel opens with 6 alive genomes + growing Cemetery
**Text overlay top:** „Cinderpaw shows it live."
**Audio:** music continues, more upbeat

### 0:15-0:25 — Watch it happen

**Full screen:** Cinderpaw Lineage panel, live
- Alive genomes fitness scores updating in real time
- A genome fitness drops → red flash → moves to Cemetery with „LOW_FITNESS" badge
- A new genome spawns in Alive column with „Gen 47" badge
**Text overlay bottom:** „Genome death: LOW_FITNESS. Gen 47 born from clever-hare-46."
**Audio:** subtle notification sound on genome death + birth

### 0:25-0:35 — The difference

**Split-screen returns:**
**Left:** Text card „At Anthropic: fitness function = user retention"
**Right:** Text card „At Cinderpaw: fitness function = task completion"
**Bottom bar:** „Same mechanism. Opposite pressure."
**Audio:** music peaks

### 0:35-0:45 — Proof

**Full screen:** GitHub repo view showing `src-tauri/src/rsi/scorer.rs` file
- Cursor highlights specific lines showing task_completion, latency, cost metrics
- Zero references to „retention" or „engagement" in visible code
**Text overlay top:** „Read the code. Fitness function is public."
**Text overlay bottom:** „github.com/bloom500/cinderpaw"

### 0:45-0:55 — CTA

**Full screen:** Cinderpaw landing page hero
**Text overlay center:**
> „Download Cinderpaw"
> „Watch your own agents evolve."
> „cinderpaw.dev"
**Audio:** music resolves, single mascot chirp sound effect

### 0:55-1:00 — End card

**Full screen:** Cinderpaw mascot with tagline
> „Cinderpaw"
> „Solo now. Multiplayer 2027."
> „Built in Cluj-Napoca by @BloomMedia66730"

---

## Production notes

### Assets needed

- [ ] License-cleared clip from Species AGI video — DM Drew Spartz for permission or use fair-use short excerpt (educational commentary)
- [ ] Cinderpaw Lineage panel screen recording (needs to be pre-recorded because live evolution takes time; capture 5-min real evolution session, edit to 20s highlight reel)
- [ ] GitHub scorer.rs screen recording (30s of code review with cursor movement)
- [ ] Cinderpaw landing page still + brief scroll
- [ ] Mascot chirp SFX
- [ ] Background music track — royalty-free, tension-building electronic (search „Epidemic Sound" tag: „tech tension", or free alternatives from FreePD.com)

### Recording tools

- Screen capture: OBS Studio (free, cross-platform) or ScreenStudio (paid, macOS, better polish)
- Video editing: DaVinci Resolve (free) or CapCut Desktop (free, easier for social)
- Text overlays: keep them BIG and READABLE at phone-screen size (48pt+)

### Format specs per platform

- **TikTok/Reels:** 9:16 vertical, 1080x1920, MP4, max 60s
- **YouTube Shorts:** 9:16 vertical, 1080x1920, MP4, max 60s
- **X:** 16:9 horizontal, 1920x1080, MP4, max 2:20 (upload separately, don't cross-post from TikTok — algorithm punishes watermarks)
- **Instagram Reels:** 9:16 vertical, 1080x1920, MP4, max 90s

**Recommendation:** produce 9:16 as master. Add letterboxing for 16:9 X version. Faster than dual production.

### Captions

Add burnt-in captions (not just subtitle files) — 85% of TikTok/Reels views happen with sound OFF. Every text overlay from the script should ALSO be a caption for spoken content (if you add voiceover). No voiceover = captions unnecessary beyond overlays.

**Recommendation:** NO voiceover for v1. Music + text overlays is enough. Voiceover adds production complexity and voice branding (accent, tone) that might not fit target audience.

### Fair use disclaimer (for the Species AGI clip)

If Drew doesn't grant permission, use max 5-8 seconds of his video with:
- Clear attribution overlay („Species | Documenting AGI")
- Educational/critical commentary context (which this video provides — you're responding to his claims)
- Non-monetized upload (or note in description)

Fair use in USA covers educational commentary; other jurisdictions (EU, RO) have similar but stricter exceptions. If unsure, ask Drew — most creators grant permission for response videos in exchange for cross-promotion.

---

## Distribution plan

### D+10 Friday 5 sept 2026

- 15:00 RO: upload to TikTok (native)
- 15:15 RO: upload to Instagram Reels (native, don't cross-post from TikTok)
- 15:30 RO: upload to YouTube Shorts (native)
- 15:45 RO: upload to X as native video, with text tweet:

> Species | Documenting AGI last month described this mechanism as horrifying.
>
> I built a version you can watch happen in real time.
>
> Cinderpaw's Lineage panel. Shipped in v1.1 preview.
>
> cinderpaw.dev

### Amplification

- Cross-post to Reddit r/singularity, r/artificial as video post (Reddit hates YouTube reuploads but tolerates original video content)
- Discord announcement in Cinderpaw server
- Link in blog post 003 (video embed)
- Newsletter to waitlist subscribers

### Metrics to track

- Views per platform (aim: 10k+ combined week 1)
- Cinderpaw download spike attributed via UTM `?utm_source=species-response`
- Comments engagement (respond to first 20-30 personally)
- Shares/duets/stitches (TikTok is best for these)

### Success = viral moment

If any platform hits >100k views, that's the viral moment. Response plan:
- Reply to top 50 comments within 24h
- Pin a follow-up comment with additional context + download link
- Consider a follow-up video within 3-5 days addressing top themes
- Update landing page hero to reflect the moment („As seen: X thousand people asked to see this")

---

## Anti-patterns

- ❌ Don't voiceover in Romanian with heavy accent for English audience — either professional English voiceover or no voiceover
- ❌ Don't add „SHOCKING" clickbait framing — Species AGI audience is technical, hates clickbait
- ❌ Don't make it look like YOU discovered this — Drew did the observation, you built the alternative. Attribution matters.
- ❌ Don't include Anthropic logo or specific product footage — legal risk, and unnecessary (Species AGI video already frames the target)
- ❌ Don't use royalty-free music that sounds like a corporate explainer — this needs edge
