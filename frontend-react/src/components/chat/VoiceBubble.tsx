import { useRef, useState } from 'react';
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
