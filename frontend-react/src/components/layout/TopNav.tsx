import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Box, Settings, MessageSquare, FolderPlus } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { NewProjectDialog } from '@/components/items/NewProjectDialog';
import { useUI } from '@/stores/ui';
import { cn } from '@/lib/utils';

/**
 * The persistent chrome, per the UX contract: four items and a settings
 * affordance, floating and visually subordinate to the page. It replaces a
 * nine-item rail.
 *
 * Anchored left and sized by its content rather than stretched across the
 * window, because the top-right strip belongs to the window controls and the
 * download status, and those are the one layer a page may never cover. A bar
 * that reached for the right edge would collide with them at some window
 * width — probably not this one, and probably not today.
 */

function NavButton({
  icon: Icon, label, onClick, shortcut,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  onClick: () => void;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        'h-8 px-3 rounded-xl flex items-center gap-2 text-sm text-text-secondary',
        'hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function TopNav() {
  const navigate = useNavigate();
  const openSearch = useUI((s) => s.openSearch);
  const [projectOpen, setProjectOpen] = useState(false);

  const newChat = () => {
    navigate('/chat');
    window.dispatchEvent(new CustomEvent('feral:new-chat'));
  };

  return (
    <>
      <nav
        aria-label="Main"
        className={cn(
          'h-11 flex items-center gap-1 pl-3 pr-2',
          'rounded-2xl border border-border-subtle bg-bg-surface/70 backdrop-blur shadow-lg',
        )}
      >
        <span className="select-none font-semibold text-sm text-text-primary tracking-wide mr-1">
          FERAL
        </span>

        {/* One creation door, two things behind it. The rail had these as two
            rows and labelled the second one ⌘P, a shortcut nothing implemented. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'h-8 px-3 rounded-xl flex items-center gap-2 text-sm text-text-secondary',
                'hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer',
              )}
            >
              <Plus size={15} className="shrink-0" />
              <span className="hidden sm:inline">New</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={newChat} className="gap-2">
              <MessageSquare size={14} />
              New chat
              <span className="ml-auto text-[11px] text-text-muted">⌘N</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setProjectOpen(true)} className="gap-2">
              <FolderPlus size={14} />
              New project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <NavButton icon={Box} label="Models" onClick={() => navigate('/models')} />
        <NavButton icon={Search} label="Search" onClick={openSearch} shortcut="⌘K" />

        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="Settings"
          title="Settings"
          className="h-8 w-8 ml-1 rounded-xl flex items-center justify-center text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
        >
          <Settings size={15} />
        </button>
      </nav>

      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </>
  );
}
