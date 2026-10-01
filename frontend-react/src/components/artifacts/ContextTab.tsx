import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Brain, ChevronDown, ChevronRight, Cpu, File, FileCode2, FileImage, FileText, Folder, Globe, LayoutGrid, MoreHorizontal, Paperclip, Plus, ShieldCheck, Wrench, type LucideIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ApprovalCard } from '@/components/chat/ApprovalCard';
import { SiteIcon } from '@/components/chat/LinkChip';
import { CHAT_TOOLS, SwitchRow } from '@/components/chat/ToolsMenu';
import { useChatContext } from '@/hooks/useChatContext';
import type { DisplayAttachment } from '@/lib/attachmentDisplay';
import { siteName } from '@/lib/sources';
import { tauri, type ConnectorView, type Project } from '@/lib/tauri';
import { modelDisplayName } from '@/lib/modelLogos';
import { useBrowser } from '@/stores/browser';
import { useModel } from '@/stores/model';
import { cn } from '@/lib/utils';
import { useChat, type MemoryUsedItem } from '@/stores/chat';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
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

/** A project file's tile: the same kinds as an attachment, guessed from the name. */
function projectFileKind(name: string): DisplayAttachment['kind'] {
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(name)) return 'image';
  if (/\.(txt|md|csv|json|ya?ml|toml|html?|css|[jt]sx?|py|rs|go)$/i.test(name)) return 'text';
  return 'binary';
}

/**
 * The project this chat is filed in (spec 9): its instructions, which ride the
 * system prompt of every chat in it, and its files, copied into its folder
 * for the agent to open. Above the chat's own context.
 */
function ProjectGroup({ project }: { project: Project }) {
  const setInstructions = useProjects((s) => s.setInstructions);
  const addFiles = useProjects((s) => s.addFiles);
  const removeFile = useProjects((s) => s.removeFile);
  const [draft, setDraft] = useState(project.instructions ?? '');
  useEffect(() => setDraft(project.instructions ?? ''), [project.id, project.instructions]);
  const files = project.files ?? [];
  return (
    <Group icon={Folder} title={`Project · ${project.name}`} count={files.length} onAdd={() => void addFiles(project.id)} addLabel="Add a file to the project">
      <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-elevated p-3">
        <label htmlFor="project-instructions" className="text-xs font-medium text-text-secondary">
          Instructions for every chat in this project
        </label>
        <textarea
          id="project-instructions"
          value={draft}
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void setInstructions(project.id, draft.trim())}
          placeholder="For example: Answer in Romanian. Our budget is 2,000 EUR and we travel in April."
          className="resize-y rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-2 text-sm text-text-primary outline-hidden placeholder:text-text-muted focus:border-brand"
        />
        <p className="text-2xs text-text-muted">Cinderpaw reads these before every message in this project.</p>
      </div>
      {files.length > 0 ? (
        <Rows>
          {files.map((f) => {
            const t = fileTile({ name: f.name, kind: projectFileKind(f.name) });
            return (
              <Row
                key={f.name}
                tile={<t.icon size={16} className={t.cls} />}
                title={f.name}
                sub="In this project"
                menu={<RowMenu label={`More for ${f.name}`} items={[{ label: 'Remove from project', run: () => void removeFile(project.id, f.name), danger: true }]} />}
              />
            );
          })}
        </Rows>
      ) : (
        <p className="rounded-xl border border-dashed border-border-default px-3 py-3 text-xs text-text-muted">
          No files yet. Added files are copied into the project, and Cinderpaw opens them when they matter.
        </p>
      )}
    </Group>
  );
}

/**
 * One line of the panel that opens to its rows (Darius's Context board,
 * 30 Sep): icon, name, a count or a value, a dot when it needs you. A native
 * <details>, so opening and closing, the keyboard and the screen reader come
 * from the browser rather than from a state machine written here.
 */
