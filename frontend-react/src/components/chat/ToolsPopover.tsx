import { Wrench, Search, Globe, FolderOpen, Pencil, Zap, type LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUI, type ToolId } from '@/stores/ui';

const TOOLS: { id: ToolId; label: string; Icon: LucideIcon }[] = [
  { id: 'web_search',   label: 'Web Search',   Icon: Search },
  { id: 'http_request', label: 'HTTP Request',  Icon: Globe },
  { id: 'file_read',    label: 'File Read',     Icon: FolderOpen },
  { id: 'file_write',   label: 'File Write',    Icon: Pencil },
  { id: 'code_execute', label: 'Code Execute',  Icon: Zap },
];

export function ToolsPopover() {
  const enabledTools = useUI((s) => s.enabledTools);
  const toggleTool = useUI((s) => s.toggleTool);
  const activeCount = enabledTools.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative p-1.5 rounded hover:bg-bg-hover',
            activeCount > 0 ? 'text-brand' : 'text-text-muted hover:text-text-secondary',
          )}
          aria-label="Tools"
        >
          <Wrench size={16} />
          {activeCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand text-[8px] font-bold text-white leading-none">
              {activeCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-44">
        <DropdownMenuLabel className="text-xs text-text-muted">Tools</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TOOLS.map(({ id, label, Icon }) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={enabledTools.includes(id)}
            onCheckedChange={() => toggleTool(id)}
            onSelect={(e) => e.preventDefault()}
            className="gap-2 text-sm"
          >
            <Icon size={13} />
            {label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
