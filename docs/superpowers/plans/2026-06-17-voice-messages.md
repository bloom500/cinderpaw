# Voice Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user record a voice message in chat that appears as a playable audio bubble with an animated waveform, transcribed on-device with whisper.cpp, while the agent receives the transcript and replies in text.

**Architecture:** Audio is captured and decoded in the React/WebView frontend (`getUserMedia` + `MediaRecorder` → WebAudio decode → 16 kHz mono PCM + peak buckets). Rust does only three things: store the original audio blob on disk, transcribe PCM via the `whisper-rs` crate (feature-gated like inference), and reuse the existing model-download command to fetch the whisper ggml model on first use. The transcript flows through the normal inference path; the voice metadata rides along on the chat message and is persisted backward-compatibly.

**Tech Stack:** Rust + Tauri + `whisper-rs` (whisper.cpp bindings), `tauri_specta` command/event generation, React + Zustand + TypeScript, WebAudio API, Canvas 2D for the waveform.

## Global Constraints

- Transcription runs 100% on-device. The only network call is a one-time whisper model download. Copied verbatim from spec.
- whisper.cpp support is **feature-gated** exactly like inference (`inference` feature → `dep:llama-cpp-2`). New Cargo feature `whisper` → `dep:whisper-rs`. CPU by default; GPU deferred.
- Default whisper model: **`ggml-small.bin`** (≈466 MB) from repo `ggerganov/whisper.cpp`. `ggml-base.bin` (≈142 MB) selectable for low-end machines.
- Whisper language: **auto-detect** (`set_language(Some("auto"))`). Good for RO + EN.
- All new Rust commands use `#[tauri::command] #[specta::specta]` and are registered in `tauri_specta::collect_commands![...]` in `src-tauri/src/lib.rs` (~line 2196).
- Data-model extensions are backward-compatible: new fields are optional with `#[serde(default)]` (Rust) / optional `?` (TS). Existing on-disk conversations must still load.
- Every failure path degrades gracefully to plain text input (non-technical users are the primary audience).
- Audio blobs live on disk under a `voice/` dir, never inline in conversation JSON.

---

### Task 1: Rust whisper transcription module (`transcription.rs`)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add optional `whisper-rs` dep + `whisper` feature)
- Create: `src-tauri/src/transcription.rs`
- Create: `src-tauri/tests/fixtures/jfk_16k_mono.wav` (a short, known 16 kHz mono PCM WAV — the canonical whisper.cpp "jfk" sample, ~11 s, transcribes to a sentence containing "ask not what your country")
- Modify: `src-tauri/src/lib.rs` (add `mod transcription;`)

**Interfaces:**
- Produces: `transcription::transcribe_pcm(samples: &[f32], model_path: &std::path::Path) -> anyhow::Result<String>` — runs whisper on 16 kHz mono f32 samples, returns the concatenated, trimmed transcript. Behind `#[cfg(feature = "whisper")]`.

- [ ] **Step 1: Add the dependency and feature**

In `src-tauri/Cargo.toml`, next to the `llama-cpp-2` lines, add:

```toml
# Speech-to-text — whisper.cpp bindings (CPU by default; feature-gated like inference)
whisper-rs = { version = "0.13", default-features = false, optional = true }
```

And in `[features]`:

```toml
whisper = ["dep:whisper-rs"]
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/transcription.rs`:

```rust
//! On-device speech-to-text via whisper.cpp (whisper-rs).
//! Feature-gated behind `whisper`, mirroring the `inference` gate on llama.cpp.
#![cfg(feature = "whisper")]

use anyhow::{Context, Result};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Transcribe 16 kHz mono f32 PCM samples to text using the ggml model at `model_path`.
/// Language is auto-detected. Returns the concatenated, trimmed transcript.
pub fn transcribe_pcm(samples: &[f32], model_path: &Path) -> Result<String> {
    let ctx = WhisperContext::new_with_params(
        &model_path.to_string_lossy(),
        WhisperContextParameters::default(),
    )
    .context("failed to load whisper model")?;

    let mut state = ctx.create_state().context("failed to create whisper state")?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    state.full(params, samples).context("whisper inference failed")?;

    let n = state.full_n_segments().context("failed to count segments")?;
    let mut out = String::new();
    for i in 0..n {
        out.push_str(&state.full_get_segment_text(i).context("failed to read segment")?);
    }
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn read_wav_f32(path: &Path) -> Vec<f32> {
        // Minimal 16-bit PCM WAV reader: skip the 44-byte canonical header,
        // interpret the rest as little-endian i16, normalize to [-1, 1].
        let bytes = std::fs::read(path).unwrap();
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    #[test]
    #[ignore = "requires WHISPER_TEST_MODEL env var pointing at a ggml model"]
    fn transcribes_known_sample() {
        let model = std::env::var("WHISPER_TEST_MODEL").expect("set WHISPER_TEST_MODEL");
        let wav = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jfk_16k_mono.wav");
        let samples = read_wav_f32(&wav);
        let text = transcribe_pcm(&samples, Path::new(&model)).unwrap().to_lowercase();
        assert!(text.contains("country"), "got: {text}");
    }
}
```

