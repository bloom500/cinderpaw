# Voice STT Provider Choice (Local vs Cloud) — Design Spec

**Date:** 2026-06-18
**Status:** Implemented (card + long-press + Groq cloud STT). Settings → Voice
control deferred — long-press re-opens the card, which covers switching for now.
**Scope:** Let the user choose, on first mic use, between local whisper STT and a
cloud STT provider (Groq `whisper-large-v3`). Builds on the implemented voice
messages feature (`2026-06-17-voice-messages-design.md`). TTS / voice replies and
real-time Call mode remain out of scope.

## Summary

Local whisper (`small`, CPU, greedy) is fast-ish and private but uses ~0.5 GB RAM
and is noticeably weak on non-English (observed: Romanian mistranscriptions).
Cloud `whisper-large-v3` via Groq is materially more accurate and free (generous
tier), at the cost of **privacy** (audio leaves the device) and **needing an API
key**.

Rather than force one tradeoff, present a one-time choice card the first time the
user taps the mic: **Local (private, on-device)** vs **Cloud (Groq, more
accurate)**. The choice is persisted and changeable later in Settings → Voice.

## Locked decisions

- **First cloud provider:** Groq `whisper-large-v3` only. (NVIDIA NIM considered
  and rejected for now: its audio REST API needs base64-in-JSON or a separate
  asset upload + specific formats — more friction for the same model.)
- **Key storage:** reuse the existing BYOK keychain. Groq is already a BYOK
  provider (`byok_get("groq")` / `byok_set("groq")`); no new secret store.
- **Card trigger:** opens on the first mic click while `sttProvider === null`.
  After a choice is made a normal tap records; **long-press (press-and-hold) on
  the mic re-opens the card any time** to switch provider. Also changeable in
  Settings → Voice.
- **Missing-key UX:** when the user picks Cloud without a Groq key, the card shows
  an **inline key field** + a "get a free key" link, saving via `byok_set("groq")`.
- **Local sampling:** stays **Greedy** (speed). Accuracy is the cloud option's job.
- **Cloud is not feature-gated** on `whisper` — it works in any build, even one
  compiled without the local whisper kernels.
- **Privacy:** the Cloud option states plainly that audio leaves the device.

## State & persistence

- `useUI` gains `sttProvider: 'local' | 'groq' | null` (persisted). `null` = not
  chosen yet → triggers the card on first mic click.
- A setter `setSttProvider(p)` persists the choice.

## The card (`VoiceProviderCard`)

Shown as a modal/popover on first mic click. Two options:

- **Local (Whisper)** — "Private · 100% on-device · free. Uses ~0.5 GB RAM and is
  less accurate, especially for non-English."
- **Cloud (Groq · whisper-large-v3)** — "More accurate · free tier. ⚠️ Your audio
  leaves your device." When selected and no Groq key is stored, reveal an inline
  password field for the key + link to `https://console.groq.com/keys`.

On confirm:
- persist `sttProvider`;
- if `groq` and a key was entered, `byok_set("groq")` via the BYOK save path;
- proceed to start recording (the click that opened the card also starts recording
  once a choice is made), or simply close and let the user tap again — **decided:
  close the card and let the next tap record**, to keep the flow obvious.

## Transcription routing

`transcribeVoiceBlob` branches on `sttProvider`:

- `local` → existing path: decode to 16 kHz PCM → `transcribe_audio(pcm, size)`.
- `groq` → `tauri.voice.transcribeCloud(audioPath, 'groq')` (no PCM decode needed).

The optimistic "Transcribing…" bubble and the agent-vs-chat routing
(`existingUserId`) are identical for both providers — only the transcription call
differs.

`ensureWhisperModel(size)` is called **only when `sttProvider === 'local'`**, so a
cloud user never downloads the 466 MB local model.

## Backend (Rust)

New command:

```
transcribe_audio_cloud(audio_path: String, provider: String) -> Result<String, String>
```

- Reads the recorded file from `audio_path` (already persisted by
  `save_voice_blob`).
- Looks up the key via `byok_get(provider)`. Missing key → `Err("stt-no-key")`.
- For `groq`: POST multipart `file` + `model=whisper-large-v3` to
  `https://api.groq.com/openai/v1/audio/transcriptions` with
  `Authorization: Bearer <key>`. The file is sent as-is (webm/opus — Groq accepts
  it). Parse and return the JSON `text` field (trimmed).
- Network / non-2xx → `Err("stt-cloud-failed")` (frontend humanizes it).
- Not behind `#[cfg(feature = "whisper")]`.

The base URL is derived from the existing BYOK `Provider::Groq` config so the
endpoint stays in one place.

## Error handling (frontend)

In `ChatInput`'s voice catch (the optimistic bubble is removed on any failure):

- `stt-no-key` → reopen the card on the Cloud option with the key field focused.
- `stt-cloud-failed` → toast "Cloud transcription failed — check your connection
  or key" (new i18n key).
- existing `model-missing` / `voice-unavailable` / empty-transcript toasts unchanged.

## Settings

Settings → Voice gains:
- a provider toggle (Local / Cloud) bound to `sttProvider`;
- Groq key status (set / not set) with an add/replace affordance reusing the BYOK
  key flow.

## Components / files (anticipated)

- `frontend-react/src/stores/ui.ts` — `sttProvider` + setter (persisted).
- `frontend-react/src/components/chat/VoiceProviderCard.tsx` — the choice card.
- `frontend-react/src/components/chat/ChatInput.tsx` — gate first-click on the
  card; gate `ensureWhisperModel` on local.
- `frontend-react/src/hooks/useSendMessage.ts` — `transcribeVoiceBlob` branch.
- `frontend-react/src/lib/tauri/index.ts` — `voice.transcribeCloud`.
- `frontend-react/src/lib/i18n.ts` — card copy + cloud-failure string (en + ro).
- `src-tauri/src/lib.rs` — `transcribe_audio_cloud` command + registration.
- Settings page — Voice provider control.

## Out of scope

- Additional cloud providers (NVIDIA NIM, OpenAI, Deepgram, ElevenLabs). The
  command takes a `provider` arg so adding more later is incremental.
- TTS / spoken replies. Real-time Call mode.
- Local accuracy tuning (beam search) — explicitly reverted in favour of the cloud
  option.
