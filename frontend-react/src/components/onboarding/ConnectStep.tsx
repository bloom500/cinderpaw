import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, ShieldCheck } from 'lucide-react';
import { tauri, type ConnectorCatalogEntry, type ConnectorView, type McpCatalogEntry } from '@/lib/tauri';
import { BrandLogo } from '@/lib/brandLogos';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CatalogCard } from '@/pages/ExtensionsPage';
import { ConnectorCard } from '@/pages/ConnectorsPage';
import { useOnboarding } from '@/stores/onboarding';
import { StepIntro } from './OnboardingWizard';
import { cn } from '@/lib/utils';

/** "Your tools": these MCP presets first, when the catalog has them (spec 7.3). */
export const TOOL_IDS = ['notion', 'github', 'linear', 'todoist', 'jira', 'airtable'] as const;
/** "Where you chat": these transports first; the rest behind "N more". */
export const CHAT_IDS = ['slack', 'discord', 'telegram', 'whatsapp', 'googlechat'] as const;

/** Catalog entries in the order `ids` names them, then nothing else. */
export function pick<T extends { id: string }>(all: T[], ids: readonly string[]): T[] {
  return ids.flatMap((id) => all.filter((e) => e.id === id));
}

function Card({ id, name, line, connected, onConnect }: {
  id: string;
  name: string;
  line: string;
  connected: boolean;
  onConnect?: () => void;
}) {
  return (
    <div
      title={line}
      className={cn(
        'flex items-center gap-2.5 rounded-2xl border bg-bg-surface py-2 pl-2 pr-2.5',
        connected ? 'border-success/40' : 'border-border-default',
      )}
    >
      <BrandLogo id={id} name={name} className="size-8 border-0" />
      <span className="truncate font-display text-sm text-text-primary">{name}</span>
      {connected ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
          <Check size={12} /> Connected
        </span>
      ) : onConnect ? (
        <button
          type="button"
          onClick={onConnect}
          aria-label={`Connect ${name}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-muted hover:text-brand"
        >
          <Plus size={14} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Onboarding's "Connect your world" (spec 7.3): real integrations only. Two
 * groups, "Your tools" (MCP presets, plus Google Docs) and "Where you chat"
 * (the chat transports, the rest behind "N more"). Nothing is pre-selected and
 * Skip is always there. "+" opens the same form Settings uses to connect it,
 * so a card connected here is connected for real.
 */
export function ConnectStep() {
  const next = useOnboarding((s) => s.next);
  const [tools, setTools] = useState<McpCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [chats, setChats] = useState<ConnectorCatalogEntry[]>([]);
  const [saved, setSaved] = useState<ConnectorView[]>([]);
  const [allChats, setAllChats] = useState(false);
  const [open, setOpen] = useState<{ kind: 'tool'; entry: McpCatalogEntry } | { kind: 'chat'; entry: ConnectorCatalogEntry } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = () => {
    tauri.mcp.list().then((l) => { if (alive.current) setInstalled(new Set(l.map((s) => s.id))); }).catch(() => {});
    tauri.connectors.list().then((l) => { if (alive.current) setSaved(l); }).catch(() => {});
  };
  useEffect(() => {
    tauri.mcp.catalog().then((c) => { if (alive.current) setTools(pick(c, TOOL_IDS)); }).catch(() => {});
    tauri.connectors.catalog().then((c) => { if (alive.current) setChats(c.filter((e) => !e.coming_soon)); }).catch(() => {});
    refresh();
  }, []);

  const savedById = new Map(saved.map((s) => [s.id, s]));
  const firstChats = pick(chats, CHAT_IDS);
  const moreChats = chats.filter((c) => !(CHAT_IDS as readonly string[]).includes(c.id));

  return (
    <div className="flex flex-col">
      <StepIntro
        title="Connect your world"
        lead="Bring your tools, files, and conversations into one place."
        body="Connect apps so your agent can search, create, and act with your approval."
      />

      <div className="mt-6 flex flex-wrap gap-2.5">
        {tools.map((t) => (
          <Card key={t.id} id={t.id} name={t.name} line={t.description} connected={installed.has(t.id)}
            onConnect={() => setOpen({ kind: 'tool', entry: t })} />
        ))}
        {/* Send-only (drive.file), and it signs in the first time a document is
            sent, in the Browser panel, which this wizard covers: so no button here. */}
        <Card id="google_docs" name="Google Docs" line="Connects the first time you send a document" connected={false} />
        {firstChats.map((c) => {
          const s = savedById.get(c.id);
          return (
            <Card key={c.id} id={c.id} name={c.name} line={c.description} connected={!!s?.enabled}
              onConnect={() => setOpen({ kind: 'chat', entry: c })} />
          );
        })}
        {moreChats.length > 0 && (
          <button
            type="button"
            onClick={() => setAllChats(true)}
            className="flex items-center gap-1.5 rounded-2xl border border-dashed border-border-default px-4 text-sm text-text-muted hover:text-text-secondary"
          >
            {moreChats.length} more <ChevronDown size={14} />
          </button>
        )}
      </div>

      {/* The rest open in their own window rather than below, so the board
          itself never grows into a scroll. */}
      <Dialog open={allChats} onOpenChange={setAllChats}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>More apps to connect</DialogTitle>
          <div className="flex flex-wrap gap-2.5">
            {moreChats.map((c) => (
              <Card key={c.id} id={c.id} name={c.name} line={c.description} connected={!!savedById.get(c.id)?.enabled}
                onConnect={() => { setAllChats(false); setOpen({ kind: 'chat', entry: c }); }} />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <div className="mt-5 flex flex-wrap items-center gap-4 rounded-2xl bg-bg-surface px-4 py-3.5">
        <ShieldCheck size={28} className="shrink-0 text-brand" />
        <span className="min-w-0 flex-1">
          <span className="block font-display text-base text-text-primary">Secure and private</span>
          <span className="block text-xs text-text-muted">
            Cinderpaw only reaches what you approve. Review or remove a connection anytime in Settings, under Accounts.
          </span>
        </span>
        <button type="button" onClick={next} className="px-2 py-1 text-sm font-medium text-text-muted underline underline-offset-4 hover:text-text-secondary">
          Skip for now
        </button>
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => { if (!o) { setOpen(null); refresh(); } }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>{open ? `Connect ${open.entry.name}` : ''}</DialogTitle>
          {open?.kind === 'tool' && (
            <CatalogCard entry={open.entry} installed={installed.has(open.entry.id)}
              onInstalled={() => { refresh(); setOpen(null); }} />
          )}
          {open?.kind === 'chat' && (
            <ConnectorCard entry={open.entry} state={savedById.get(open.entry.id) ?? null} onChanged={refresh} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