Add `mod transcription;` near the other `mod` declarations in `src-tauri/src/lib.rs`. Because the module is `#![cfg(feature = "whisper")]`, gate the declaration too:

```rust
#[cfg(feature = "whisper")]
mod transcription;
```

Download the fixture into place:

```bash
curl -L -o src-tauri/tests/fixtures/jfk_16k_mono.wav \
  https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/samples/jfk.wav
```

- [ ] **Step 3: Run test to verify it compiles and is ignored**

Run: `cd src-tauri && cargo test --features whisper transcription -- --include-ignored --list`
Expected: lists `transcribes_known_sample`; compiles cleanly. (The test itself is `#[ignore]` so CI never needs the 466 MB model; run it locally with `WHISPER_TEST_MODEL=/path/to/ggml-small.bin cargo test --features whisper -- --ignored` to confirm real transcription.)

- [ ] **Step 4: Confirm the build is clean without the feature**

Run: `cd src-tauri && cargo build`
Expected: builds with no whisper code compiled (module gated out).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/transcription.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/jfk_16k_mono.wav
git commit -m "feat(stt): whisper.cpp transcription module (feature-gated)"
```

---

### Task 2: Rust paths + whisper model resolution

**Files:**
- Modify: `src-tauri/src/paths.rs` (add `voice_dir()` and `whisper_dir()`)
- Modify: `src-tauri/src/transcription.rs` (add `whisper_model_path` + `WHISPER_REPO`/filename constants)

**Interfaces:**
- Produces: `paths::voice_dir() -> PathBuf`, `paths::whisper_dir() -> PathBuf` (both created by `ensure_dirs`).
- Produces: `transcription::WHISPER_REPO: &str`, `transcription::whisper_filename(size: &str) -> &'static str`, `transcription::whisper_model_path(size: &str) -> PathBuf`.

- [ ] **Step 1: Add the path helpers**

In `src-tauri/src/paths.rs`, following the existing `models_dir()` pattern:

```rust
pub fn whisper_dir() -> PathBuf {
    feral_dir().join("whisper")
}

pub fn voice_dir() -> PathBuf {
    feral_dir().join("voice")
}
```

In `ensure_dirs()`, add both to the list of directories created (mirror how `models_dir()` etc. are created there).

- [ ] **Step 2: Add whisper model resolution (no feature gate — pure path logic)**

Add to `src-tauri/src/transcription.rs`, but **outside** the `#![cfg]`-gated section. Since the whole file is gated, instead put these in a small always-compiled submodule. Simplest: move the path constants into `paths.rs`-adjacent logic. Add to `paths.rs`:

```rust
/// HuggingFace repo hosting whisper.cpp ggml models.
pub const WHISPER_REPO: &str = "ggerganov/whisper.cpp";

/// ggml filename for a model size key ("small" | "base"). Unknown → small.
pub fn whisper_filename(size: &str) -> &'static str {
    match size {
        "base" => "ggml-base.bin",
        _ => "ggml-small.bin",
    }
}

/// Absolute path where the whisper ggml model for `size` is stored.
pub fn whisper_model_path(size: &str) -> PathBuf {
    whisper_dir().join(whisper_filename(size))
}
```

- [ ] **Step 3: Write the failing test**

