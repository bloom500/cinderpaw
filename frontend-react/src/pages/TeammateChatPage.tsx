import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Maximize2, PanelRight, X } from 'lucide-react';
import coworkMascots from '@/assets/cowork-mascots.webp';
import { ContextColumn } from '@/components/artifacts/ContextColumn';
import { ChatInput, type ChatInputHandle, type ChatInputProps } from '@/components/chat/ChatInput';
import { ChatSpendControl } from '@/components/chat/ChatSpendControl';
import { CoworkAvatar, coworkCharacterSprite } from '@/components/chat/CoworkTranscriptPanel';
import { MessageList } from '@/components/chat/MessageList';
import { Button } from '@/components/ui/button';
import { tauri, type CoworkTeammate } from '@/lib/tauri';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { ChatScopeProvider } from '@/stores/chatScope';
import { getCoworkChat, sendCoworkChat } from '@/stores/coworkChat';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useUI } from '@/stores/ui';
import { cn } from '@/lib/utils';

const MAX_CHAT_PANELS = 4;

function TeammateChat({
  id, name, role, compact, onClose, focus, showContext,
}: Pick<CoworkTeammate, 'id' | 'name' | 'role'> & { compact: boolean; onClose?: () => void; focus: boolean; showContext: boolean }) {
  const threadId = `cowork:${id}`;
  const ready = useCinderpawStore((s) => s.isReady);
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const active = exchanges.findLast((e) => e.kind !== 'approval' && e.toAgentId === id && e.status === 'running' && e.startedAt != null);
  const queued = exchanges.some((e) => e.kind !== 'approval' && e.toAgentId === id && e.status === 'running' && e.startedAt == null);
  const approval = exchanges.some((e) => e.kind === 'approval' && e.fromAgentId === id && e.status === 'running');
  const presence = !ready ? 'Disconnected' : approval ? 'Needs approval' : active ? 'Working' : queued ? 'Queued' : 'Available';
  const [historyFailed, setHistoryFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const input = useRef<ChatInputHandle>(null);
  const send = useCallback<ChatInputProps['sendFn']>((text, images, options) =>
    sendCoworkChat(threadId, text, images, options), [threadId]);
  const scope = useMemo(() => ({
    store: getCoworkChat(threadId).store, name, send,
    mascot: <span aria-hidden className="block size-32" style={coworkCharacterSprite(id, coworkMascots)} />,
  }), [id, name, send, threadId]);

  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void tauri.cinderpawAgent.coworkHistory(threadId).then(
      () => { if (current) setHistoryFailed(false); },
      () => { if (current) setHistoryFailed(true); },
    );
    return () => { current = false; };
  }, [threadId, ready, readAttempt]);

  return (
    <ChatScopeProvider value={scope}>
      <div className="flex h-full min-h-0 min-w-0">
      <section data-chat-drop-target="" className={cn('flex h-full min-h-0 min-w-0 w-full flex-col',
        compact ? 'rounded-xl border border-border-default' : 'mx-auto max-w-3xl')} aria-label={`Chat with ${name}`}>
        <header className="flex items-center gap-2.5 border-b border-border-default p-4">
          <CoworkAvatar id={id} name={name} className="size-8" />
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-text-primary">{name}</h1>
            <p role="status" aria-label="Availability" className={cn('truncate text-xs', active ? 'text-brand' : 'text-text-muted')}
              title={active?.requestText ?? undefined}>
              {presence}{active?.requestText ? ` · ${active.requestText}` : ''}
            </p>
          </div>
          <div className="ml-auto flex min-w-0 max-w-[50%] items-center gap-1">
            {role.trim() && <p className="truncate text-right text-sm text-text-muted" title={role}>{role}</p>}
            {!compact && <ChatSpendControl key={threadId} sessionId={threadId} />}
            {compact && <>
              <Link to={`/teammates/${encodeURIComponent(id)}`} aria-label={`Focus ${name}`}
                className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary">
                <Maximize2 size={14} />
              </Link>
              {onClose && <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0"
                aria-label={`Close ${name} panel`} onClick={onClose}><X size={14} /></Button>}
            </>}
          </div>
        </header>
        {historyFailed && <div role="alert" className="flex items-center gap-2 p-4 text-sm text-text-muted">
          Couldn't load messages.
          <button type="button" onClick={() => setReadAttempt((n) => n + 1)} className="text-brand underline">Try again</button>
        </div>}
        <div className="min-h-0 flex-1">
          <MessageList onFollowUp={(text) => input.current?.setText(text)} onAnswer={(text) => void send(text)} />
        </div>
        <div className="relative shrink-0 px-4 pb-4">
          <ChatInput ref={input} sendFn={send} />
        </div>
      </section>
      {showContext && <ContextColumn teammateId={id} onCompose={(text) => input.current?.setText(text)}
        onAttach={() => void openFileDialog({ multiple: true }).then((paths) => {
          if (paths) input.current?.attachPaths(Array.isArray(paths) ? paths : [paths]);
        })} />}
      </div>
    </ChatScopeProvider>
  );
}

