import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Italic, List, ListOrdered, Redo2, Undo2, type LucideIcon } from 'lucide-react';
import { ArtifactAction } from '@/components/ai-elements/artifact';
import { ScrollArea } from '@/components/ui/scroll-area';
import { diffLines, readableLines } from '@/lib/versionDiff';
import { cn } from '@/lib/utils';

/**
 * Editing an artifact by hand, and reviewing what the agent changed.
 *
 * A `document` gets a real editor, because it is prose and a person should not
 * have to write HTML to fix a sentence. Every other text kind (markdown, code,
 * JSON, a table's rows, an app's source) is edited as the text it is.
 *
 * SECURITY. A document's HTML came from a model, sometimes from a web page it
 * read, and here it is rendered in the app's own webview, not in the sandboxed
 * frame the preview uses. What makes that safe is the editor's schema: Tiptap
 * parses the HTML into only the nodes StarterKit defines (paragraphs, headings,
 * lists, quotes, code, links) and drops everything else, scripts, iframes, event
 * handlers and style included. So no extension that renders raw HTML, embeds, or
 * images from a URL may be added here without taking that question up again.
 * Links never open on click: inside this webview a click would navigate the app.
 */
const EXTENSIONS = [
  StarterKit.configure({
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } },
  }),
];

export function DocumentEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: {
        'aria-label': 'Document',
        class: 'prose prose-sm dark:prose-invert max-w-none min-h-full px-3 py-3 text-xs focus:outline-hidden',
      },
    },
  });

  // Re-read only what the toolbar shows. Without a selector the whole panel
  // would re-render on every keystroke.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      heading: e?.isActive('heading', { level: 2 }) ?? false,
      bullets: e?.isActive('bulletList') ?? false,
      numbers: e?.isActive('orderedList') ?? false,
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false,
    }),
  });

  const tool = (label: string, icon: LucideIcon, active: boolean, run: () => void, disabled = false) => (
    <ArtifactAction
      tooltip={label}
      icon={icon}
      aria-pressed={active}
      disabled={!editor || disabled}
      onClick={run}
      className={cn(active && 'bg-bg-hover text-text-primary')}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5 border-b border-border-subtle px-2 py-1">
        {tool('Bold', Bold, !!state?.bold, () => editor?.chain().focus().toggleBold().run())}
        {tool('Italic', Italic, !!state?.italic, () => editor?.chain().focus().toggleItalic().run())}
        {tool('Heading', Heading2, !!state?.heading, () => editor?.chain().focus().toggleHeading({ level: 2 }).run())}
        {tool('Bulleted list', List, !!state?.bullets, () => editor?.chain().focus().toggleBulletList().run())}
        {tool('Numbered list', ListOrdered, !!state?.numbers, () => editor?.chain().focus().toggleOrderedList().run())}
        <span className="mx-1 h-4 w-px bg-border-subtle" aria-hidden />
        {tool('Undo', Undo2, false, () => editor?.chain().focus().undo().run(), !state?.canUndo)}
        {tool('Redo', Redo2, false, () => editor?.chain().focus().redo().run(), !state?.canRedo)}
      </div>
      <ScrollArea className="flex-1">
        <EditorContent editor={editor} />
      </ScrollArea>
    </div>
  );
}

/** Everything that is not prose is edited as its own text. Undo is the textarea's own. */
export function SourceEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <textarea
      aria-label="Content"
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 resize-none border-0 bg-transparent px-3 py-3 font-mono text-2xs text-text-primary focus:outline-hidden"
    />
  );
}

/**
 * What changed between the version before and the one shown.
 *
 * Keeping a change needs no button: it is already the current version. Undoing
 * it is a restore of the one before, which is a new version too, so undoing the
 * undo stays possible and the history never loses a step.
 */
export function ChangesView({
  kind, before, after, beforeVersion, afterVersion, onUndo, onClose, busy,
}: {
  kind: string;
  before: string;
  after: string;
  beforeVersion: number;
  afterVersion: number;
  onUndo: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const lines = diffLines(readableLines(before, kind), readableLines(after, kind));
  const changed = lines?.filter((l) => l.kind !== 'same').length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <p className="flex-1 text-2xs text-text-muted">
          {lines === null
            ? `v${beforeVersion} and v${afterVersion} are too long to compare here.`
            : changed === 0
              ? `v${afterVersion} reads the same as v${beforeVersion}.`
              : `What changed from v${beforeVersion} to v${afterVersion}`}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-2xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          Keep it
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onUndo}
          className="rounded-md border border-border-default px-2 py-1 text-2xs text-text-primary hover:bg-bg-hover disabled:opacity-60"
        >
          {`Put v${beforeVersion} back`}
        </button>
      </div>
      <ScrollArea className="flex-1">
        <ol className="px-2 py-2 font-mono text-2xs">
          {(lines ?? []).map((l, i) => (
            <li
              // Lines repeat (blank ones especially), so position is the identity.
              key={i}
              className={cn(
                'whitespace-pre-wrap break-words rounded-sm px-1.5 py-0.5',
                l.kind === 'added' && 'bg-success/10 text-success',
                l.kind === 'removed' && 'bg-error/10 text-error line-through',
                l.kind === 'same' && 'text-text-muted',
              )}
            >
              <span className="sr-only">{l.kind === 'added' ? 'Added: ' : l.kind === 'removed' ? 'Removed: ' : ''}</span>
              {l.text || ' '}
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
}
