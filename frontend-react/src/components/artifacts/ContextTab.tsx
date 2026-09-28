import { useMemo, useState, type ReactNode } from 'react';
import { Brain, File, FileCode2, FileImage, FileText, Globe, Hourglass, MoreHorizontal, Paperclip, Plus, Search, Wrench, type LucideIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ApprovalCard } from '@/components/chat/ApprovalCard';
import { SiteIcon } from '@/components/chat/LinkChip';
import { CHAT_TOOLS, SwitchRow } from '@/components/chat/ToolsMenu';
import { chatContext } from '@/lib/chatContext';
import type { DisplayAttachment } from '@/lib/attachmentDisplay';
import { siteName } from '@/lib/sources';
import { tauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useChat, type MemoryUsedItem } from '@/stores/chat';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useUI } from '@/stores/ui';

function openUrl(url: string) {
  void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
}

const CODE = /\.(tsx?|jsx?|css|scss|html?|json|py|rs|go|java|c|cpp|h|sh|ps1|md|ya?ml|toml|sql)$/i;
/** The tile a file gets: code, picture, PDF or plain text, by its name. */
function fileTile(f: DisplayAttachment): { icon: LucideIcon; cls: string; what: string } {
  if (f.kind === 'image') return { icon: FileImage, cls: 'text-success', what: 'Image' };
  if (/\.pdf$/i.test(f.name)) return { icon: FileText, cls: 'text-error', what: 'PDF' };
  if (CODE.test(f.name)) return { icon: FileCode2, cls: 'text-info', what: 'Code' };
  if (f.kind === 'text') return { icon: FileText, cls: 'text-text-secondary', what: 'Text' };
  return { icon: File, cls: 'text-text-muted', what: 'File' };
}

/** A section: its heading with a count and "+ Add", its rows in one card. */
function Group({ icon: Icon, title, count, onAdd, addLabel, children }: {
  icon: LucideIcon;
  title: string;
  count?: number;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <header className="flex items-center gap-2 px-1">
        <Icon size={16} className="shrink-0 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {count !== undefined && count > 0 && <span className="text-xs text-text-muted">{count}</span>}
        <div className="flex-1" />
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel}
            className="flex h-7 items-center gap-1 rounded-lg border border-border-default bg-bg-elevated px-2.5 text-xs text-text-primary hover:bg-text-primary/5"
          >
            <Plus size={12} />
            Add
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-default bg-bg-elevated">
      {children}
    </ul>
  );
}

/** One row: tile, title over a quiet line, an optional tag, an optional menu. */
function Row({ tile, title, sub, tag, menu, onOpen, dim }: {
  tile: ReactNode;
  title: string;
  sub?: string;
  tag?: ReactNode;
  menu?: ReactNode;
  onOpen?: () => void;
  dim?: boolean;
}) {
  const body = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-surface">
        {tile}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', dim ? 'text-text-disabled line-through' : 'text-text-primary')} title={title}>
          {title}
        </span>
        {sub && <span className="block truncate text-xs text-text-muted">{sub}</span>}
      </span>
    </>
  );
  return (
    <li className="flex items-center gap-2 pr-1.5">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left hover:bg-text-primary/5">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3">{body}</div>
      )}
      {tag}
      {menu}
    </li>
  );
}

