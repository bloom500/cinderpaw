import { useMemo, type ReactNode } from 'react';
import { File, FileText, Image } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ApprovalCard } from '@/components/chat/ApprovalCard';
import { SiteIcon } from '@/components/chat/LinkChip';
import { MemoryRow } from '@/components/chat/MemoryPeek';
import { CHAT_TOOLS, SwitchRow } from '@/components/chat/ToolsMenu';
import { chatContext } from '@/lib/chatContext';
import { siteName } from '@/lib/sources';
import { useChat } from '@/stores/chat';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useUI } from '@/stores/ui';

const FILE_ICONS = { text: FileText, image: Image, binary: File } as const;

function openUrl(url: string) {
  void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-text-disabled">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The Context tab (spec 7.5, Context drawer): what this chat has put in front
 * of Cinderpaw. Files attached, sources read, memory used, pending approvals,
 * and the Chat mode tool switches. Every row comes from the chat's own
 * messages (`chatContext`) or a store; nothing is drawn that did not happen.
 * A project's instructions and files join the top in the projects slice.
 */
export function ContextTab() {
  const messages = useChat((s) => s.messages);
  const ctx = useMemo(() => chatContext(messages), [messages]);
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const threadId = useCoworkTranscript((s) => s.activeThreadId);
  const approvals = exchanges.filter((e) => e.kind === 'approval' && e.status === 'running' && !!threadId && e.threadId === threadId);
  const inputMode = useUI((s) => s.inputMode);
  const enabledTools = useUI((s) => s.enabledTools);
  const toggleTool = useUI((s) => s.toggleTool);

  const empty = ctx.files.length === 0 && ctx.sources.length === 0 && ctx.memories.length === 0 && approvals.length === 0;

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-5 px-4 py-4">
        {empty && (
          <p className="text-sm text-text-muted">
            Nothing here yet. Files you add, pages Cinderpaw reads and memories it uses will show up here.
          </p>
        )}
        {approvals.length > 0 && (
          <Section title="Waiting for you">
            {approvals.map((e) => <ApprovalCard key={e.id} e={e} />)}
          </Section>
        )}
        {ctx.files.length > 0 && (
          <Section title="Files attached">
            <ul className="flex flex-col gap-1">
              {ctx.files.map((f) => {
                const Icon = FILE_ICONS[f.kind];
                return (
                  <li key={`${f.kind}:${f.name}`} className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
                    <Icon size={14} className="shrink-0 text-text-muted" />
                    <span className="truncate" title={f.name}>{f.name}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
        {ctx.sources.length > 0 && (
          <Section title="Sources read">
            <ul className="flex flex-col gap-1">
              {ctx.sources.map((h) => (
                <li key={h.url}>
                  <button
                    type="button"
                    onClick={() => openUrl(h.url)}
                    title={h.url}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-text-primary/5"
                  >
                    <SiteIcon href={h.url} />
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{h.title || siteName(h)}</span>
                    <span className="shrink-0 text-2xs text-text-disabled">{siteName(h)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {ctx.memories.length > 0 && (
          <Section title="Memory used">
            <ul>
              {ctx.memories.map((m, i) => <MemoryRow key={`${m.kind}-${i}`} m={m} />)}
            </ul>
          </Section>
        )}
        <Section title="Tools">
          {inputMode === 'chat' ? (
            <div className="-mx-2 flex flex-col">
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
            <p className="text-sm text-text-muted">In Agent mode Cinderpaw picks the tools it needs for each task.</p>
          )}
        </Section>
      </div>
    </ScrollArea>
  );
}
