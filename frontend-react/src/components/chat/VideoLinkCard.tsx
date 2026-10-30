import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Play, X } from 'lucide-react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SiteIcon } from './LinkChip';
import { linkHost, linkLabel } from '@/lib/linkLabel';
import { youtubeThumb } from '@/lib/videoLinks';

/**
 * A video link shown as the video (Darius, 29 Oct 2026): its picture, title and
 * length; on hover, its first seconds play; in a sent message, a click opens the
 * whole video inside Cinderpaw. yt-dlp reads YouTube, Instagram, X and the rest
 * with one command (cinderpaw_core::video). Until yt-dlp and ffmpeg are here,
 * a YouTube link still shows its picture, and the card offers the download: the
 * click is the yes. A site yt-dlp cannot read stays a picture-less card that
 * opens in the browser.
 */

type Info = { title?: string | null; thumbnail?: string | null; duration?: number | null; uploader?: string | null };

// One answer per link for the whole session: a chat re-renders, yt-dlp should not rerun.
const infoCache = new Map<string, Promise<Info | null>>();
const previewCache = new Map<string, Promise<string | null>>();
let toolsReady: Promise<boolean> | null = null;

const ready = () => (toolsReady ??= invoke<boolean>('video_tools_ready').catch(() => false));
const infoFor = (href: string) => {
  if (!infoCache.has(href)) infoCache.set(href, invoke<Info>('video_link_info', { url: href }).catch(() => null));
  return infoCache.get(href)!;
};
const previewFor = (href: string) => {
  if (!previewCache.has(href)) {
    previewCache.set(href, invoke<string>('video_link_preview', { url: href }).then(convertFileSrc, () => null));
  }
  return previewCache.get(href)!;
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function VideoLinkCard({ href, onRemove }: { href: string; onRemove?: () => void }) {
  const [tools, setTools] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [full, setFull] = useState(false);
  const hovered = useRef(false);

  useEffect(() => {
    let live = true;
    void ready().then((ok) => {
      if (!live) return;
      setTools(ok);
      if (ok) void infoFor(href).then((i) => live && setInfo(i));
    });
    return () => { live = false; };
  }, [href]);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await invoke('install_video_tools');
      toolsReady = Promise.resolve(true);
      setTools(true);
      setInfo(await infoFor(href));
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const onEnter = () => {
    hovered.current = true;
    setHover(true);
    if (tools) void previewFor(href).then((u) => hovered.current && setClip(u));
  };
  const onLeave = () => {
    hovered.current = false;
    setHover(false);
  };

  const thumb = info?.thumbnail ?? youtubeThumb(href);
  const title = info?.title ?? linkLabel(href);
  const openFull = () => (tools ? setFull(true) : void open(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer')));

  return (
    <span
      className="relative inline-flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border-default bg-bg-elevated align-top"
      title={href}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={onRemove ? undefined : openFull}
        disabled={Boolean(onRemove)}
        aria-label={onRemove ? title : `Watch ${title}`}
        className="relative block aspect-video w-full overflow-hidden bg-black disabled:cursor-default"
      >
        {thumb && <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
        {hover && clip && (
          <video src={clip} autoPlay muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        )}
        {hover && tools && !clip && (
          <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white">
            <Loader2 size={12} className="animate-spin" aria-label="Getting a preview" />
          </span>
        )}
        {!(hover && clip) && (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white"><Play size={14} fill="currentColor" /></span>
          </span>
        )}
        {typeof info?.duration === 'number' && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-micro font-medium text-white">
            {clock(info.duration)}
          </span>
        )}
      </button>
      <span className="flex items-start gap-2 px-2.5 py-2">
        <SiteIcon href={href} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs font-medium text-text-primary">{title}</span>
          <span className="block truncate text-micro text-text-muted">{info?.uploader ?? linkHost(href)}</span>
        </span>
      </span>
      {tools === false && (
        <span className="border-t border-border-subtle px-2.5 py-2 text-micro text-text-muted">
          {installError ? (
            <span className="text-error">Could not download: {installError}</span>
          ) : (
            <button type="button" onClick={() => void install()} disabled={installing}
              className="inline-flex items-center gap-1.5 font-medium text-text-secondary hover:text-text-primary disabled:opacity-60">
              {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {installing ? 'Downloading video tools (about 150 MB)…' : 'Show the video here (downloads yt-dlp + ffmpeg, about 150 MB, once)'}
            </button>
          )}
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${title}`}
          className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80">
          <X size={12} />
        </button>
      )}
      {full && <FullVideo href={href} title={title} thumb={thumb} onClose={() => setFull(false)} />}
    </span>
  );
}

/** The whole video, played inside Cinderpaw (downloaded once, at most 720p). */
function FullVideo({ href, title, thumb, onClose }: { href: string; title: string; thumb?: string | null; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<string>('video_link_full', { url: href }).then(
      (p) => live && setSrc(convertFileSrc(p)),
      (e) => live && setError(String(e)),
    );
    return () => { live = false; };
  }, [href]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogTitle className="line-clamp-1">{title}</DialogTitle>
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          {src ? (
            <video src={src} controls autoPlay playsInline className="h-full w-full" />
          ) : (
            <>
              {thumb && <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
              <span className="absolute inset-0 grid place-items-center text-sm text-white">
                {error ? `Could not get the video: ${error}` : <span className="inline-flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Getting the video…</span>}
              </span>
            </>
          )}
        </div>
        <button type="button" onClick={() => void open(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'))}
          className="self-start text-xs text-text-muted hover:text-text-primary">
          Open on {linkHost(href) ?? 'the site'}
        </button>
      </DialogContent>
    </Dialog>
  );
}