function Fold({ id, icon: Icon, title, count, value, alert, defaultOpen, onAdd, addLabel, children }: {
  id: string;
  icon: LucideIcon;
  title: string;
  count?: number;
  value?: ReactNode;
  alert?: boolean;
  defaultOpen?: boolean;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <details id={id} open={defaultOpen} className="group rounded-xl border border-border-default bg-bg-elevated">
        <summary className="flex h-12 cursor-pointer list-none items-center gap-3 rounded-xl px-3.5 hover:bg-text-primary/5 [&::-webkit-details-marker]:hidden">
          <Icon size={16} className="shrink-0 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">{title}</span>
          {!!count && <span className="rounded-md bg-bg-active px-1.5 py-0.5 text-2xs text-text-muted">{count}</span>}
          {value}
          <span className="flex-1" />
          {alert && <span aria-label="Needs you" className="h-2 w-2 rounded-full bg-brand" />}
          <ChevronDown size={16} className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-2 border-t border-border-subtle p-2.5">
          {children}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              aria-label={addLabel}
              className="flex h-8 items-center justify-center gap-1 rounded-lg border border-dashed border-border-default text-xs text-text-muted hover:bg-text-primary/5 hover:text-text-primary"
            >
              <Plus size={12} />
              Add
            </button>
          )}
        </div>
      </details>
    </section>
  );
}

/** Open a fold and bring it into view: what a card's arrow leads to. */
function reveal(id: string) {
  const el = document.getElementById(id) as HTMLDetailsElement | null;
  if (!el) return;
  el.open = true;
  el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

/** A small card under "Contextual intelligence": a tile, a name, one line, a peek. */
function Card({ icon: Icon, title, sub, onOpen, children }: {
  icon: LucideIcon;
  title: string;
  sub: string;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-default bg-bg-elevated p-3 text-left hover:bg-text-primary/5"
    >
      <span className="flex w-full items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-tight text-text-primary">{title}</span>
          <span className="mt-0.5 block text-2xs leading-tight text-text-muted">{sub}</span>
        </span>
        <ChevronRight size={14} className="mt-0.5 shrink-0 text-text-muted" />
      </span>
      {children}
    </button>
  );
}

/** The first thing the person asked, without the attachment markers the chat adds. */
function askedText(messages: readonly { role: string; content: unknown }[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = typeof first?.content === 'string' ? first.content : '';
  return text.replace(/^\[[^\]\n]*attached[^\]\n]*\]\s*/gim, '').replace(/\s+/g, ' ').trim();
}

/**
 * The Context tab, as on Darius's Context board (30 Sep): what this chat is
 * about, then everything Cinderpaw has in front of it, one line each, opened
 * on demand. Every row comes from the chat's own messages (`chatContext`) or a
 * store; nothing is drawn that did not happen. The board's due date, coworker
 * faces and "Edit" have nothing behind them yet, so they are left out.
 */
