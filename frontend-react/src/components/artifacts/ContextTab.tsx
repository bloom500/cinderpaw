import { useEffect, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, File, FileCode2, FileImage, FileText, Folder, Gauge, Globe, MoreHorizontal, Paperclip, Plug, Plus, ShieldCheck, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { open } from '@tauri-apps/plugin-shell';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ApprovalCard } from '@/components/chat/ApprovalCard';
import { SiteIcon } from '@/components/chat/LinkChip';
import { useChatContext } from '@/hooks/useChatContext';
import type { DisplayAttachment } from '@/lib/attachmentDisplay';
import { siteName } from '@/lib/sources';
import { tauri, type ConnectorView, type Project } from '@/lib/tauri';
import { activeContextWindow, estimateTokens } from '@/lib/contextWindow';
import { ModelLogo, modelDisplayName } from '@/lib/modelLogos';
import { MODES } from '@/components/chat/PermissionPill';
import { cn } from '@/lib/utils';
import { useChat, type ContextLane, type MemoryUsedItem } from '@/stores/chat';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { useArtifacts } from '@/stores/artifacts';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useModel } from '@/stores/model';
import { useSettings } from '@/stores/settings';
import { useBrowser, HOME } from '@/stores/browser';
import { useRlmWorkers, workersFor } from '@/stores/rlmWorkers';
import { WorkersCard } from '@/components/chat/WorkersCard';
import { BASE } from '@/lib/motion';

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
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-muted hover:bg-text-primary/5 hover:text-text-primary"
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
    <ul className="flex flex-col overflow-hidden rounded-xl">
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
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-hover">
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
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 pl-1 text-left hover:bg-text-primary/5">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-1">{body}</div>
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

const SQUIRCLE = 'rounded-[18px] [corner-shape:squircle] bg-bg-elevated';

/**
 * One card of the panel, as in Claude's side panel (his reference, 29 Oct):
 * always there, in the same place, one line with its value on the right.
 * With rows it opens like a native <details> (keyboard and screen reader come
 * from the browser); with nothing to show it is a plain line, no chevron.
 */
function Fold({ id, icon: Icon, title, value, alert, defaultOpen, onAdd, addLabel, children }: {
  id: string;
  icon: LucideIcon;
  title: string;
  value?: ReactNode;
  alert?: boolean;
  defaultOpen?: boolean;
  onAdd?: () => void;
  addLabel?: string;
  children?: ReactNode;
}) {
  const head = (
    <>
      <Icon size={16} className="shrink-0 text-text-secondary" />
      <span className="text-sm font-medium text-text-primary">{title}</span>
      <span className="flex-1" />
      {value !== undefined && <span className="min-w-0 truncate text-sm text-text-muted">{value}</span>}
      {alert && <span aria-label="Needs you" className="h-2 w-2 shrink-0 rounded-full bg-brand" />}
    </>
  );
  if (!children) {
    return (
      <section aria-label={title}>
        <div id={id} className={cn('flex h-11 items-center gap-2.5 px-3.5', SQUIRCLE)}>{head}</div>
      </section>
    );
  }
  return (
    <section aria-label={title}>
      <details id={id} open={defaultOpen} className={cn('group', SQUIRCLE)}>
        <summary className="flex h-11 cursor-pointer list-none items-center gap-2.5 rounded-[18px] [corner-shape:squircle] px-3.5 hover:bg-text-primary/5 [&::-webkit-details-marker]:hidden">
          {head}
          <ChevronDown size={16} className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-1 px-2.5 pb-2.5">
          {children}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              aria-label={addLabel}
              className="flex h-8 items-center gap-1 rounded-lg px-1 text-xs text-text-muted hover:bg-text-primary/5 hover:text-text-primary"
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

/** A card that comes and goes with the work it shows: a short fade, none under reduced motion. */
function Live({ still, children }: { still: boolean | null; children: ReactNode }) {
  return (
    <motion.div
      layout={!still}
      initial={still ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4 }}
      transition={BASE}
    >
      {children}
    </motion.div>
  );
}

/** A label on the left, its value on the right: one line of "This chat". */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1 text-sm">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-text-primary">{children}</span>
    </div>
  );
}

/**
 * The Context panel: what this chat runs on and what Cinderpaw has in front of
 * it. Every value comes from the chat's own messages (`chatContext`) or a
 * store; nothing is drawn that did not happen, and an empty card says "None"
 * rather than inventing a row. Tools are left to the chat's own widgets.
 */
