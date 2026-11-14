import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTasks } from '@/stores/tasks';
import { useConversations } from '@/stores/conversations';
import { useAttentionTurn } from '@/lib/attention';
import { NoticeCard, NoticeButton } from '@/components/NoticeCard';

const DONE_KEY = 'cinderpaw.phoneNotice.done';

/** Storage can be missing (blocked site data); then it may offer once more. */
function wasShown(): boolean {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; }
}

/**
 * Offered once: Cinderpaw can also write to the person's phone (13 Nov, Darius).
 *
 * After a first conversation, like the usage question: an offer made before the
 * app did anything for them comes too early. And only once the engine has
 * answered that no messenger is connected. While it is silent the card stays
 * hidden: offering WhatsApp to someone who already linked it is worse than
 * waiting.
 *
 * Any way of closing it is final. It is a reminder, not a question, and the
 * same offer stays on the Tasks page ("Connect your phone").
 */
export function ConnectPhoneCard() {
  const phone = useTasks((s) => s.phone);
  const refresh = useTasks((s) => s.refresh);
  const hadReply = useConversations((s) => s.list.length > 0);
  const navigate = useNavigate();
  const [done, setDone] = useState(wasShown);

  // Nothing else on the home screen asks the engine where tasks go.
  useEffect(() => {
    if (!done && hadReply && !phone) refresh();
  }, [done, hadReply, phone, refresh]);

  const turn = useAttentionTurn('phone', !done && hadReply && !!phone && phone.via === null);
  if (!turn) return null;

  const close = () => {
    setDone(true);
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* no storage */ }
  };
  return (
    <NoticeCard
      icon={Smartphone}
      title="Get my messages on WhatsApp"
      line="Reminders and finished tasks can reach your phone. You only scan a code. Keep this computer on and Cinderpaw open. The tray is fine."
      onClose={close}
      actions={(
        <>
          <NoticeButton onClick={close}>Not now</NoticeButton>
          <NoticeButton primary onClick={() => { close(); navigate('/settings?cat=accounts'); }}>Connect WhatsApp</NoticeButton>
        </>
      )}
    />
  );
}
