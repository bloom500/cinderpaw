import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface SelectOption<T extends string> { value: T; label: string }

/**
 * A pick-one list drawn by us, not by the operating system. A native `<select>`
 * opens a popup in the OS colours: dark text on a dark popup on some Windows
 * themes, and a white Win95 box over the glass on the rest. CallOverlay's voice
 * picker already solved it this way; this is that solution with a name.
 * Keyboard: Enter or Space opens, arrows move, typing a letter jumps (Radix).
 */
export function SelectMenu<T extends string>({
  value, options, onChange, ariaLabel, className, placeholder = 'Choose…',
}: {
  value: T | '';
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5',
            'text-sm text-text-primary transition-colors hover:border-border-default',
            'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-brand',
            className,
          )}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-(--radix-dropdown-menu-trigger-width) max-h-72">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} className="text-sm">
              <span className="truncate">{o.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
