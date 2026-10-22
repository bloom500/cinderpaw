import { useSoundSettings } from '@/stores/sounds';
import manifest from '@/voice/ui-sounds.json';

const files = import.meta.glob('../assets/sounds/*.wav', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
// Made by scripts/ui-synth.py (docs/sound-design.md); Cubby's two are his ElevenLabs voice.
const cues = [
  ['tap', 'Primary button'], ['toggle-on', 'Switch on'], ['toggle-off', 'Switch off'],
  ['panel-open', 'Panel opens'], ['panel-close', 'Panel closes'], ['message-send', 'Message sent'],
  ['task-done', 'Task completed'], ['error', 'Error'],
  ['notification', 'Needs your attention'], ['tool-approved', 'Tool approved'],
  ['cubby-wake', 'Cubby wakes up'], ['cubby-sleep', 'Cubby falls asleep'],
  ['audio-logo', 'Cinderpaw audio logo'],
] as const;
export type UiSoundId = typeof cues[number][0];
export const UI_SOUNDS = cues.map(([id, label]) => ({ id, label, durationMs: manifest.find((s) => s.id === id)?.durationMs ?? 0, url: files[`../assets/sounds/${id}.wav`] }));

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let generation = 0;
let priority = 0;
let held = 0;
let lastAt = 0;
let lastId: UiSoundId | null = null;
const buffers = new Map<UiSoundId, Promise<AudioBuffer>>();

function ensureContext(): AudioContext {
  return context ??= new AudioContext();
}

/** Called inside a user gesture, so later completion events may play audio. */
export function unlockUiSounds(): void {
  if (!useSoundSettings.getState().enabled) return;
  try { void ensureContext().resume().catch(() => {}); } catch { /* no audio device */ }
}

export function stopUiSound(): void {
  generation++;
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    source.disconnect();
  }
  gain?.disconnect();
  source = null;
  gain = null;
  priority = 0;
  lastId = null;
  lastAt = 0;
}

/** Spoken clips take precedence over UI cues. Releases are safe to call twice. */
export function holdUiSounds(): () => void {
  held++;
  stopUiSound();
  let released = false;
  return () => { if (!released) { held--; released = true; } };
}

/** One shared Web Audio context, cached assets, no API calls at runtime. */
export async function playUiSound(id: UiSoundId, audition = false): Promise<boolean> {
  const { enabled, volume } = useSoundSettings.getState();
  if ((!enabled && !audition) || volume <= 0 || held || document.querySelector('[data-call-overlay]')) return false;
  const nextPriority = id === 'audio-logo' ? 4 : ['task-done', 'error', 'notification', 'tool-approved'].includes(id) ? 3 : id === 'message-send' ? 2 : 1;
  if (!audition && (nextPriority < priority || (id === lastId && performance.now() - lastAt < 400))) return false;
  if (!audition && (!context || context.state !== 'running')) return false;
  stopUiSound();
  const token = generation;
  priority = nextPriority;
  try {
    const ctx = ensureContext();
    if (audition) await ctx.resume();
    let buffer = buffers.get(id);
    if (!buffer) {
      const url = UI_SOUNDS.find((s) => s.id === id)?.url;
      if (!url) throw new Error('Sound asset unavailable');
      buffer = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error('Sound asset unavailable');
        return ctx.decodeAudioData(await response.arrayBuffer());
      });
      buffers.set(id, buffer);
      void buffer.catch(() => buffers.delete(id));
    }
    const decoded = await buffer;
    if (token !== generation || held || document.querySelector('[data-call-overlay]')) return false;
    const current = useSoundSettings.getState();
    if ((!current.enabled && !audition) || current.volume <= 0) { priority = 0; return false; }
    const node = ctx.createBufferSource();
    const volumeNode = ctx.createGain();
    node.buffer = decoded;
    volumeNode.gain.value = current.volume;
    node.connect(volumeNode);
    volumeNode.connect(ctx.destination);
    source = node;
    gain = volumeNode;
    node.onended = () => {
      if (source !== node) return;
      node.disconnect(); volumeNode.disconnect();
      source = null; gain = null; priority = 0;
    };
    lastId = id;
    lastAt = performance.now();
    node.start();
    return true;
  } catch {
    if (token === generation) stopUiSound();
    return false;
  }
}