export function TeammateChatPage() {
  const { id } = useParams();
  const { state: routeState } = useLocation();
  const [params, setParams] = useSearchParams();
  const roster = useCoworkTeam((s) => s.roster);
  const teammate = roster.find((agent) => agent.id === id);
  const loaded = useCoworkTeam((s) => s.loaded);
  const contextOpen = useUI((s) => s.contextOpen);
  const setContextOpen = useUI((s) => s.setContextOpen);
  if (!teammate) return loaded ? <div className="p-4 text-sm text-text-muted">
    This teammate is gone. <Link to="/chat" className="text-brand underline">Go back to chat</Link>
  </div> : null;

  const extra = [...new Set(params.getAll('panel'))]
    .filter((panel) => panel !== id)
    .flatMap((panel) => roster.filter((agent) => agent.id === panel))
    .slice(0, MAX_CHAT_PANELS - 1);
  const panels = [teammate, ...extra];
  const split = panels.length > 1;
  const canAdd = panels.length < MAX_CHAT_PANELS;
  const choices = roster.filter((agent) => !panels.some((panel) => panel.id === agent.id));
  const teamContext = !split;
  const updatePanels = (ids: string[]) => {
    const next = new URLSearchParams(params);
    next.delete('panel');
    ids.forEach((panel) => next.append('panel', panel));
    setParams(next, { replace: true });
  };

  return <div className="flex h-full min-h-0 flex-col">
    {(choices.length > 0 && canAdd || teamContext) && (
      <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-2">
        {choices.length > 0 && canAdd && <select aria-label="Add a chat panel" value=""
          className="rounded-lg border border-border-default bg-bg-surface px-2 py-1.5 text-sm text-text-primary"
          onChange={(event) => updatePanels([...extra.map((agent) => agent.id), event.target.value])}>
          <option value="" disabled>Add a chat panel</option>
          {choices.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
        </select>}
        {teamContext && <Button type="button" variant="ghost" size="sm" aria-pressed={contextOpen}
          className="hidden lg:inline-flex" onClick={() => setContextOpen(!contextOpen)}>
          <PanelRight size={14} aria-hidden /> Context
        </Button>}
      </div>
    )}
    <div className="flex min-h-0 flex-1">
      <div className={cn('grid min-h-0 min-w-0 flex-1', split
        ? 'grid-cols-1 auto-rows-[minmax(18rem,1fr)] gap-2 overflow-y-auto p-2 md:grid-cols-2'
        : 'grid-rows-[minmax(0,1fr)]')}>
        {panels.map((panel) => <TeammateChat key={panel.id} id={panel.id} name={panel.name} role={panel.role}
          compact={split} showContext={teamContext && contextOpen} focus={panel.id === id && routeState?.focusTeammateComposer === true}
          onClose={panel.id !== id ? () => updatePanels(extra.filter((agent) => agent.id !== panel.id).map((agent) => agent.id)) : undefined}
        />)}
      </div>
    </div>
  </div>;
}
