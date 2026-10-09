import { Square, Volume2 } from 'lucide-react';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { cubbyVoiceUrl } from '@/voice/cubbyVoice';
import type { CubbyLineId } from '@/voice/cubby-lines';

/** Plays Cubby's spoken version of a line, only when pressed. Renders nothing
 *  when the line has no audio made from its current words. */
export function ListenButton({ line }: { line: CubbyLineId }) {
  const url = cubbyVoiceUrl(line);
  return url ? <Player url={url} /> : null;
}

// Split out so the hook is never called conditionally.
function Player({ url }: { url: string }) {
  const { playing, toggle, error } = useAudioPlayer(url);
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-ui-sound="none">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? 'Stop' : 'Listen to Cubby'}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border-default bg-bg-surface px-3 text-sm text-text-secondary transition hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {playing ? <Square size={14} aria-hidden /> : <Volume2 size={16} aria-hidden />}
        {playing ? 'Stop' : 'Listen'}
      </button>
      {error && (
        <span role="status" className="text-xs text-text-muted">
          Sound can&apos;t play on this computer.
        </span>
      )}
    </span>
  );
}
