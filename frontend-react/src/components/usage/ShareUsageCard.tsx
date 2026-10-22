import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { useSettings } from '@/stores/settings';
import { useConversations } from '@/stores/conversations';
import { useAttentionTurn } from '@/lib/attention';
import { WhatIsSent } from './WhatIsSent';

/** Asked once, on installs that skipped or predate the onboarding question,
 *  after a first conversation (a question before the app did anything for
 *  them asks for a favour too early) and only on its turn (lib/attention). */
export function ShareUsageCard() {
  const settings = useSettings((s) => s.settings);
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);

  // The home screen does not load settings on its own, and without them the
  // card cannot tell "never asked" from "not loaded yet".
  useEffect(() => {
    if (!settings) void fetchSettings();
  }, [settings, fetchSettings]);

  // Only `null` (never asked) shows the card. Not loaded yet stays hidden:
  // flashing the question at someone who already answered is worse.
  const hadReply = useConversations((s) => s.list.length > 0);
  const turn = useAttentionTurn('usage', !done && !!settings && settings.usage_sharing === null && hadReply);
  if (!turn) return null;

  const answer = (on: boolean) => {
    setDone(true);
    void tauri.system.setUsageSharing(on).then(() => fetchSettings()).catch(() => {});
  };
  return (
    <div className="mt-4 max-w-md rounded-xl border border-border-subtle bg-(--surface-typing) px-4 py-3 text-xs text-text-muted pointer-events-auto">
      <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><BarChart3 size={14} /> Help other people pick a model?</p>
      <p className="mt-1 leading-relaxed">Once a day, share how many tasks each model did, how long they took and what they cost. Never your messages or files.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => answer(true)} className="rounded-lg bg-brand px-3 py-1.5 text-on-brand">Yes, share</button>
        <button type="button" onClick={() => answer(false)} className="rounded-lg border border-border-subtle px-3 py-1.5">No thanks</button>
        <button type="button" onClick={() => setOpen((o) => !o)} className="px-1 text-brand hover:underline" aria-expanded={open}>Show me what is sent</button>
      </div>
      {open && <WhatIsSent />}
    </div>
  );
}
