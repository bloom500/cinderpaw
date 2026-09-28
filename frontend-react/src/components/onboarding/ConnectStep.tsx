import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { tauri, type ConnectorCatalogEntry, type ConnectorView, type McpCatalogEntry } from '@/lib/tauri';
import { BrandLogo } from '@/lib/brandLogos';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CatalogCard } from '@/pages/ExtensionsPage';
import { ConnectorCard } from '@/pages/ConnectorsPage';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import { useOnboarding } from '@/stores/onboarding';
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
    <div className={cn(
      'flex items-center gap-3.5 rounded-2xl border bg-bg-surface py-3.5 pl-4 pr-3.5',
      connected ? 'border-success/40' : 'border-border-default',
    )}>
      <BrandLogo id={id} name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text-primary">{name}</span>
        <span className="block truncate text-2xs text-text-disabled" title={line}>{line}</span>
      </span>
      {connected ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
          <Check size={12} /> Connected
        </span>
      ) : onConnect ? (
        <button
          type="button"
          onClick={onConnect}
          aria-label={`Connect ${name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-default text-text-muted hover:border-brand/50 hover:text-brand"
        >
          <Plus size={16} />
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
  const shownChats = allChats ? [...firstChats, ...moreChats] : firstChats;

  return (
    <div className="flex flex-col">
      <h2 className="font-display text-3xl font-normal text-text-primary">Connect your world.</h2>
      <p className="mt-2 max-w-xl text-base text-text-muted">
        Bring in the tools you already use, so Cinderpaw can work in them, not only talk about them.
      </p>

      <p className="mt-6 text-2xs font-semibold uppercase tracking-wider text-text-disabled">Your tools</p>
      <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {tools.map((t) => (
          <Card key={t.id} id={t.id} name={t.name} line={t.description} connected={installed.has(t.id)}
            onConnect={() => setOpen({ kind: 'tool', entry: t })} />
        ))}
        {/* Send-only (drive.file), and it signs in the first time a document is
            sent, in the Browser panel, which this wizard covers: so no button here. */}
        <Card id="google_docs" name="Google Docs" line="Connects the first time you send a document" connected={false} />
      </div>

      <p className="mt-5 text-2xs font-semibold uppercase tracking-wider text-text-disabled">Where you chat</p>
      <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {shownChats.map((c) => {
          const s = savedById.get(c.id);
          return (
            <Card key={c.id} id={c.id} name={c.name} line={c.description} connected={!!s?.enabled}
              onConnect={() => setOpen({ kind: 'chat', entry: c })} />
          );
        })}
        {!allChats && moreChats.length > 0 && (
          <button
            type="button"
            onClick={() => setAllChats(true)}
            className="flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border-default py-3.5 text-sm text-text-muted hover:text-text-secondary"
          >
            {moreChats.length} more <ChevronDown size={14} />
          </button>
        )}
      </div>

      <div className="mt-6 flex items-end gap-3">
        <span aria-hidden className="relative -mb-2 h-16 w-16 shrink-0 overflow-hidden">
          <span className="absolute left-0 top-0 origin-top-left scale-50"><CinderpawMascot state="wave" /></span>
        </span>
        <p className="mb-2 max-w-sm rounded-2xl rounded-bl-sm border border-border-default bg-bg-elevated px-3.5 py-2.5 text-sm text-text-primary">
          Connect one or two now. The rest can wait in Settings, under Accounts.
        </p>
        <span className="flex-1" />
        <button type="button" onClick={next} className="mb-2 px-3 py-2 text-sm font-medium text-text-muted hover:text-text-secondary">
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
