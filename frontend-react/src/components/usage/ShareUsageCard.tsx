import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { useSettings } from '@/stores/settings';
import { useConversations } from '@/stores/conversations';
import { useAttentionTurn } from '@/lib/attention';
import { WhatIsSent } from './WhatIsSent';
import { NoticeCard, NoticeButton } from '@/components/NoticeCard';

/** Asked once, on installs that skipped or predate the onboarding question,
 *  after a first conversation (a question before the app did anything for
 *  them asks for a favour too early) and only on its turn (lib/attention),
 *  in the top-right notice column like every other notice (21 Oct). */
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
    <NoticeCard
      icon={BarChart3}
      title="Help other people pick a model?"
      line="Once a day, share how many tasks each model did, how long they took and what they cost. Never your messages or files."
      // X = not now: nothing is saved, so it asks again next time.
      onClose={() => setDone(true)}
      actions={(
        <>
          <NoticeButton onClick={() => answer(false)}>No thanks</NoticeButton>
          <NoticeButton primary onClick={() => answer(true)}>Yes, share</NoticeButton>
        </>
      )}
    >
      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-2xs text-brand hover:underline" aria-expanded={open}>Show me what is sent</button>
      {open && <WhatIsSent />}
    </NoticeCard>
  );
}
