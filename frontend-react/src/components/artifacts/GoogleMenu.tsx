import { ChevronDown, FileText, HardDrive, Mail, Sheet, type LucideIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { googlePlan, GOOGLE_DESTS, type GoogleDest } from '@/stores/artifacts';
import { cn } from '@/lib/utils';

/** What each choice says, and why one cannot take this artifact. */
const DEST: Record<GoogleDest, { name: string; icon: LucideIcon; color: string; does: string; cannot: string }> = {
  drive: { name: 'Google Drive', icon: HardDrive, color: '#1FA463', does: 'Saves the file as it is', cannot: 'This kind of file cannot go to Drive' },
  docs: { name: 'Google Docs', icon: FileText, color: '#4285F4', does: 'Opens it as a Doc you can edit', cannot: 'A PDF keeps its look in Drive instead' },
  sheets: { name: 'Google Sheets', icon: Sheet, color: '#0F9D58', does: 'Opens it as a Sheet you can edit', cannot: 'Only a table or a CSV can become a Sheet' },
  gmail: { name: 'Gmail', icon: Mail, color: '#EA4335', does: 'Puts a link to it in a new email', cannot: 'This kind of file cannot be emailed as a link' },
};

/** Whether any Google place can take this artifact (the button shows only then). */
export function googleCanTake(kind: string, content: string, title = ''): boolean {
  return GOOGLE_DESTS.some((d) => googlePlan(kind, d, content, title));
}

/**
 * The Google button: the G and a chevron, opening Drive, Docs, Sheets and
 * Gmail. A place that cannot take this artifact stays in the list, greyed,
 * with the reason, so nobody wonders where Sheets went.
 */
export function GoogleMenu({ kind, content, title, disabled, className, onSend, onSignOut }: {
  kind: string;
  content: string;
  /** A file's type is in its title (leads.csv), and that decides Sheets. */
  title: string;
  disabled?: boolean;
  className?: string;
  onSend: (dest: GoogleDest) => void;
  /** Picked the wrong account on Google's page? This is the way back. */
  onSignOut?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} aria-label="Send to Google" className={className}>
        <GoogleMark />
        Google
        <ChevronDown size={14} className="text-text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-1.5">
        {GOOGLE_DESTS.map((d) => {
          const { name, icon: Icon, color, does, cannot } = DEST[d];
          const ok = googlePlan(kind, d, content, title) !== null;
          return (
            <DropdownMenuItem
              key={d}
              disabled={!ok}
              onSelect={() => onSend(d)}
              className={cn('flex items-start gap-3 rounded-xl p-2', !ok && 'opacity-50')}
            >
              <Icon size={16} style={{ color }} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm text-text-primary">{name}</span>
                <span className="block text-2xs text-text-muted">{ok ? does : cannot}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {onSignOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut} className="flex flex-col items-start gap-0 rounded-xl p-2">
              <span className="text-sm text-text-primary">Sign out of Google</span>
              <span className="text-2xs text-text-muted">Next time, pick which account to use</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
