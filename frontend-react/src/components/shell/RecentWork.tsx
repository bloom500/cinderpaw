/**
 * Phase 4 S4 — "where was I", off the rail and onto Home.
 *
 * The sidebar's conversation list answered one question people actually ask on
 * launch: what was I doing last? Search answers "where is that thing I
 * remember", which is a different question — you have to already know what you
 * are looking for. So Home gets the continuation, and the rail loses its last
 * reason to exist.
 *
 * The UX contract allows at most two cards here, "only when they have
 * something real to say". That is the whole design constraint, and it is what
 * keeps this from becoming the sidebar lying down: exactly one chat and one
 * project, never a list. A fresh install has neither and renders nothing.
 */

import { useNavigate } from 'react-router-dom';
import { MessageSquare, Folder, type LucideIcon } from 'lucide-react';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';
import { useUI } from '@/stores/ui';
import { formatRelative } from '@/components/shell/WelcomeBack';

function Card({
  icon: Icon, label, title, meta, onClick,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-64 text-left rounded-xl border border-border-subtle bg-bg-surface/60 hover:bg-bg-hover hover:border-border-default px-4 py-3 transition-colors pointer-events-auto"
    >
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted">
        <Icon size={11} className="shrink-0" />
        {label}
      </span>
      <span className="mt-1 block text-sm text-text-primary truncate">{title}</span>
      <span className="mt-0.5 block text-[11px] text-text-muted truncate">{meta}</span>
    </button>
  );
}

/** Newest first, by the timestamp the list is actually ordered on. */
function byRecency(a: ConversationSummary, b: ConversationSummary): number {
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

interface RecentItems {
  lastConv: ConversationSummary | null;
  lastProject: { project: Project; conv: ConversationSummary } | null;
}

/**
 * What Home has to show, or null when there is nothing.
 *
 * Exported because the layout above the composer has to reserve room for the
 * cards ONLY when they exist — a fresh install must keep the greeting exactly
 * where it was, not float it up over a gap where cards would have been.
 */
export function useRecentWork(): RecentItems | null {
  const convs    = useConversations((s) => s.list);
  const projects = useProjects((s) => s.list);

  const sorted   = [...(convs ?? [])].sort(byRecency);
  const lastConv = sorted[0] ?? null;

  // A project carries no timestamp of its own, so its recency is the newest
  // conversation inside it — which is what "recently worked on" means anyway.
  // An empty project has no activity to report and is skipped rather than
  // shown with a blank date.
  const byId = new Map(sorted.map((c) => [c.id, c]));
  let lastProject: { project: Project; conv: ConversationSummary } | null = null;
  for (const project of projects) {
    const newest = project.conversation_ids
      .map((id) => byId.get(id))
      .filter((c): c is ConversationSummary => Boolean(c))
      .sort(byRecency)[0];
    if (!newest) continue;
    if (!lastProject || byRecency(newest, lastProject.conv) < 0) {
      lastProject = { project, conv: newest };
    }
  }

  if (!lastConv && !lastProject) return null;
  return { lastConv, lastProject };
}

export function RecentWork() {
  const navigate   = useNavigate();
  const openSearch = useUI((s) => s.openSearch);
  const items      = useRecentWork();
  if (!items) return null;
  const { lastConv, lastProject } = items;

  return (
    <div className="mt-6 flex flex-wrap justify-center gap-3 px-6">
      {lastConv && (
        <Card
          icon={MessageSquare}
          label="Continue"
          title={lastConv.title}
          meta={formatRelative(new Date(lastConv.updated_at).getTime())}
          onClick={() => { void useConversations.getState().open(lastConv.id); navigate('/chat'); }}
        />
      )}
      {lastProject && (
        <Card
          icon={Folder}
          label="Project"
          title={lastProject.project.name}
          /* Opening it narrows Search to the project — the same answer picking
             a project result gives, because showing what is inside a container
             is the honest response to opening one. */
          meta={`${lastProject.project.conversation_ids.length} ${lastProject.project.conversation_ids.length === 1 ? 'chat' : 'chats'} · ${formatRelative(new Date(lastProject.conv.updated_at).getTime())}`}
          onClick={() => openSearch(lastProject.project.id)}
        />
      )}
    </div>
  );
}
