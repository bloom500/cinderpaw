# Voice Messages — Design Spec

**Date:** 2026-06-17
**Status:** Approved (pending spec review)
**Scope:** Voice message input for chat. Real-time "Call" mode is a separate, later spec.

## Summary

Let the user record a voice message in chat. The message appears as a **playable
audio bubble with an animated waveform**. The agent receives the **local
transcription** (whisper.cpp, on-device) as the user turn and replies **in text**.
The transcript is also shown to the user under the bubble.

Aligned with Feral's "local AI" moat: transcription is 100% on-device, no network
except a one-time whisper model download. Target audience includes non-technical
users, so every failure path degrades gracefully to plain text input.

## Locked decisions

- **Sequencing:** voice message now; Call (continuous full-duplex voice + TTS) deferred to its own spec.
- **In-chat representation:** playable audio bubble with animated waveform (not just a text fill).
- **Transcript:** shown under the bubble (WhatsApp/Telegram style).
- **STT engine:** whisper.cpp local via the `whisper-rs` crate, feature-gated like inference.
- **Whisper model acquisition:** `ggml-small` (≈466 MB) downloaded on first mic use, reusing `download_hf_model`. `ggml-base` selectable for low-end machines.
- **Mic UX:** toggle button (tap to start, tap to stop) with a preview step before sending.
- **Agent response:** text (no voice reply in this spec).

## End-to-end flow

1. **Record** — tap mic → `getUserMedia` + `MediaRecorder` capture in the WebView
   (webm/opus). Tap again → stop.
2. **Preview** — a mini voice bubble appears in the input area: play/pause,
   duration, animated waveform, delete, re-record. Nothing is sent yet.
3. **Send** — on Send:
   - decode the blob with WebAudio → resample to **16 kHz mono Float32** (whisper input);
   - persist the original encoded blob to disk via a Tauri command (`voice/` under app data) → returns a path;
   - pass the PCM to Rust `transcribe_audio(pcm)` → text;
   - append a `user` chat message with `content = transcript` plus `voice` metadata
     (`audioPath`, `durationMs`, `transcript`);
   - feed the transcript into the normal inference flow → the agent replies in text.

## Where each part runs

- **Frontend (WebView):** capture, decode + resample, and bubble playback/waveform.
  Doing the audio decode here avoids a heavy audio-decode dependency in Rust.
- **Backend (Rust):** only blob storage, whisper transcription, and whisper model download.

## New modules / units

**Frontend**
- `useVoiceRecorder` hook — wraps getUserMedia/MediaRecorder + state machine
  (`idle → recording → preview`); exposes `{ state, start, stop, blob, durationMs, reset }`.
- `audioToPcm16k` util — blob → Float32Array, 16 kHz, mono.
- `VoiceRecordButton` + `VoicePreview` — placed in the `ChatInput` control row.
- `VoiceBubble` — rendered in `MessageItem`: play/pause, duration, animated
  waveform, transcript underneath.

**Backend (Rust)**
- `transcription.rs` — `whisper-rs`; lazy-load the ggml model; `transcribe_pcm(Vec<f32>) -> String`.
  **Feature-gated** like inference (CPU default; GPU later).
- `save_voice_blob(bytes) -> path` command — stores under app data `voice/`.
- whisper model resolve + download (reuse `download_hf_model`, default `ggml-small`, `ggml-base` optional).

## Data model (backward-compatible extensions)

- **`ChatMessage`** (frontend), new optional field:
  ```ts
  voice?: { audioPath: string; durationMs: number; transcript: string; peaks: number[] }
  ```
  `content` stays the transcript (what the model sees); `voice` marks the message
  as a voice turn and carries the audio + duration for the bubble.
- **`PersistedMessage`** (Rust): `#[serde(default)] voice: Option<VoiceMeta>` with
  `audio_path`, `duration_ms`, `transcript`, `peaks`. `serde(default)` keeps existing
  on-disk conversations loadable.
- **Audio storage:** webm files live on disk under `voice/`, not inline in the
  conversation JSON (blobs are large). Deleting a conversation also deletes its
  voice files.

## Settings

- One setting: whisper model size. Default **`small` ≈ 466 MB** (better RO/EN
  accuracy); `base` ≈ 142 MB selectable for low-end / disk-constrained machines.
  Language = whisper auto-detect (good for RO + EN).

## Waveform

- The waveform is rendered from the decoded PCM (peak buckets) on a canvas.
- **Preview:** static waveform of the recording; the playhead animates during playback.
- **Bubble (in chat):** the `peaks` array is persisted in the voice meta and
  rendered directly; if it's missing (e.g. an older message), recompute from the
  stored audio on first play. Bars animate with playback progress.
- Keep it lightweight — canvas + requestAnimationFrame, no audio-viz library.

## Error handling (graceful — non-technical users are the primary audience)

- **Mic permission denied** → clear toast; text input stays fully functional.
- **Whisper model not downloaded** → first mic tap starts a download with progress
  (reuse existing progress UI); the mic button reflects the downloading state.
- **Recording too short / empty** → discarded silently, no ghost message.
- **Empty transcript** (silence/noise) → keep the bubble, warn, let the user send
  anyway or re-record.
- **Whisper feature not compiled / model corrupt** → mic button hidden or disabled
  with a "voice unavailable" tooltip; the rest of the app is unaffected.

## Testing

- **Rust:** unit test on `transcribe_pcm` with a known short wav fixture → expected
  text (gated on the whisper feature). Backward-compat test: load an old
  conversation with no `voice` field.
- **Frontend:** state-machine test for `useVoiceRecorder`; `audioToPcm16k` test
  (48k → 16k resample, mono downmix); waveform peak-bucketing test.
- **Manual:** record → preview → re-record → send → reload conversation (audio,
  waveform, and transcript persist).

## Out of scope (YAGNI / deferred to Call)

- Continuous / full-duplex voice conversation, barge-in / interruption → Call spec.
- TTS (spoken agent reply) → Call spec.
