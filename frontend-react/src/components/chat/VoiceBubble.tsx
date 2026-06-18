import { Play, Pause } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { WaveformBars } from './WaveformBars';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { useT } from '@/lib/i18n';
import type { ChatMessage } from '@/stores/chat';

export function VoiceBubble({
  voice,
  pending = false,
}: {
  voice: NonNullable<ChatMessage['voice']>;
  pending?: boolean;
}) {
  const t = useT();
  // Web Audio decodes the on-disk recording (fetched via the asset protocol);
  // the HTML <audio> element can't play WebM/Opus in WebView2. See useAudioPlayer.
  const { playing, progress, toggle } = useAudioPlayer(convertFileSrc(voice.audioPath));

  return (
    <div className="flex flex-col gap-1 max-w-sm">
      <div className="flex items-center gap-2 rounded-2xl bg-bg-surface border border-border-default px-3 py-2">
        <button type="button" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'} className="p-1 rounded hover:bg-bg-hover">
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <WaveformBars peaks={voice.peaks} progress={progress} className="flex-1" />
        <span className="text-xs text-text-muted tabular-nums">{Math.round(voice.durationMs / 1000)}s</span>
      </div>
      {pending && !voice.transcript ? (
        <p className="text-xs text-text-muted px-1 italic animate-pulse">{t('voice.transcribing')}</p>
      ) : voice.transcript ? (
        <p className="text-sm text-text-secondary px-1">{voice.transcript}</p>
      ) : null}
    </div>
  );
}