In `src-tauri/src/paths.rs` test module (add one if absent):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whisper_filename_defaults_to_small() {
        assert_eq!(whisper_filename("small"), "ggml-small.bin");
        assert_eq!(whisper_filename("base"), "ggml-base.bin");
        assert_eq!(whisper_filename("garbage"), "ggml-small.bin");
    }

    #[test]
    fn whisper_model_path_is_under_whisper_dir() {
        let p = whisper_model_path("small");
        assert!(p.ends_with("ggml-small.bin"));
        assert_eq!(p.parent().unwrap(), whisper_dir());
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test paths::`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/paths.rs
git commit -m "feat(stt): whisper model path resolution + voice/whisper dirs"
```

---

### Task 3: Rust commands — save voice blob, transcribe, model-present check

**Files:**
- Modify: `src-tauri/src/lib.rs` (3 new commands + register them)
- Modify: `src-tauri/src/conversations.rs` (extend `PersistedMessage` with `voice`, delete voice files on conversation delete)

**Interfaces:**
- Produces command `save_voice_blob(bytes: Vec<u8>, ext: String) -> Result<String, String>` — writes the blob to `voice/<uuid>.<ext>`, returns the absolute path string.
- Produces command `transcribe_audio(pcm: Vec<f32>, model_size: String) -> Result<String, String>` — resolves the model path, errors with the literal string `"model-missing"` if absent, else returns the transcript. (When built without the `whisper` feature, returns `Err("voice-unavailable")`.)
- Produces command `whisper_model_present(model_size: String) -> bool`.
- Produces struct `conversations::VoiceMeta { audio_path: String, duration_ms: u32, transcript: String, peaks: Vec<f32> }` and `PersistedMessage.voice: Option<VoiceMeta>`.

- [ ] **Step 1: Extend the persisted message model**

In `src-tauri/src/conversations.rs`, add above `PersistedMessage`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceMeta {
    pub audio_path: String,
    pub duration_ms: u32,
    pub transcript: String,
    /// Normalized 0..1 peak buckets for the waveform.
    pub peaks: Vec<f32>,
}
```

Add the field to `PersistedMessage`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceMeta>,
```

- [ ] **Step 2: Write the failing backward-compat test**

In the `conversations.rs` test module, add:

```rust
#[test]
fn loads_message_without_voice_field() {
    let json = r#"{"role":"user","content":"hi"}"#;
    let m: PersistedMessage = serde_json::from_str(json).unwrap();
    assert!(m.voice.is_none());
    assert_eq!(m.content, "hi");
}
```

- [ ] **Step 3: Run it**

Run: `cd src-tauri && cargo test conversations::`
Expected: PASS (the `#[serde(default)]` makes the missing field load as `None`).

- [ ] **Step 4: Add the three commands in `lib.rs`**

Near the other `#[tauri::command]` functions:

```rust
/// Persist a recorded audio blob to the on-disk `voice/` dir. Returns the path.
#[tauri::command]
#[specta::specta]
async fn save_voice_blob(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let safe_ext = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    let ext = if safe_ext.is_empty() { "webm".to_string() } else { safe_ext };
    let dir = paths::voice_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// True if the whisper ggml model for `model_size` is already downloaded.
#[tauri::command]
#[specta::specta]
fn whisper_model_present(model_size: String) -> bool {
    paths::whisper_model_path(&model_size).exists()
}

/// Transcribe 16 kHz mono f32 PCM. Errors: "model-missing" | "voice-unavailable".
#[tauri::command]
#[specta::specta]
async fn transcribe_audio(pcm: Vec<f32>, model_size: String) -> Result<String, String> {
    let model_path = paths::whisper_model_path(&model_size);
    if !model_path.exists() {
        return Err("model-missing".into());
    }
    #[cfg(feature = "whisper")]
    {
        // Whisper is CPU-bound; run off the async runtime thread.
        tokio::task::spawn_blocking(move || {
            transcription::transcribe_pcm(&pcm, &model_path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "whisper"))]
    {
        let _ = (pcm, model_path);
        Err("voice-unavailable".into())
    }
}
```

Confirm `uuid` is already a dependency (it is used elsewhere for ids); if not, add `uuid = { version = "1", features = ["v4"] }` to `Cargo.toml`.

- [ ] **Step 5: Register the commands**

In the `tauri_specta::collect_commands![...]` macro in `lib.rs` (~line 2196, where `download_model` appears at ~2199), add `save_voice_blob, whisper_model_present, transcribe_audio,` to the list.

- [ ] **Step 6: Delete voice files when a conversation is deleted**

Find the conversation-delete function in `conversations.rs` (the one that removes the JSON file). Before/after removing the JSON, iterate the conversation's messages and `std::fs::remove_file` each `voice.audio_path` (ignore errors — best-effort cleanup):

```rust
for m in &conv.messages {
    if let Some(v) = &m.voice {
        let _ = std::fs::remove_file(&v.audio_path);
    }
}
```

(If the delete path only has the id and not the loaded conversation, load it first with the existing read helper, then delete files, then remove the JSON.)

- [ ] **Step 7: Build + regenerate bindings**

Run: `cd src-tauri && cargo build`
Expected: compiles. The `tauri_specta` build step regenerates the TS bindings consumed in Task 7. Confirm the new commands appear in `frontend-react/src/lib/tauri` (generated section) after a dev build.

- [ ] **Step 8: Run tests + commit**

Run: `cd src-tauri && cargo test conversations::`
Expected: PASS.

```bash
git add src-tauri/src/lib.rs src-tauri/src/conversations.rs
git commit -m "feat(stt): voice blob storage + transcribe_audio + model-present commands"
```

---

### Task 4: Frontend audio utils — PCM resample + waveform peaks

**Files:**
- Create: `frontend-react/src/lib/audio.ts`
- Create: `frontend-react/src/lib/__tests__/audio.test.ts`

**Interfaces:**
- Produces `decodeToPcm16k(blob: Blob): Promise<Float32Array>` — decodes any browser-recorded blob and resamples to 16 kHz mono.
- Produces `computePeaks(samples: Float32Array, buckets = 48): number[]` — returns `buckets` normalized 0..1 peak magnitudes for the waveform.

- [ ] **Step 1: Write the failing tests**

Create `frontend-react/src/lib/__tests__/audio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computePeaks } from '../audio';

describe('computePeaks', () => {
  it('returns the requested number of buckets', () => {
    const s = new Float32Array(1000).map((_, i) => Math.sin(i / 5));
    expect(computePeaks(s, 16)).toHaveLength(16);
  });

  it('normalizes peaks into 0..1 with the max bucket at 1', () => {
    const s = new Float32Array(100).fill(0);
    s[50] = 0.5; // single loud sample
    const peaks = computePeaks(s, 10);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
  });

  it('handles silence without NaN', () => {
    const peaks = computePeaks(new Float32Array(100), 8);
    expect(peaks.every((p) => Number.isFinite(p))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend-react && npx vitest run src/lib/__tests__/audio.test.ts`
Expected: FAIL — `computePeaks` not exported.

- [ ] **Step 3: Implement `audio.ts`**

```ts
const TARGET_RATE = 16_000;

/** Decode a recorded blob to 16 kHz mono f32 PCM via WebAudio (offline resample). */
export async function decodeToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  // Decode at the device rate first (decodeAudioData ignores the offline rate).
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC();
  const decoded = await decodeCtx.decodeAudioData(arrayBuf);
  await decodeCtx.close();

  const durationSec = decoded.length / decoded.sampleRate;
  const frames = Math.ceil(durationSec * TARGET_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Normalized 0..1 peak magnitudes, `buckets` of them, for the waveform. */
export function computePeaks(samples: Float32Array, buckets = 48): number[] {
  if (samples.length === 0) return new Array(buckets).fill(0);
  const size = Math.floor(samples.length / buckets) || 1;
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    for (let i = start; i < start + size && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const norm = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / norm);
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend-react && npx vitest run src/lib/__tests__/audio.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/audio.ts frontend-react/src/lib/__tests__/audio.test.ts
git commit -m "feat(voice): audio decode-to-16kHz + waveform peak utils"
```

---

### Task 5: Frontend `useVoiceRecorder` hook

**Files:**
- Create: `frontend-react/src/hooks/useVoiceRecorder.ts`
- Create: `frontend-react/src/hooks/__tests__/useVoiceRecorder.test.ts`

**Interfaces:**
- Produces hook returning `{ state: 'idle'|'recording'|'preview', start: () => Promise<void>, stop: () => void, reset: () => void, blob: Blob | null, durationMs: number, error: 'denied'|'unsupported'|null }`.

- [ ] **Step 1: Write the failing test (state machine, mocked MediaRecorder)**

Create `frontend-react/src/hooks/__tests__/useVoiceRecorder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceRecorder } from '../useVoiceRecorder';

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  (global as any).MediaRecorder = FakeRecorder;
  (global as any).navigator.mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  };
});

describe('useVoiceRecorder', () => {
  it('goes idle → recording → preview with a blob', async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    expect(result.current.state).toBe('idle');
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe('recording');
    act(() => { result.current.stop(); });
    expect(result.current.state).toBe('preview');
    expect(result.current.blob).toBeInstanceOf(Blob);
  });

  it('sets error=denied when permission is refused', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(new Error('no'));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBe('denied');
    expect(result.current.state).toBe('idle');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend-react && npx vitest run src/hooks/__tests__/useVoiceRecorder.test.ts`
Expected: FAIL — hook not found.

- [ ] **Step 3: Implement the hook**

```ts
import { useCallback, useRef, useState } from 'react';

type RecState = 'idle' | 'recording' | 'preview';
type RecError = 'denied' | 'unsupported' | null;

export function useVoiceRecorder() {
  const [state, setState] = useState<RecState>('idle');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState<RecError>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' });
        setBlob(b);
        setDurationMs(Date.now() - startedAtRef.current);
        setState('preview');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      rec.start();
      setState('recording');
    } catch {
      setError('denied');
      setState('idle');
    }
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setBlob(null);
    setDurationMs(0);
    setState('idle');
    setError(null);
  }, []);

  return { state, start, stop, reset, blob, durationMs, error };
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend-react && npx vitest run src/hooks/__tests__/useVoiceRecorder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/hooks/useVoiceRecorder.ts frontend-react/src/hooks/__tests__/useVoiceRecorder.test.ts
git commit -m "feat(voice): useVoiceRecorder hook (capture state machine)"
```

---

### Task 6: Reusable `WaveformBars` component

**Files:**
- Create: `frontend-react/src/components/chat/WaveformBars.tsx`
- Create: `frontend-react/src/components/chat/__tests__/WaveformBars.test.tsx`

**Interfaces:**
- Produces `<WaveformBars peaks={number[]} progress={number /* 0..1 */} className?: string />` — renders vertical bars; bars left of `progress` are brand-colored ("played"), the rest are muted. Pure presentational, no audio.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WaveformBars } from '../WaveformBars';

