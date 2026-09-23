/**
 * Settings categories, apart from SettingsPage so the command palette can list
 * them without pulling the lazily loaded settings screen into the startup bundle.
 */
import {
  ArrowLeftRight, Bot, Brain, Cpu, Info, Link2, Palette, Settings,
  ShieldCheck, Sparkles, type LucideIcon,
} from 'lucide-react';

export type Category =
  | 'general' | 'appearance' | 'hardware' | 'api' | 'agent' | 'privacy' | 'about'
  | 'capabilities' | 'accounts' | 'memory';

/** Exported so the router's redirects can be checked against it: a redirect to
 *  a category that does not exist is a dead end, and nothing else would catch
 *  it — the tab list would simply fall back to General with no error. */
// Icons are drawn, not typed. The rail used rare symbol glyphs (U+26B7,
// U+26BF, U+274A and friends) which exist in almost no shipped font: on a
// Linux box, and on Windows installs without the full symbol set, half of
// this list rendered as empty boxes. lucide is already a dependency and
// draws the same meaning as SVG on every machine.
export const CATS: { id: Category; label: string; icon: LucideIcon }[] = [
  { id: 'general',    label: 'General',     icon: Settings },
  { id: 'appearance', label: 'Appearance',  icon: Palette },
  { id: 'hardware',   label: 'Hardware',    icon: Cpu },
  { id: 'api',        label: 'API Server',  icon: ArrowLeftRight },
  { id: 'agent',      label: 'Agent',       icon: Bot },
  { id: 'privacy',    label: 'Privacy',     icon: ShieldCheck },
  // Named for what the user is looking for, not for the subsystem underneath:
  // 'skill', 'extension' and 'connector' are banned from the primary interface
  // by the UX contract. They stay legal inside these screens, which is what
  // progressive disclosure means.
  { id: 'capabilities', label: 'Capabilities', icon: Sparkles },
  { id: 'accounts',     label: 'Accounts',     icon: Link2 },
  { id: 'memory',       label: 'Memory',       icon: Brain },
  { id: 'about',      label: 'About',       icon: Info },
];
