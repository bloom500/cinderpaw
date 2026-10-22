import { useState } from 'react';
import { Volume2 } from 'lucide-react';
import { useSoundSettings } from '@/stores/sounds';
import { UI_SOUNDS, playUiSound, type UiSoundId } from '@/lib/uiSounds';
import { ListenButton } from '@/components/voice/ListenButton';
import { CUBBY_LINES, type CubbyLineId } from '@/voice/cubby-lines';
import { sendTestNotification } from '@/lib/systemNotify';

export function SoundSettings() {
  const { enabled, volume, setEnabled, setVolume } = useSoundSettings();
  const [failed, setFailed] = useState<UiSoundId | null>(null);
  const [voice, setVoice] = useState<CubbyLineId>('onboarding.welcome');
  const [notice, setNotice] = useState<string | null>(null);
  const testNotification = async () => {
    setNotice(await sendTestNotification()
      ? 'Sent. Look at the corner of your screen. Cinderpaw sends these when a task finishes while you are in another window.'
      : 'Your computer blocked it. Turn on notifications for Cinderpaw in your system settings, then try again.');
  };
  const preview = async (id: UiSoundId) => {
    setFailed(null);
    if (!await playUiSound(id, true)) setFailed(id);
  };
  return (
    <section className="max-w-[616px] space-y-4" data-ui-sound="none" aria-labelledby="sounds-heading">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 id="sounds-heading" className="text-sm font-semibold text-text-primary">Sounds</h3>
          <p className="mt-0.5 text-xs text-text-muted">Calm, organic feedback for small actions and finished work.</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" role="switch" aria-label="Sound effects" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-brand" />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>
      <label className="flex items-center gap-3 text-xs text-text-secondary">
        Volume
        <input type="range" aria-label="Sound effects volume" min="0" max="100" step="1" value={Math.round(volume * 100)} onChange={(e) => setVolume(Number(e.target.value) / 100)} className="min-w-0 flex-1 accent-brand" />
        <span className="w-9 text-right tabular-nums">{Math.round(volume * 100)}%</span>
      </label>
      {/* Dev only: release builds keep the switch and the volume, no test or
          audition controls (Darius, 9 Oct 2026). */}
      {import.meta.env.DEV && <>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void testNotification()} className="inline-flex min-h-9 items-center rounded-full border border-border-default px-3 text-xs text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          Send a test notification
        </button>
        {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
      </div>
      <details className="rounded-2xl border border-border-default bg-bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">Listen to the sound pack</summary>
        <ul className="divide-y divide-border-subtle border-t border-border-subtle">
          {UI_SOUNDS.map((sound) => (
            <li key={sound.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span className="text-xs text-text-secondary">{sound.label}</span>
              <button type="button" disabled={volume === 0} aria-label={`Preview ${sound.label}`} onClick={() => void preview(sound.id)} className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">
                <Volume2 size={14} aria-hidden /> Listen
              </button>
              {failed === sound.id && <p role="status" className="w-full text-xs text-text-muted">Stop any spoken audio, then try again. Check that your volume is on.</p>}
            </li>
          ))}
        </ul>
        <p className="px-4 py-3 text-xs text-text-muted">The audio logo plays once when setup is complete.</p>
      </details>
      <div className="space-y-3 rounded-2xl border border-border-default bg-bg-surface p-4">
        <h4 className="text-sm font-medium text-text-primary">Cubby&apos;s voice</h4>
        <div className="flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor="cubby-voice-sample">Voice sample</label>
          <select id="cubby-voice-sample" value={voice} onChange={(e) => setVoice(e.target.value as CubbyLineId)} className="min-h-9 rounded-lg border border-border-default bg-bg-elevated px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
            {Object.keys(CUBBY_LINES).map((id) => <option key={id} value={id}>{id.slice('onboarding.'.length).replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
          <ListenButton line={voice} />
        </div>
        <p className="text-xs leading-relaxed text-text-muted">{CUBBY_LINES[voice].replace(/\[[^\]]+\]\s*/g, '')}</p>
      </div>
      </>}
    </section>
  );
}