export function ContextTab({ onCompose, onAttach }: {
  /** Fill the composer and stop (Links and Memory "Add"). */
  onCompose?: (text: string) => void;
  /** Open the composer's file picker (Files "Add"). */
  onAttach?: () => void;
}) {
  // Selectors that return strings or numbers, so a streamed word does not
  // re-render the panel (c5f6cc5): context use is read in steps of 500
  // tokens, the made-here titles as one string.
  const status = useChat((s) => s.streamStatus);
  const usedSteps = useChat((s) => Math.round((s.livePromptTokens !== null
    ? s.livePromptTokens + (s.liveCompletionTokens ?? 0)
    : s.messages.reduce((n, m) => n + estimateTokens(m.content), 0)) / 500));
  const ctx = useChatContext();
  // Live work, read while it happens (his "piese mobile", 29 Oct): each card
  // below appears only while its thing is true, like Claude's Background tasks.
  // A model download and Dreams already have their own cards in the sidebar
  // (DownloadStatus, DreamingCard), so they are not repeated here.
  const sessionId = useChat((s) => s.sessionId);
  // The helpers this chat started: their card moves here from above the
  // message box while the panel is open (WorkersCard), one place at a time.
  const hasWorkers = useRlmWorkers((s) => workersFor(s.workers, sessionId).length > 0);
  const page = useBrowser((s) => {
    const tab = s.tabs.find((t) => t.id === s.active);
    return tab && tab.url && tab.url !== HOME ? `${tab.title || tab.url}\n${tab.url}` : '';
  });
  const still = useReducedMotion();
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const threadId = useCoworkTranscript((s) => s.activeThreadId);
  const approvals = exchanges.filter((e) => e.kind === 'approval' && e.status === 'running' && !!threadId && e.threadId === threadId);
  const currentId = useConversations((s) => s.currentId);
  const project = useProjects((s) => (currentId ? s.list.find((p) => p.conversation_ids.includes(currentId)) : undefined));
  const madeHere = useArtifacts((s) => s.rows.filter((r) => ctx.artifactIds.includes(r.id)).map((r) => r.title).join('\n'));
  // The agent answers with its own pinned model (useCinderpawStore); reading
  // only the chat-mode store said "None chosen" in the middle of a reply from
  // that model (UX lab, item 19).
  const cinderpawConfig = useCinderpawStore((s) => s.modelConfig);
  const loaded = useModel((s) => s.loaded);
  const model = useModel((s) => (s.cloudModel ? modelDisplayName(s.cloudModel.modelId) : s.loaded?.name ?? null))
    ?? (cinderpawConfig?.model ? modelDisplayName(cinderpawConfig.model) : null);
  const cloudId = useModel((s) => s.cloudModel?.modelId);
  const accessMode = useSettings((s) => s.settings?.permission_mode) ?? 'workspace_write';
  const [apps, setApps] = useState<ConnectorView[]>([]);
  useEffect(() => {
    tauri.connectors.list().then(
      (list) => setApps(list.filter((c) => c.enabled && (c.linked || c.filled.length > 0))),
      () => setApps([]),
    );
  }, []);

  const { ctxWindow } = activeContextWindow({ cinderpawConfig, loaded });
  // What the latest reply's prompt was made of, saved on that reply, so the
  // breakdown is there after a chat switch or a restart, not only live. The
  // array keeps its identity while a reply streams, so tokens do not re-render.
  const lanes = useChat((s) => s.messages.findLast((m) => m.contextLanes)?.contextLanes) ?? NO_LANES;
  // The real prompt size once a reply has run; the saved lanes, then the old
  // step-count guess, before that.
  const livePrompt = useChat((s) => s.livePromptTokens);
  const used = livePrompt ?? (lanes.length > 0 ? lanes.reduce((n, l) => n + l.tokens, 0) : usedSteps * 500);
  const pct = ctxWindow ? Math.min(1, used / ctxWindow) : null;
  const made = madeHere ? madeHere.split('\n') : [];
  const fileCount = ctx.files.length + ctx.artifactIds.length;
  const state = status === 'streaming' ? 'Working' : approvals.length > 0 ? 'Needs you' : 'Ready';
  const count = (n: number, one: string, many: string) => (n === 0 ? 'None' : `${n} ${n === 1 ? one : many}`);

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-2 px-3 pb-5">
        {approvals.length > 0 && (
          <Fold id="ctx-approvals" icon={ShieldCheck} title="Needs your OK" value={String(approvals.length)} alert defaultOpen>
            {approvals.map((e) => <ApprovalCard key={e.id} e={e} />)}
          </Fold>
        )}

        <section aria-label="This chat" className={cn('flex flex-col px-3.5 py-2.5', SQUIRCLE)}>
          <Line label="Model">
            {cloudId && <ModelLogo modelId={cloudId} className="size-4 shrink-0" />}
            <span className="truncate">{model ?? 'None chosen'}</span>
          </Line>
          <Line label="Access">
            <span className={cn('truncate', accessMode === 'full_access' && 'text-warning')}>{MODES[accessMode].label}</span>
          </Line>
          <Line label="Status"><span className="truncate">{state}</span></Line>
        </section>

        <AnimatePresence initial={false}>
          {hasWorkers && (
            <Live key="workers" still={still}>
              <WorkersCard inPanel />
            </Live>
          )}
          {page && (
            <Live key="page" still={still}>
              <section aria-label="Browser">
                <button type="button" onClick={() => useBrowser.getState().setPanel(true)} className={cn('flex h-11 w-full items-center gap-2.5 px-3.5 text-left hover:bg-bg-hover', SQUIRCLE)}>
                  <Globe size={16} className="shrink-0 text-text-secondary" />
                  <span className="text-sm font-medium text-text-primary">Browser</span>
                  <span className="flex-1" />
                  <span className="min-w-0 truncate text-sm text-text-muted" title={page.split('\n')[1]}>{page.split('\n')[0]}</span>
                </button>
              </section>
            </Live>
          )}
        </AnimatePresence>

        {project && <ProjectGroup project={project} />}

        <section aria-label="Context used" className={cn('flex flex-col gap-2 px-3.5 py-3', SQUIRCLE)}>
          <div className="flex items-center gap-2.5">
            <Gauge size={16} className="shrink-0 text-text-secondary" />
            <span className="text-sm font-medium text-text-primary">Context</span>
            <span className="flex-1" />
            <span className="text-sm text-text-muted">{pct === null ? 'Unknown' : `${pct < 0.01 ? '<1' : Math.round(pct * 100)}%`}</span>
          </div>
          {pct !== null && lanes.length === 0 && (
            <div className="h-1 overflow-hidden rounded-full bg-bg-hover" aria-hidden>
              <div
                className={cn('h-full rounded-full', pct >= 0.9 ? 'bg-error' : pct >= 0.75 ? 'bg-warning' : 'bg-text-muted')}
                style={{ width: `${Math.max(2, pct * 100)}%` }}
              />
            </div>
          )}
          {/* What the room is filled with, like Claude Code's /context: one bar in
              lanes, then each lane with its share. Our own token count. */}
          {ctxWindow && lanes.length > 0 && <ContextLanes lanes={lanes} window={ctxWindow} />}
        </section>

        <Fold id="ctx-memory" icon={Brain} title="Memory" value={count(ctx.memories.length, 'used', 'used')} onAdd={onCompose && (() => onCompose('Remember that '))} addLabel="Add a memory">
          {ctx.memories.length > 0 && <Rows>{ctx.memories.map((m, i) => <MemoryItem key={`${m.kind}-${i}`} m={m} />)}</Rows>}
        </Fold>

        <Fold id="ctx-files" icon={Paperclip} title="Files" value={count(fileCount, 'file', 'files')} onAdd={onAttach} addLabel="Add files">
          {fileCount > 0 && (
            <Rows>
              {ctx.files.map((f) => {
                const t = fileTile(f);
                return <Row key={`${f.kind}:${f.name}`} tile={<t.icon size={16} className={t.cls} />} title={f.name} sub={t.what} />;
              })}
              {made.map((name) => <Row key={`made:${name}`} tile={<FileText size={16} className="text-brand" />} title={name} sub="Made in this chat" />)}
              {ctx.artifactIds.length > made.length && (
                <Row tile={<FileText size={16} className="text-brand" />} title={`${ctx.artifactIds.length - made.length} made in this chat`} sub="Open them from Artifacts" />
              )}
            </Rows>
          )}
        </Fold>

        <Fold id="ctx-sources" icon={Globe} title="Sources" value={count(ctx.sources.length, 'page', 'pages')} onAdd={onCompose && (() => onCompose('Read this page: '))} addLabel="Add a link">
          {ctx.sources.length > 0 && (
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
          )}
        </Fold>

        <Fold id="ctx-apps" icon={Plug} title="Connected" value={count(apps.length, 'app', 'apps')}>
          {apps.length > 0 && (
            <Rows>
              {apps.map((a) => (
                <Row
                  key={a.id}
                  tile={a.logo_url ? <img src={a.logo_url} alt="" className="h-4 w-4 rounded" /> : <span className="text-2xs">{a.name[0]}</span>}
                  title={a.name}
                  sub={a.linked ? 'Connected' : 'Set up'}
                />
              ))}
            </Rows>
          )}
        </Fold>
      </div>
    </ScrollArea>
  );
}