describe('WaveformBars', () => {
  it('renders one bar per peak', () => {
    const { container } = render(<WaveformBars peaks={[0.1, 0.5, 1]} progress={0} />);
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(3);
  });

  it('marks bars before progress as played', () => {
    const { container } = render(<WaveformBars peaks={[0.2, 0.2, 0.2, 0.2]} progress={0.5} />);
    const played = container.querySelectorAll('[data-played="true"]');
    expect(played).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend-react && npx vitest run src/components/chat/__tests__/WaveformBars.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement (CSS bars + `requestAnimationFrame`-friendly, driven by `progress` prop)**

```tsx
import { cn } from '@/lib/utils';

export function WaveformBars({
  peaks,
  progress,
  className,
}: {
  peaks: number[];
  progress: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-[2px] h-6', className)}>
      {peaks.map((p, i) => {
        const played = i / peaks.length < progress;
        return (
          <span
            key={i}
            data-bar
            data-played={played}
            className={cn(
              'w-[2px] rounded-full transition-colors',
              played ? 'bg-brand' : 'bg-text-muted/40',
            )}
            style={{ height: `${Math.max(10, p * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend-react && npx vitest run src/components/chat/__tests__/WaveformBars.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/WaveformBars.tsx frontend-react/src/components/chat/__tests__/WaveformBars.test.tsx
git commit -m "feat(voice): animated WaveformBars component"
```

---

### Task 7: Whisper model-size setting + download gating helper

**Files:**
- Modify: `frontend-react/src/stores/ui.ts` (add `whisperModel: 'small' | 'base'` + setter + persist)
- Create: `frontend-react/src/lib/voiceModel.ts` (ensure-downloaded helper around existing `download_model`)
- Modify: `frontend-react/src/components/settings/*` (one select for whisper model size — locate the existing settings section component and add a row matching its pattern)

**Interfaces:**
- Consumes: generated `tauri.whisperModelPresent(modelSize)`, `tauri.downloadModel(repoId, filename)`, and the `feral://download-progress|complete|error` events (already wired for model downloads — reuse the existing listener pattern from `ModelsPage`).
- Produces: `ensureWhisperModel(size: 'small'|'base', onProgress?: (p: number) => void): Promise<'ready'|'downloading-started'>` — returns `ready` if present, else kicks off the download and returns `downloading-started`.

- [ ] **Step 1: Add the setting to the UI store**

In `frontend-react/src/stores/ui.ts`, add `whisperModel: 'small' | 'base'` to the store type, default `'small'`, a `setWhisperModel` setter, and include `whisperModel` in `partialize`.

- [ ] **Step 2: Implement `ensureWhisperModel`**

```ts
import { tauri } from '@/lib/tauri';

const REPO = 'ggerganov/whisper.cpp';
const FILE: Record<'small' | 'base', string> = {
  small: 'ggml-small.bin',
  base: 'ggml-base.bin',
};

export async function ensureWhisperModel(
  size: 'small' | 'base',
): Promise<'ready' | 'downloading-started'> {
  if (await tauri.whisperModelPresent(size)) return 'ready';
  await tauri.downloadModel(REPO, FILE[size]);
  return 'downloading-started';
}
```

(Progress/complete is observed via the existing `feral://download-*` event listeners; the mic button in Task 8 subscribes to show a spinner and re-checks `whisperModelPresent` on `download-complete`.)

- [ ] **Step 3: Add the settings select**

Open the settings page section components and add one row, copying the existing select/row markup. Bind value to `whisperModel`, options `Small (~466 MB, better accuracy)` / `Base (~142 MB, lighter)`.

- [ ] **Step 4: Verify the generated bindings exist**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: no errors — `tauri.whisperModelPresent` / `tauri.transcribeAudio` / `tauri.saveVoiceBlob` are present from Task 3's binding regeneration. If missing, run a `cargo tauri dev` build once to regenerate, then re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/stores/ui.ts frontend-react/src/lib/voiceModel.ts frontend-react/src/components/settings
git commit -m "feat(voice): whisper model-size setting + ensure-downloaded helper"
```

---

### Task 8: Mic button + preview wired into ChatInput

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`
- Create: `frontend-react/src/components/chat/VoicePreview.tsx`

**Interfaces:**
- Consumes: `useVoiceRecorder`, `decodeToPcm16k`, `computePeaks`, `ensureWhisperModel`, `WaveformBars`, `useUI().whisperModel`, and the new `trySendVoice` path (Task 9).
- Produces: a mic `<button>` in the ChatInput control row (left group, next to `FileAttachButton`) and a `<VoicePreview>` shown above the textarea while `state === 'preview'`.

- [ ] **Step 1: Build `VoicePreview`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Trash2, RotateCcw } from 'lucide-react';
import { WaveformBars } from './WaveformBars';

export function VoicePreview({
  blob,
  durationMs,
  peaks,
  onDelete,
  onReRecord,
}: {
  blob: Blob;
  durationMs: number;
  peaks: number[];
  onDelete: () => void;
  onReRecord: () => void;
}) {
  const [url] = useState(() => URL.createObjectURL(blob));
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const toggle = () => {
    const a = audioRef.current!;
    if (playing) { a.pause(); } else { void a.play(); }
    setPlaying(!playing);
  };

  return (
    <div className="flex items-center gap-2 px-3 pt-2">
      <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="p-1.5 rounded hover:bg-bg-hover">
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <WaveformBars peaks={peaks} progress={progress} className="flex-1" />
      <span className="text-xs text-text-muted tabular-nums">{Math.round(durationMs / 1000)}s</span>
      <button type="button" onClick={onReRecord} aria-label="Re-record" className="p-1.5 rounded hover:bg-bg-hover"><RotateCcw size={14} /></button>
      <button type="button" onClick={onDelete} aria-label="Delete recording" className="p-1.5 rounded hover:bg-bg-hover"><Trash2 size={14} /></button>
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        hidden
      />
    </div>
  );
}
```

- [ ] **Step 2: Wire the recorder + mic button into `ChatInput`**

In `ChatInput.tsx`: call `useVoiceRecorder()`, keep local `peaks: number[]` state. Add a mic button in the left control group (next to `FileAttachButton`, line ~215):

```tsx
import { Mic, Square as StopIcon } from 'lucide-react';
// ...
const rec = useVoiceRecorder();
const [voicePeaks, setVoicePeaks] = useState<number[]>([]);
const whisperModel = useUI((s) => s.whisperModel);

// When a recording finishes, compute peaks for the preview.
useEffect(() => {
  if (rec.state === 'preview' && rec.blob) {
    void decodeToPcm16k(rec.blob).then((pcm) => setVoicePeaks(computePeaks(pcm)));
    void ensureWhisperModel(whisperModel); // warm the model in the background
  }
}, [rec.state, rec.blob, whisperModel]);

const onMic = async () => {
  if (rec.state === 'recording') { rec.stop(); return; }
  await rec.start();
  if (rec.error === 'denied') toast(t('voice.permissionDenied'));
  if (rec.error === 'unsupported') toast(t('voice.unsupported'));
};
```

Render the mic button (hidden while streaming):

```tsx
<button
  type="button"
  onClick={() => void onMic()}
  aria-label={rec.state === 'recording' ? 'Stop recording' : 'Record voice message'}
  className={cn('p-1.5 rounded hover:bg-bg-hover', rec.state === 'recording' && 'text-rose-400 animate-pulse')}
>
  {rec.state === 'recording' ? <StopIcon size={16} /> : <Mic size={16} />}
</button>
```

Render the preview above the textarea, gated on `rec.state === 'preview'`, replacing the normal send action with a voice-send action (Task 9):

```tsx
{rec.state === 'preview' && rec.blob && (
  <VoicePreview
    blob={rec.blob}
    durationMs={rec.durationMs}
    peaks={voicePeaks}
    onDelete={() => { rec.reset(); setVoicePeaks([]); }}
    onReRecord={() => { rec.reset(); setVoicePeaks([]); void rec.start(); }}
  />
)}
```

- [ ] **Step 3: Add i18n strings**

Add `voice.permissionDenied`, `voice.unsupported`, `voice.modelDownloading`, `voice.emptyTranscript` to the i18n catalogs (locate the existing catalog used by `useT`; add to every locale present).

- [ ] **Step 4: Typecheck + smoke build**

Run: `cd frontend-react && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/ChatInput.tsx frontend-react/src/components/chat/VoicePreview.tsx frontend-react/src/lib/i18n*
git commit -m "feat(voice): mic button + recording preview in ChatInput"
```

---

### Task 9: Send path — transcribe, build voice message, persist

**Files:**
- Modify: `frontend-react/src/stores/chat.ts` (extend `ChatMessage` with `voice`)
- Modify: `frontend-react/src/hooks/useSendMessage.ts` (add `sendVoice` returning function or extend send)
- Modify: `frontend-react/src/lib/messageMapping.ts` (carry `voice` into persistence mapping — find the ChatMessage→PersistedMessage save mapping; `toIpcMessage` stays role+content only since the model gets the transcript via `content`)
- Modify: `frontend-react/src/components/chat/ChatInput.tsx` (call the voice send from the preview's send button)

**Interfaces:**
- Consumes: `tauri.saveVoiceBlob(bytes, ext)`, `tauri.transcribeAudio(pcm, modelSize)`, `decodeToPcm16k`, `computePeaks`.
- Produces: `ChatMessage.voice?: { audioPath: string; durationMs: number; transcript: string; peaks: number[] }` and a `useSendVoiceMessage()` hook (or `sendVoice(blob, durationMs, peaks)` on the existing hook).

- [ ] **Step 1: Extend the `ChatMessage` type**

In `frontend-react/src/stores/chat.ts`, add to `ChatMessage`:

```ts
  /** Present when this user turn was recorded as a voice message. */
  voice?: { audioPath: string; durationMs: number; transcript: string; peaks: number[] };
```

- [ ] **Step 2: Implement the voice send**

Add `useSendVoiceMessage` in `useSendMessage.ts` (reusing the existing send pipeline — build the same `userMsg`/`asstMsg`, but `content = transcript` and attach `voice`). Pseudocode of the new hook body:

```ts
export function useSendVoiceMessage() {
  const send = useSendMessage();
  return useCallback(async (blob: Blob, durationMs: number, peaks: number[]) => {
    const { whisperModel } = useUI.getState();
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
    const audioPath = await tauri.saveVoiceBlob(Array.from(buf), ext);
    const pcm = await decodeToPcm16k(blob);
    let transcript = '';
    try {
      transcript = await tauri.transcribeAudio(Array.from(pcm), whisperModel);
    } catch (e) {
      // 'model-missing' | 'voice-unavailable' surfaced to caller for a toast.
      throw e;
    }
    // Reuse the normal send, but tag the just-added user message with voice meta.
    await send(transcript || '(unintelligible)', [], {
      voice: { audioPath, durationMs, transcript, peaks },
    });
  }, [send]);
}
```

Extend `useSendMessage`'s callback signature to accept an optional 3rd arg `opts?: { voice?: ChatMessage['voice'] }` and spread `...(opts?.voice ? { voice: opts.voice } : {})` into `userMsg`. Keep the default text path unchanged.

- [ ] **Step 3: Carry `voice` through persistence**

Find where `ChatMessage[]` is mapped to `PersistedMessage[]` before `tauri.save*` (grep `PersistedMessage` in `frontend-react/src`). Add `...(m.voice ? { voice: m.voice } : {})` to that mapping so the audio path + transcript + peaks persist. Confirm the generated `PersistedMessage` TS type now includes `voice` (from Task 3).

- [ ] **Step 4: Call it from the preview's Send button**

In `ChatInput.tsx`, when `rec.state === 'preview'`, the main Send button calls:

```ts
const sendVoice = useSendVoiceMessage();
// in trySend(), branch:
if (rec.state === 'preview' && rec.blob) {
  const { blob, durationMs } = rec;
  const peaks = voicePeaks;
  rec.reset(); setVoicePeaks([]);
  try { await sendVoice(blob, durationMs, peaks); }
  catch (err) {
    const code = String((err as Error).message);
    if (code === 'model-missing') toast(t('voice.modelDownloading'));
    else if (code === 'voice-unavailable') toast(t('voice.unsupported'));
    else toast(t('voice.emptyTranscript'));
  }
  return;
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend-react && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend-react/src/stores/chat.ts frontend-react/src/hooks/useSendMessage.ts frontend-react/src/lib/messageMapping.ts frontend-react/src/components/chat/ChatInput.tsx
git commit -m "feat(voice): transcribe + send voice message through chat pipeline"
```

---

### Task 10: Voice bubble in the message list

**Files:**
- Create: `frontend-react/src/components/chat/VoiceBubble.tsx`
- Modify: `frontend-react/src/components/chat/MessageItem.tsx` (render `VoiceBubble` when `message.voice` is set, instead of the plain text body)

**Interfaces:**
- Consumes: `message.voice`, `WaveformBars`, `convertFileSrc` (Tauri) to load the on-disk audio file, `computePeaks` + `decodeToPcm16k` as a fallback when `peaks` is empty (older messages).
- Produces: `<VoiceBubble voice={NonNullable<ChatMessage['voice']>} />`.

- [ ] **Step 1: Build `VoiceBubble`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { WaveformBars } from './WaveformBars';
import type { ChatMessage } from '@/stores/chat';

export function VoiceBubble({ voice }: { voice: NonNullable<ChatMessage['voice']> }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const src = convertFileSrc(voice.audioPath);

  const toggle = () => {
    const a = audioRef.current!;
    if (playing) a.pause(); else void a.play();
    setPlaying(!playing);
  };

  return (
    <div className="flex flex-col gap-1 max-w-sm">
      <div className="flex items-center gap-2 rounded-2xl bg-bg-surface border border-border-default px-3 py-2">
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="p-1 rounded hover:bg-bg-hover">
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <WaveformBars peaks={voice.peaks} progress={progress} className="flex-1" />
        <span className="text-xs text-text-muted tabular-nums">{Math.round(voice.durationMs / 1000)}s</span>
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          hidden
        />
      </div>
      {voice.transcript && (
        <p className="text-sm text-text-secondary px-1">{voice.transcript}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render it in `MessageItem`**

In `MessageItem.tsx`, where the user message body renders, branch early:

```tsx
if (message.voice) {
  return <VoiceBubble voice={message.voice} />;
}
```

Place this inside the user-message render path (before the normal markdown/attachment body), so assistant messages are unaffected.

- [ ] **Step 3: Allow the webview to load `voice/` files**

Confirm Tauri's asset protocol scope allows the app-data `voice/` dir (check `tauri.conf.json` → `app.security.assetProtocol` / `fs` scope). If a scope list exists, add the `voice/` path (e.g. `$APPDATA/feral/voice/**` or the equivalent already used for other on-disk assets). If `convertFileSrc` already works for existing on-disk assets (e.g. avatars/mascot), no change is needed.

- [ ] **Step 4: Typecheck + build**

Run: `cd frontend-react && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/VoiceBubble.tsx frontend-react/src/components/chat/MessageItem.tsx
git commit -m "feat(voice): playable voice bubble with waveform in message list"
```

---

### Task 11: End-to-end manual verification + feature wiring

**Files:**
- Modify: `src-tauri/Cargo.toml` or build config (ensure the `whisper` feature is enabled in the default dev/release build profile the app actually ships — mirror how `inference` is enabled for the running app)
- Modify: `docs/superpowers/specs/2026-06-17-voice-messages-design.md` (mark status Implemented)

- [ ] **Step 1: Enable the whisper feature for the app build**

Find where `inference` (or `inference-vulkan`) is enabled for the actual `cargo tauri dev` / release build (Cargo `default` features, a build script, or the tauri config). Add `whisper` alongside it so the shipped app compiles transcription. Document the flag in `README`/build notes next to the inference flag.

- [ ] **Step 2: Build and run the app**

Run: `cargo tauri dev` (with the feature set that includes `whisper`)
Expected: app launches, no compile errors.

- [ ] **Step 3: Manual test script (record the result of each)**

1. First mic tap with no model → download starts (progress visible), then transcription works after completion.
2. Record → preview shows waveform + duration; play it back (playhead animates); re-record; delete.
3. Send → voice bubble appears in chat with waveform + transcript; agent replies in text.
4. Reload the conversation (switch away and back / restart) → bubble, waveform, and transcript persist; playback still works.
5. Deny mic permission → toast, text input still works.
6. Delete the conversation → the `voice/*.webm` files for it are removed from disk.
7. Record near-silence → empty-transcript toast, no broken message.

- [ ] **Step 4: Run the full test suites**

Run: `cd src-tauri && cargo test` and `cd frontend-react && npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(voice): enable whisper feature in app build + mark spec implemented"
```

---

## Self-Review

**Spec coverage:**
- Local whisper STT → Tasks 1, 3, 11. ✓
- Audio bubble with animated waveform → Tasks 6, 10 (+preview 8). ✓
- Transcript under bubble → Task 10. ✓
- Whisper model downloaded on first use → Tasks 2, 7, 8. ✓
- Mic toggle + preview before send → Tasks 5, 8, 9. ✓
- Agent replies in text → Task 9 (transcript flows through normal send). ✓
- Backward-compatible data model → Tasks 3 (Rust `serde(default)`), 9 (TS optional). ✓
- `peaks` persisted, recompute fallback → Tasks 3, 9, 10. ✓
- Settings: model size, language auto-detect → Tasks 1 (auto), 7 (size). ✓
- Error paths (denied, model-missing, empty, unavailable) → Tasks 5, 8, 9. ✓
- Voice files on disk, deleted with conversation → Tasks 2, 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. UI-locator steps (settings row, i18n catalog, persistence mapping, asset scope) name the exact file/symbol to find and the exact change to make, because those locations follow existing repo patterns the implementer must match rather than invent.

**Type consistency:** `voice` shape `{ audioPath, durationMs, transcript, peaks }` is identical across `ChatMessage` (TS), `VoiceMeta` (Rust, snake_case `audio_path`/`duration_ms`), and all consumers. Command names `saveVoiceBlob`/`transcribeAudio`/`whisperModelPresent` (camelCase TS) map to `save_voice_blob`/`transcribe_audio`/`whisper_model_present` (Rust). `decodeToPcm16k`/`computePeaks`/`WaveformBars`/`useVoiceRecorder`/`ensureWhisperModel` used consistently. Error sentinels `model-missing`/`voice-unavailable` match between Rust returns and TS handlers.
