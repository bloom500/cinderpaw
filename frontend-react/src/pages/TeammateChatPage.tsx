import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CoworkAvatar, CoworkBubble, CoworkComposer, toMessages } from '@/components/chat/CoworkTranscriptPanel';
import { tauri } from '@/lib/tauri';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { threadExchanges, useCoworkTranscript } from '@/stores/coworkTranscript';

function TeammateChat({ id, name }: { id: string; name: string }) {
  const threadId = `cowork:${id}`;
  const ready = useCinderpawStore((s) => s.isReady);
  const all = useCoworkTranscript((s) => s.exchanges);
  const exchanges = threadExchanges(all, threadId);
  const messages = toMessages(exchanges);
  const running = exchanges.some((e) => e.kind !== 'approval' && e.status === 'running');
  const [historyFailed, setHistoryFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    let current = true;
    void tauri.cinderpawAgent.coworkHistory(threadId).then(
      () => { if (current) setHistoryFailed(false); },
      () => { if (current) setHistoryFailed(true); },
    );
    return () => { current = false; };
  }, [threadId, ready, readAttempt]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, running]);

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col" aria-label={`Chat with ${name}`}>
      <header className="flex items-center gap-2.5 border-b border-border-default p-4">
        <CoworkAvatar id={id} name={name} className="size-8" />
        <h1 className="truncate font-semibold text-text-primary">{name}</h1>
      </header>
      {historyFailed && <div role="alert" className="flex items-center gap-2 p-4 text-sm text-text-muted">
        Couldn't load messages.
        <button type="button" onClick={() => setReadAttempt((n) => n + 1)} className="text-brand underline">Try again</button>
      </div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="space-y-3" aria-label="Messages">
          {messages.map((m) => <CoworkBubble key={m.key} m={m} showAuthor />)}
        </ul>
        {running && <p role="status" className="mt-3 text-sm text-text-muted">{name} is working…</p>}
        <div ref={end} />
      </div>
      <CoworkComposer participants={[[id, name]]} defaultTo={id} threadId={threadId} />
    </section>
  );
}

export function TeammateChatPage() {
  const { id } = useParams();
  const teammate = useCoworkTeam((s) => s.roster.find((agent) => agent.id === id));
  const loaded = useCoworkTeam((s) => s.loaded);
  if (teammate) return <TeammateChat key={teammate.id} id={teammate.id} name={teammate.name} />;
  if (!loaded) return null;
  return <div className="p-4 text-sm text-text-muted">
    This teammate is gone. <Link to="/chat" className="text-brand underline">Go back to chat</Link>
  </div>;
}