function RowMenu({ label, items }: { label: string; items: { label: string; run: () => void; danger?: boolean }[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-text-primary/5 hover:text-text-primary">
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((it) => (
          <DropdownMenuItem key={it.label} onClick={it.run} className={it.danger ? 'text-error' : undefined}>
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A memory the chat used, with Forget where the fact has a graph edge. */
function MemoryItem({ m }: { m: MemoryUsedItem }) {
  const [status, setStatus] = useState<'idle' | 'done' | 'failed'>('idle');
  const forget = () => {
    if (!m.forget) return;
    tauri.raw.memoryForget(m.forget.from, m.forget.to, m.forget.relation).then(() => setStatus('done'), () => setStatus('failed'));
  };
  const when = m.kind === 'past' && m.ts ? new Date(m.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : undefined;
  return (
    <Row
      tile={<Brain size={16} className="text-brand" />}
      title={m.text}
      sub={status === 'done' ? 'Forgotten' : status === 'failed' ? 'Could not forget this' : when}
      dim={status === 'done'}
      tag={
        <span className="shrink-0 rounded-full bg-bg-active px-2 py-0.5 text-2xs font-medium text-brand">
          {m.kind === 'fact' ? 'Fact' : 'Past chat'}
        </span>
      }
      menu={m.forget && status !== 'done' ? <RowMenu label={`More for ${m.text}`} items={[{ label: 'Forget', run: forget, danger: true }]} /> : undefined}
    />
  );
}

type View = 'all' | 'files' | 'links' | 'memory';

/**
 * The Context tab (spec 7.5, Context drawer; look from Darius's board, 28 Sep):
 * what this chat has put in front of Cinderpaw. Files attached, pages read,
 * memory used, pending approvals, and the Chat mode tool switches. Every row
 * comes from the chat's own messages (`chatContext`) or a store; nothing is
 * drawn that did not happen, so the board's "Current file" and filter button,
 * which have nothing behind them, are left out. A project's instructions and
 * files join the top in the projects slice.
 */
export function ContextTab({ onCompose, onAttach }: {
  /** Fill the composer and stop (Links and Memory "Add"). */
  onCompose?: (text: string) => void;
  /** Open the composer's file picker (Files "Add"). */
  onAttach?: () => void;
}) {
  const messages = useChat((s) => s.messages);
  const ctx = useMemo(() => chatContext(messages), [messages]);
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const threadId = useCoworkTranscript((s) => s.activeThreadId);
  const approvals = exchanges.filter((e) => e.kind === 'approval' && e.status === 'running' && !!threadId && e.threadId === threadId);
  const inputMode = useUI((s) => s.inputMode);
  const enabledTools = useUI((s) => s.enabledTools);
  const toggleTool = useUI((s) => s.toggleTool);
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const hit = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));
  const files = ctx.files.filter((f) => hit(f.name));
  const links = ctx.sources.filter((h) => hit(h.title, h.url, siteName(h)));
  const memories = ctx.memories.filter((m) => hit(m.text));

  const TABS: { id: View; label: string; count?: number }[] = [
    { id: 'all', label: 'All' },
    { id: 'files', label: 'Files', count: ctx.files.length },
    { id: 'links', label: 'Links', count: ctx.sources.length },
    { id: 'memory', label: 'Memory', count: ctx.memories.length },
  ];
  const show = (v: View) => view === 'all' || view === v;
  const nothing = ctx.files.length === 0 && ctx.sources.length === 0 && ctx.memories.length === 0 && approvals.length === 0;
  const none = (text: string) => <p className="rounded-xl border border-dashed border-border-default px-3 py-3 text-xs text-text-muted">{text}</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-3">
        <div role="tablist" aria-label="Show" className="flex rounded-xl bg-bg-active/60 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              onClick={() => setView(t.id)}
              className={cn(
                'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm transition-colors',
                view === t.id ? 'bg-bg-elevated font-medium text-brand shadow-sm' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t.label}
              {!!t.count && <span className="rounded-full bg-bg-surface px-1.5 text-2xs text-text-muted">{t.count}</span>}
            </button>
          ))}
        </div>
        <label className="flex h-9 items-center gap-2 rounded-xl border border-border-default bg-bg-elevated px-3">
          <Search size={14} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in this context…"
            aria-label="Search in this context"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-hidden placeholder:text-text-muted"
          />
        </label>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-5 px-4 pb-4">
          {view === 'all' && nothing && !q && (
            <p className="text-sm text-text-muted">
              Nothing here yet. Files you add, pages Cinderpaw reads and memories it uses will show up here.
            </p>
          )}
          {view === 'all' && approvals.length > 0 && (
            <Group icon={Hourglass} title="Waiting for you" count={approvals.length}>
              {approvals.map((e) => <ApprovalCard key={e.id} e={e} />)}
            </Group>
          )}

          {show('files') && (files.length > 0 || view === 'files') && (
            <Group icon={Paperclip} title="Files" count={ctx.files.length} onAdd={onAttach} addLabel="Add files">
              {files.length > 0 ? (
                <Rows>
                  {files.map((f) => {
                    const t = fileTile(f);
                    return <Row key={`${f.kind}:${f.name}`} tile={<t.icon size={16} className={t.cls} />} title={f.name} sub={t.what} />;
                  })}
                </Rows>
              ) : none(q ? 'No file matches.' : 'No files in this chat yet. Added ones go with your next message.')}
            </Group>
          )}

          {show('links') && (links.length > 0 || view === 'links') && (
            <Group icon={Globe} title="Web links" count={ctx.sources.length} onAdd={onCompose && (() => onCompose('Read this page: '))} addLabel="Add a link">
              {links.length > 0 ? (
                <Rows>
                  {links.map((h) => (
                    <Row
                      key={h.url}
                      tile={<SiteIcon href={h.url} />}
                      title={h.title || siteName(h)}
                      sub={siteName(h)}
                      onOpen={() => openUrl(h.url)}
                      menu={
                        <RowMenu
                          label={`More for ${h.title || siteName(h)}`}
                          items={[
                            { label: 'Open', run: () => openUrl(h.url) },
                            { label: 'Copy link', run: () => void navigator.clipboard?.writeText(h.url) },
                          ]}
                        />
                      }
                    />
                  ))}
                </Rows>
              ) : none(q ? 'No link matches.' : 'Pages Cinderpaw reads or cites in this chat land here.')}
            </Group>
          )}

          {show('memory') && (memories.length > 0 || view === 'memory') && (
            <Group icon={Brain} title="Memory" count={ctx.memories.length} onAdd={onCompose && (() => onCompose('Remember that '))} addLabel="Add a memory">
              {memories.length > 0 ? (
                <Rows>{memories.map((m, i) => <MemoryItem key={`${m.kind}-${i}`} m={m} />)}</Rows>
              ) : none(q ? 'No memory matches.' : 'Memories Cinderpaw uses in this chat land here.')}
            </Group>
          )}

          {view === 'all' && !q && (
            <Group icon={Wrench} title="Tools">
              {inputMode === 'chat' ? (
                <div className="flex flex-col rounded-xl border border-border-default bg-bg-elevated p-1">
                  {CHAT_TOOLS.map((t) => (
                    <SwitchRow
                      key={t.id}
                      label={t.label}
                      hint={t.hint}
                      checked={enabledTools.includes(t.id)}
                      onChange={() => toggleTool(t.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="px-1 text-sm text-text-muted">In Agent mode Cinderpaw picks the tools it needs for each task.</p>
              )}
            </Group>
          )}

          {q && files.length + links.length + memories.length === 0 && view === 'all' && (
            <p className="text-sm text-text-muted">Nothing in this chat matches "{query.trim()}".</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
