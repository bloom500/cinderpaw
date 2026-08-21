import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The plain secondary button used across Settings, the Cloud Keys rows and the
 * onboarding wizard.
 *
 * It exists as one constant because it was five copies of the same literal, and
 * all five had the same defect: a border and nothing else. That reads as a
 * button on a flat page, where the border is the only edge in the region. On
 * the glass pane it does not — `--border-subtle` over somebody's wallpaper is
 * a hairline you have to look for, so "Check for updates", "Change", "Open",
 * "Open logs" and "Re-run welcome" all rendered as floating text with padding
 * and nobody could tell they were clickable (reported by Darius over a light
 * wallpaper, 2026-08-22).
 *
 * The fix is a surface, not a stronger border: an interactive control gets a
 * sheet of its own to sit on, and glass is reserved for the chrome behind it.
 * `bg-bg-elevated` is the app's own translucent sheet, so the material still
 * shows through — it is now a raised piece of it rather than a hole in it.
 */
export const SECONDARY_BUTTON =
  'px-3 py-1.5 rounded-md border border-border-default bg-bg-elevated shadow-sm ' +
  'text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary ' +
  'transition-colors disabled:opacity-50';
