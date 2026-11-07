import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import logoUrl from '@/assets/logo.svg';
import { BrandLogo, brandIdFor } from '@/lib/brandLogos';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { tauri } from '@/lib/tauri';
import { useConnected } from '@/stores/connected';
import { useConversations } from '@/stores/conversations';
import { BASE, MOTION } from '@/lib/motion';

/** "search_pages" → "Search pages". */
const pretty = (name: string) => {
  const words = name.replace(/^mcp_/, '').replace(/[_-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Cinderpaw's mark and the service's slide in, meet once and a check lands on
 * the seam (Darius picked this over Cubby and a plain check, 22 Oct: "mai
 * profesionala"). It moves once and rests: a loop would read as loading.
 */
function ConnectPair({ logoId, name }: { logoId: string; name: string }) {
  const still = useReducedMotion();
  const tile = 'inline-flex size-16 items-center justify-center rounded-2xl border border-border-default bg-bg-elevated shadow-lg';
  const slide = (from: number, rotate: number) =>
    still
      ? { initial: false as const, animate: { x: 0, rotate } }
      : { initial: { x: from, rotate: 0, opacity: 0 }, animate: { x: 0, rotate, opacity: 1 }, transition: BASE };
  return (
    // A gap, not an overlap: the tiles are translucent, and overlapped their
    // borders crossed and the two looked woven together (Darius, 22 Oct).
    <div className="relative mx-auto flex h-24 items-center justify-center gap-3" aria-hidden>
      <motion.span className={tile} {...slide(-36, -6)}>
        <img src={logoUrl} alt="" draggable={false} className="size-10" />
      </motion.span>
      <motion.span {...slide(36, 6)}>
        <BrandLogo id={logoId} name={name} className={`${tile} text-2xl [&>img]:size-9`} />
      </motion.span>
      <motion.span
        className="absolute left-1/2 top-[66px] -ml-3.5 flex size-7 items-center justify-center rounded-full bg-success text-white ring-4 ring-bg-primary"
        initial={still ? false : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ ...BASE, delay: MOTION.base }}
      >
        <Check size={16} strokeWidth={3} />
      </motion.span>
    </div>
  );
}

/**
 * "Notion is connected", over the blurred app: what it can do now and one
 * step to try it. Mounted once in AppShell; anything opens it through
 * `useConnected` (Capabilities, Accounts, the chat).
 */
export function ConnectedDialog() {
  const item = useConnected((s) => s.item);
  const close = useConnected((s) => s.close);
  const navigate = useNavigate();
  const [fetched, setFetched] = useState<string[] | null>(null);
  const mcpId = item?.tools ? undefined : item?.mcpId;
  useEffect(() => {
    setFetched(null);
    if (!mcpId) return;
    let live = true;
    tauri.mcp.listTools(mcpId).then((t) => { if (live) setFetched(t.map((x) => x.name)); }).catch(() => {});
    return () => { live = false; };
  }, [mcpId]);
  if (!item) return null;
  const tools = item.tools ?? fetched;
  const body =
    item.body ??
    (tools
      ? `Cinderpaw can now use ${tools.length} of its tools. Just ask for it in any chat.`
      : 'Cinderpaw can use it now. Just ask for it in any chat.');
  const tryIt = () => {
    close();
    useConversations.getState().newChat();
    navigate('/chat', { state: { compose: item.prompt } });
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md text-center">
        <ConnectPair logoId={brandIdFor(item.logoId ?? item.name, item.name)} name={item.name} />
        <DialogHeader>
          <DialogTitle className="text-center text-2xl">{item.name} is connected</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-text-secondary">{body}</p>
        {tools && tools.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {tools.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-bg-hover px-2.5 py-1 text-2xs text-text-secondary">
                {pretty(t)}
              </span>
            ))}
            {tools.length > 3 && (
              <span className="rounded-full px-2.5 py-1 text-2xs text-text-muted">+{tools.length - 3} more</span>
            )}
          </div>
        )}
        <DialogFooter className="sm:justify-center">
          <button
            type="button"
            onClick={close}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-bg-hover text-text-secondary hover:text-text-primary"
          >
            Done
          </button>
          {item.prompt && (
            <button
              type="button"
              onClick={tryIt}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand text-on-brand hover:bg-brand/90"
            >
              Try it in a chat
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