export function ContextTab({ onCompose, onAttach }: {
  /** Fill the composer and stop (Links and Memory "Add"). */
  onCompose?: (text: string) => void;
  /** Open the composer's file picker (Files "Add"). */
  onAttach?: () => void;
}) {
  // Selectors that return strings, numbers or stable arrays, so a streamed
  // word does not re-render the tab (c5f6cc5); only the asked text, the count
  // and the status are read from the messages.
  const asked = useChat((s) => askedText(s.messages));
  const messageCount = useChat((s) => s.messages.length);
  const status = useChat((s) => s.streamStatus);
  const toolCalls = useChat((s) => s.toolCallStream);
  const ctx = useChatContext();
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const threadId = useCoworkTranscript((s) => s.activeThreadId);
  const approvals = exchanges.filter((e) => e.kind === 'approval' && e.status === 'running' && !!threadId && e.threadId === threadId);
  const inputMode = useUI((s) => s.inputMode);
  const enabledTools = useUI((s) => s.enabledTools);
  const toggleTool = useUI((s) => s.toggleTool);
  const currentId = useConversations((s) => s.currentId);
  const convo = useConversations((s) => s.list.find((c) => c.id === s.currentId));
  const project = useProjects((s) => (currentId ? s.list.find((p) => p.conversation_ids.includes(currentId)) : undefined));
  const model = useModel((s) => (s.cloudModel ? modelDisplayName(s.cloudModel.modelId) : s.loaded?.name ?? null));
  const browserUrl = useBrowser((s) => s.url);
  const browserTitle = useBrowser((s) => s.tabs.find((t) => t.id === s.active)?.title ?? '');
  const [apps, setApps] = useState<ConnectorView[]>([]);
  useEffect(() => {
    tauri.connectors.list().then(
      (list) => setApps(list.filter((c) => c.enabled && (c.linked || c.filled.length > 0))),
      () => setApps([]),
    );
  }, []);

  // A chat not yet titled is named by its first ask, cut at a word, not inside one.
  const title = convo?.title || (asked.length > 60 ? `${asked.slice(0, 60).replace(/\s\S*$/, '')}…` : asked) || 'New conversation';
  const tools = [...new Map(toolCalls.filter((t) => t.kind === 'tool').map((t) => [t.name, t])).values()];
  const nothing = ctx.files.length === 0 && ctx.sources.length === 0 && ctx.memories.length === 0 && approvals.length === 0;
  const state = status === 'streaming'
    ? { label: 'In progress', cls: 'bg-success/10 text-success', dot: 'bg-success' }
    : approvals.length > 0
      ? { label: 'Needs you', cls: 'bg-brand/10 text-brand', dot: 'bg-brand' }
      : { label: 'Ready', cls: 'bg-bg-active text-text-secondary', dot: 'bg-text-muted' };
  const none = (text: string) => <p className="px-1 py-1 text-xs text-text-muted">{text}</p>;

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-3 px-4 pb-5">
        {project && <ProjectGroup project={project} />}

        {messageCount > 0 ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-brand/20 bg-brand/5 p-4">
            <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Activity size={16} className="text-brand" />
              Current task
            </span>
            <h3 className="font-display text-lg leading-snug text-text-primary">{title}</h3>
            {asked && asked !== title && <p className="line-clamp-3 text-sm text-text-secondary">{asked}</p>}
            <span className={cn('flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium', state.cls)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', state.dot)} />
              {state.label}
            </span>
          </div>
        ) : null}

        {nothing && (
          <p className="px-1 text-sm text-text-muted">
            Nothing here yet. Files you add, pages Cinderpaw reads and memories it uses will show up here.
          </p>
        )}

        <Fold id="ctx-files" icon={Paperclip} title="Files" count={ctx.files.length} onAdd={onAttach} addLabel="Add files">
          {ctx.files.length > 0 ? (
            <Rows>
              {ctx.files.map((f) => {
                const t = fileTile(f);
                return <Row key={`${f.kind}:${f.name}`} tile={<t.icon size={16} className={t.cls} />} title={f.name} sub={t.what} />;
              })}
            </Rows>
          ) : none('No files in this chat yet. Added ones go with your next message.')}
        </Fold>

        <Fold id="ctx-memory" icon={Brain} title="Memory" count={ctx.memories.length} onAdd={onCompose && (() => onCompose('Remember that '))} addLabel="Add a memory">
          {ctx.memories.length > 0
            ? <Rows>{ctx.memories.map((m, i) => <MemoryItem key={`${m.kind}-${i}`} m={m} />)}</Rows>
            : none('Memories Cinderpaw uses in this chat land here.')}
        </Fold>

        <Fold id="ctx-tools" icon={Wrench} title="Tools in use" count={tools.length}>
          {tools.length > 0 && (
            <Rows>
              {tools.map((t) => t.kind === 'tool' && (
                <Row key={t.name} tile={<span className="text-base">{t.emoji}</span>} title={t.name} sub={t.status === 'running' ? 'Running now' : t.status === 'error' ? 'Failed' : 'Used in this reply'} />
              ))}
            </Rows>
          )}
          {inputMode === 'chat' ? (
            <div className="flex flex-col rounded-xl border border-border-default bg-bg-surface p-1">
              {CHAT_TOOLS.map((t) => (
                <SwitchRow key={t.id} label={t.label} hint={t.hint} checked={enabledTools.includes(t.id)} onChange={() => toggleTool(t.id)} />
              ))}
            </div>
          ) : none('In Agent mode Cinderpaw picks the tools it needs for each task.')}
        </Fold>

        <Fold id="ctx-model" icon={Cpu} title="Model" value={<span className="truncate text-sm text-text-secondary">{model ?? 'None chosen'}</span>}>
          {none(model ? 'The model answering in this chat. Change it from the picker under the message box.' : 'Pick a model under the message box to start.')}
        </Fold>

        <Fold id="ctx-approvals" icon={ShieldCheck} title="Approvals needed" count={approvals.length} alert={approvals.length > 0} defaultOpen={approvals.length > 0}>
          {approvals.length > 0 ? approvals.map((e) => <ApprovalCard key={e.id} e={e} />) : none('Nothing is waiting for you.')}
        </Fold>

        <Fold id="ctx-sources" icon={Globe} title="Sources" count={ctx.sources.length} onAdd={onCompose && (() => onCompose('Read this page: '))} addLabel="Add a link">
          {ctx.sources.length > 0 ? (
            <Rows>
              {ctx.sources.map((h) => (
                <Row
                  key={h.url}
                  tile={<SiteIcon href={h.url} />}
                  title={h.title || siteName(h)}
                  sub={siteName(h)}
                  onOpen={() => openUrl(h.url)}
                  menu={<RowMenu label={`More for ${h.title || siteName(h)}`} items={[
                    { label: 'Open', run: () => openUrl(h.url) },
                    { label: 'Copy link', run: () => void navigator.clipboard?.writeText(h.url) },
                  ]} />}
                />
              ))}
            </Rows>
          ) : none('Pages Cinderpaw reads or cites in this chat land here.')}
        </Fold>

        {(ctx.memories.length > 0 || browserUrl || apps.length > 0 || ctx.files.length + ctx.artifactIds.length > 0) && (
          <>
            <h3 className="mt-3 flex items-center gap-3 font-display text-lg text-text-primary">
              Contextual intelligence
              <span className="h-px flex-1 bg-border-subtle" />
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {ctx.memories.length > 0 && (
                <Card icon={Brain} title="Recent memory" sub={`${ctx.memories.length} relevant ${ctx.memories.length === 1 ? 'memory' : 'memories'}`} onOpen={() => reveal('ctx-memory')}>
                  <span className="line-clamp-2 text-2xs italic text-text-muted">{`"${ctx.memories[0]!.text}"`}</span>
                </Card>
              )}
              {browserUrl && (
                <Card icon={Globe} title="Live browser page" sub="1 open page" onOpen={() => useBrowser.getState().setPanel(true)}>
                  <span className="truncate text-2xs text-text-secondary">{browserTitle || browserUrl}</span>
                </Card>
              )}
              {apps.length > 0 && (
                <Card icon={LayoutGrid} title="Connected apps" sub={`${apps.length} ${apps.length === 1 ? 'source' : 'sources'}`}>
                  <span className="flex gap-1.5">
                    {apps.slice(0, 5).map((a) => (a.logo_url
                      ? <img key={a.id} src={a.logo_url} alt={a.name} className="h-5 w-5 rounded" />
                      : <span key={a.id} title={a.name} className="flex h-5 w-5 items-center justify-center rounded bg-bg-active text-2xs">{a.name[0]}</span>))}
                  </span>
                </Card>
              )}
              {ctx.files.length + ctx.artifactIds.length > 0 && (
                <Card icon={FileText} title="Task context" sub={`${ctx.files.length + ctx.artifactIds.length} relevant ${ctx.files.length + ctx.artifactIds.length === 1 ? 'item' : 'items'}`} onOpen={() => reveal('ctx-files')}>
                  <span className="flex flex-col gap-0.5">
                    {ctx.files.slice(0, 3).map((f) => <span key={f.name} className="truncate text-2xs text-text-secondary">{f.name}</span>)}
                    {ctx.artifactIds.length > 0 && <span className="text-2xs text-text-muted">{`${ctx.artifactIds.length} made in this chat`}</span>}
                  </span>
                </Card>
              )}
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
