import { Play, Pause, Trash2, RotateCcw } from 'lucide-react';
import { WaveformBars } from './WaveformBars';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';

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
  const { playing, progress, toggle } = useAudioPlayer(blob);

  return (
    <div className="flex items-center gap-2 px-3 pt-2">
      <button type="button" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'} className="p-1.5 rounded hover:bg-bg-hover">
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <WaveformBars peaks={peaks} progress={progress} className="flex-1" />
      <span className="text-xs text-text-muted tabular-nums">{Math.round(durationMs / 1000)}s</span>
      <button type="button" onClick={onReRecord} aria-label="Re-record" className="p-1.5 rounded hover:bg-bg-hover"><RotateCcw size={14} /></button>
      <button type="button" onClick={onDelete} aria-label="Delete recording" className="p-1.5 rounded hover:bg-bg-hover"><Trash2 size={14} /></button>
    </div>
  );
}