const NO_LANES: ContextLane[] = [];
const LANE_TINT = ['bg-brand', 'bg-[#4f7cff]', 'bg-[#2fb37a]', 'bg-[#c58cff]', 'bg-[#e0a33a]', 'bg-text-muted', 'bg-text-disabled'];

function ContextLanes({ lanes, window }: { lanes: ContextLane[]; window: number }) {
  const total = lanes.reduce((n, l) => n + l.tokens, 0);
  const free = Math.max(0, window - total);
  const share = (t: number) => `${((t / window) * 100).toFixed(t / window < 0.1 ? 1 : 0)}%`;
  const k = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-bg-hover" aria-hidden>
        {lanes.map((l, i) => (
          <div key={l.label} className={LANE_TINT[i % LANE_TINT.length]} style={{ width: `${(l.tokens / window) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {lanes.map((l, i) => (
          <li key={l.label} className="flex items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-[2px]', LANE_TINT[i % LANE_TINT.length])} />
            <span className="flex-1 text-text-secondary">{l.label}</span>
            <span className="tabular-nums text-text-muted">{k(l.tokens)}</span>
            <span className="w-11 text-right tabular-nums text-text-muted">{share(l.tokens)}</span>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[2px] border border-border-default" />
          <span className="flex-1 text-text-muted">Free</span>
          <span className="tabular-nums text-text-muted">{k(free)}</span>
          <span className="w-11 text-right tabular-nums text-text-muted">{share(free)}</span>
        </li>
      </ul>
    </div>
  );
}
