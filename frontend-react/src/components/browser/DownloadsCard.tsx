import { Download, File, FileArchive, FileAudio, FileImage, FileText, FileVideo, FolderOpen, Package, Sparkles, type LucideIcon } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useBrowser } from '@/stores/browser';
import { cn } from '@/lib/utils';

/**
 * The downloads card, after the one Chrome and Edge open from the toolbar:
 * newest first, a file-type icon, the file's real name, one quiet line that
 * says where it went, a folder button, and the whole row opens the file.
 *
 * It sits in the flow under the toolbar and pushes the page down rather than
 * floating over it: the page is a native view that paints over anything
 * absolute (BrowserPanel, 21 Sep). Right-aligned and card-sized, so it still
 * reads as something that dropped from the Downloads button, not as a strip
 * of text across the whole window.
 */

const ICONS: [RegExp, LucideIcon][] = [
  [/\.(exe|msi|dmg|pkg|deb|rpm|appimage|apk)$/i, Package],
  [/\.(zip|rar|7z|tar|gz|bz2|xz)$/i, FileArchive],
  [/\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/i, FileImage],
  [/\.(mp4|mov|mkv|webm|avi)$/i, FileVideo],
  [/\.(mp3|wav|flac|ogg|m4a|aac)$/i, FileAudio],
  [/\.(pdf|docx?|txt|md|rtf|odt|csv|xlsx?)$/i, FileText],
];

const iconFor = (name: string) => ICONS.find(([re]) => re.test(name))?.[1] ?? File;

/** The folder a saved file is in, for "Show in folder". */
export const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

function ago(at: number): string {
  const m = Math.floor((Date.now() - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
}

export function DownloadsCard() {
  const downloads = useBrowser((b) => b.downloads);
  const lastFolder = downloads.find((d) => d.dest)?.dest;
  return (
    <div className="flex justify-end border-b border-border-subtle px-3 py-2">
      <div className="w-full max-w-sm rounded-xl border border-border-default bg-bg-elevated shadow-lg">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span className="text-xs font-semibold text-text-primary">Recent downloads</span>
          {lastFolder && (
            <button
              type="button"
              onClick={() => void shellOpen(folderOf(lastFolder))}
              className="text-2xs text-text-muted hover:text-text-primary"
            >
              Open Downloads folder
            </button>
          )}
        </div>

        {downloads.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 pb-5 pt-3 text-center">
            <Download size={20} className="text-text-muted" aria-hidden />
            <p className="text-xs text-text-secondary">Nothing downloaded yet this session.</p>
            <p className="text-2xs text-text-muted">Files you download show up here.</p>
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto px-1.5 pb-1.5 thin-scrollbar">
            {downloads.slice(0, 20).map((d) => {
              const Icon = d.artifact ? Sparkles : iconFor(d.name);
              const where = d.error
                ? d.error
                : d.artifact
                  ? `In Artifacts · ${ago(d.at)}`
                  : `Saved to Downloads · ${ago(d.at)}`;
              const openIt = d.dest ? () => void shellOpen(d.dest!) : undefined;
              return (
                <li key={`${d.name}-${d.at}`} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-bg-hover">
                  <button
                    type="button"
                    onClick={openIt}
                    disabled={!openIt}
                    title={d.dest ?? d.name}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
                  >
                    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-hover', d.error ? 'text-error' : 'text-text-secondary')}>
                      <Icon size={16} aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-text-primary">{d.name}</span>
                      <span className={cn('block truncate text-2xs', d.error ? 'text-error' : 'text-text-muted')}>{where}</span>
                    </span>
                  </button>
                  {d.dest && (
                    <button
                      type="button"
                      onClick={() => void shellOpen(folderOf(d.dest!))}
                      aria-label={`Show ${d.name} in folder`}
                      title="Show in folder"
                      className="rounded-md p-1.5 text-text-muted opacity-0 hover:bg-bg-elevated hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <FolderOpen size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
