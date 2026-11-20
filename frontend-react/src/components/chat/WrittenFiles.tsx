import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';
import { folderOf, iconFor } from '@/components/browser/DownloadsCard';
import { tauri } from '@/lib/tauri';

/**
 * The files a reply wrote to disk, each with Open and Show in folder.
 *
 * A CSV the agent saved to Documents showed only as a path inside the text, and
 * the person had to go find it (31 Oct). Its own scratch files are left out:
 * they are working notes, not something made for the person. Unless the reply
 * names one: "make orase.csv in your workspace" put it in the scratchpad, and
 * the person who asked for it got no Open (smoke test, 7 Nov).
 */
export function writtenFiles(activity: ToolActivity[], reply = ''): string[] {
  const out = new Set<string>();
  for (const a of activity) {
    if ((a.tool !== 'write_file' && a.tool !== 'edit_file') || a.status !== 'done' || a.error) continue;
    for (const f of a.files) {
      const name = f.path.split(/[\\/]/).pop() ?? '';
      if (!f.scratch || (name && reply.includes(name))) out.add(f.path);
    }
  }
  return [...out];
}

export function WrittenFiles({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {paths.map((p) => <FileRow key={p} path={p} />)}
    </div>
  );
}

function FileRow({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  const name = path.split(/[\\/]/).pop() || path;
  const Icon = iconFor(name);
  const go = (reveal: boolean) => {
    setError(null);
    void tauri.raw.openLocalFile(path, reveal).catch(() =>
      setError(reveal ? "Couldn't show this file in its folder." : "Couldn't open this file."),
    );
  };
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Icon size={16} className="shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1 basis-28" title={path}>
          <div className="truncate text-sm text-text-primary">{name}</div>
          <div className="truncate text-2xs text-text-muted">{folderOf(path)}</div>
        </div>
        <button
          type="button"
          onClick={() => go(false)}
          aria-label={`Open ${name}`}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => go(true)}
          aria-label={`Show ${name} in folder`}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <FolderOpen size={16} />
          Show in folder
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
    </div>
  );
}
