import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { tauri } from '@/lib/tauri';
import { useConnected } from '@/stores/connected';
import { useConversations } from '@/stores/conversations';

/** "search_pages" → "Search pages". */
const pretty = (name: string) => {
  const words = name.replace(/^mcp_/, '').replace(/[_-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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
        <CheckCircle2 size={44} className="mx-auto text-success" />
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
