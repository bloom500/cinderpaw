import { AppWindow, Code, FileBox, FileText, Image as ImageIcon, Table } from 'lucide-react';
import type { ArtifactFact } from '@/hooks/useLiveToolActivity';
import { useArtifacts } from '@/stores/artifacts';

/** Icon and word per artifact kind (the sidecar's `ArtifactKind`). */
const KINDS: Record<string, { icon: typeof FileBox; word: string }> = {
  document: { icon: FileText,  word: 'Document' },
  markdown: { icon: FileText,  word: 'Document' },
  docx:     { icon: FileText,  word: 'Word document' },
  pdf:      { icon: FileText,  word: 'PDF' },
  app:      { icon: AppWindow, word: 'Interactive' },
  html:     { icon: AppWindow, word: 'Web page' },
  table:    { icon: Table,     word: 'Table' },
  code:     { icon: Code,      word: 'Code' },
  json:     { icon: Code,      word: 'Data' },
  image:    { icon: ImageIcon, word: 'Image' },
};
const OTHER = { icon: FileBox, word: 'File' };

/** The icon and word for a kind, "File" for one this list does not know. */
export function artifactKind(kind: string): { icon: typeof FileBox; word: string } {
  return KINDS[kind] ?? OTHER;
}

/** "Document, 12 KB": what it is and how big (the Artifact Dock's line). */
export function artifactSize(kind: string, bytes: number): string {
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${artifactKind(kind).word}, ${size}`;
}

/** "Document", or "Document, v3" once it has been revised (the tool widget's form). */
export function artifactLine(f: Pick<ArtifactFact, 'kind' | 'version'>): string {
  const { word } = KINDS[f.kind] ?? OTHER;
  return f.version > 1 ? `${word}, v${f.version}` : word;
}

/**
 * What a reply made, as a card: icon tile, title, one line, Open (spec 6).
 * Open shows it in the side panel, the same place a new artifact appears.
 */
export function ArtifactCard({ f }: { f: ArtifactFact }) {
  const Icon = (KINDS[f.kind] ?? OTHER).icon;
  const open = () => {
    useArtifacts.setState({ panelOpen: true, panelTab: 'artifacts' });
    void useArtifacts.getState().openArtifact(f.id);
  };
  return (
    <div className="flex items-center gap-3.5 rounded-2xl border border-border-default bg-bg-surface py-3 pl-3.5 pr-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand">
        <Icon size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text-primary" title={f.title}>{f.title}</span>
        <span className="truncate text-2xs text-text-disabled">{artifactLine(f)}</span>
      </span>
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${f.title}`}
        className="h-8 shrink-0 rounded-lg border border-border-default bg-bg-elevated px-3.5 text-sm font-medium text-text-primary hover:bg-text-primary/5 transition-colors"
      >
        Open
      </button>
    </div>
  );
}
