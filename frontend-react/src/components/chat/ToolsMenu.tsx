import { SlidersHorizontal, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUI, type ToolId } from '@/stores/ui';
import { useModel } from '@/stores/model';
import { modelSupportsThinking } from '@/lib/modelUtils';
import { cn } from '@/lib/utils';

/**
 * Chat mode's tools, in menu order. The ids are the ones the host's chat path
 * turns into tool definitions (`ToolType::from_name` in cinderpaw-core); an id
 * it does not know would be a switch that does nothing, so none is added here
 * that is not there first.
 */
export const CHAT_TOOLS: ReadonlyArray<{ id: ToolId; label: string; hint: string }> = [
  { id: 'web_search',   label: 'Web search',   hint: 'Look things up online' },
  { id: 'http_request', label: 'Web requests', hint: 'Open a page or call an API' },
  { id: 'file_read',    label: 'Read files',   hint: 'Open files on this computer' },
  { id: 'file_write',   label: 'Write files',  hint: 'Save files on this computer' },
  { id: 'code_execute', label: 'Run code',     hint: 'Run code to work something out' },
];

export function SwitchRow({ label, hint, checked, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-text-primary/5 transition-colors"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text-primary">{label}</span>
        <span className="block text-2xs text-text-muted">{hint}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-brand' : 'bg-border-default',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

/**
 * The composer's Tools button, and a chip for every switch that is on.
 *
 * Chat mode only: these are the settings `useSendMessage` reads. Agent mode
 * sends through the sidecar, which chooses its own tools and takes no
 * per-message switch, so a menu there would be buttons that do nothing.
 *
 * Think is `reasoningMode`: on is `auto` (a model that can think does), off is
 * `off`. It is hidden for a model that cannot think, where neither changes
 * anything.
 */
export function ToolsMenu() {
  const modelName        = useModel((s) => s.cloudModel?.modelId ?? s.loaded?.name ?? '');
  const reasoningMode    = useUI((s) => s.reasoningMode);
  const setReasoningMode = useUI((s) => s.setReasoningMode);
  const enabledTools     = useUI((s) => s.enabledTools);
  const toggleTool       = useUI((s) => s.toggleTool);

  const canThink = modelSupportsThinking(modelName);
  const thinking = canThink && reasoningMode !== 'off';

  const chips = [
    ...(thinking ? [{ key: 'think', label: 'Think', off: () => setReasoningMode('off') }] : []),
    ...CHAT_TOOLS
      .filter((t) => enabledTools.includes(t.id))
      .map((t) => ({ key: t.id, label: t.label, off: () => toggleTool(t.id) })),
  ];

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Tools and modes"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border-default px-2.5 text-2xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <SlidersHorizontal size={14} />
            Tools
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" sideOffset={8} className="w-64 p-1.5">
          {canThink && (
            <SwitchRow
              label="Think"
              hint="Reason step by step before answering"
              checked={thinking}
              onChange={(on) => setReasoningMode(on ? 'auto' : 'off')}
            />
          )}
          {CHAT_TOOLS.map((t) => (
            <SwitchRow
              key={t.id}
              label={t.label}
              hint={t.hint}
              checked={enabledTools.includes(t.id)}
              onChange={() => toggleTool(t.id)}
            />
          ))}
        </PopoverContent>
      </Popover>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed
          aria-label={`Turn off ${c.label}`}
          onClick={c.off}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-brand/25 bg-bg-active px-2.5 text-2xs font-medium text-brand transition-colors hover:border-brand/50"
        >
          {c.label}
          <X size={12} />
        </button>
      ))}
    </>
  );
}
