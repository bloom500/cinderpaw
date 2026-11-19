import { useEffect, useId, useState, type FormEvent } from 'react';
import { CircleDollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isChatgptRoute } from '@/lib/localApi';
import { tauri } from '@/lib/tauri';
import { useCinderpawStore } from '@/stores/cinderpaw';

const formatUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
type SpendView = Awaited<ReturnType<typeof tauri.cinderpawAgent.chatSpend>>;

function supportsSpendingLimit(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.origin === 'https://openrouter.ai' && /^\/api(?:\/v1)?\/?$/.test(url.pathname) &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function ChatSpendControl({ sessionId }: { sessionId: string }) {
  const label = useId();
  const config = useCinderpawStore((s) => s.modelConfig);
  const ready = useCinderpawStore((s) => s.isReady);
  const canSetLimit = supportsSpendingLimit(config?.base_url);
  const checkSavedLimit = ready && config !== null && !canSetLimit;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SpendView>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open && !checkSavedLimit) return;
    let mounted = true;
    let loading = false;
    let first = true;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await tauri.cinderpawAgent.chatSpend(sessionId);
        if (!mounted) return;
        setView(result);
        if (first) {
          setDraft(result.limitUsd?.toFixed(2) ?? '');
          setError('');
        }
        first = false;
      } catch (err) {
        if (mounted && first) setError(typeof err === 'string' ? err : 'Could not load the spending limit.');
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = open ? window.setInterval(() => void refresh(), 2500) : undefined;
    return () => { mounted = false; window.clearInterval(timer); };
  }, [open, checkSavedLimit, sessionId]);

  const save = async (limit: number | null) => {
    setSaving(true);
    setError('');
    try {
      setView(await tauri.cinderpawAgent.chatSpend(sessionId, limit));
      setOpen(false);
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Could not save the spending limit. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSetLimit) void save(Number(draft));
  };

  if (!open && !canSetLimit && view?.limitUsd == null) return null;

  return (
    <Popover open={open} onOpenChange={(next) => {
      if (next) {
        setView(undefined);
        setError('');
      }
      setOpen(next);
    }}>
      <PopoverTrigger asChild>
        <Button type="button" size="icon" variant="outline" aria-label="Chat spending limit" title="Chat spending limit"
          className="h-8 w-8 shrink-0 rounded-full text-text-muted">
          <CircleDollarSign size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Chat spending limit" className="w-72 space-y-3 text-sm">
        <p className="font-semibold text-text-primary">Chat spending limit</p>
        {canSetLimit ? <>
          <p className="text-text-muted">Limits OpenRouter text calls from this chat, including work sent to teammates. The built-in local model is free.</p>
          <p className="text-text-muted">It counts calls started while the limit is on.</p>
        </> : <p className="text-text-muted">
          {config?.provider === 'chatgpt' || isChatgptRoute(config?.base_url)
            ? 'Remove the saved OpenRouter limit to use your ChatGPT plan in this chat.'
            : 'You can remove the saved OpenRouter limit here.'}
        </p>}
        {view ? (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-text-muted">
              {view.limitUsd === null ? 'Limit off' : `${formatUsd.format(view.usedUsd)} of ${formatUsd.format(view.limitUsd)} used or reserved`}
            </p>
            {canSetLimit && <div className="space-y-1">
              <label htmlFor={label} className="text-text-primary">Limit in USD</label>
              <Input id={label} type="number" min={0} step={0.01} required value={draft} disabled={saving}
                onChange={(event) => setDraft(event.target.value)} />
            </div>}
            {error && <p role="alert" className="text-text-primary">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              {view.limitUsd !== null && (
                <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>Remove limit</Button>
              )}
              {canSetLimit && <Button type="submit" size="sm" disabled={saving} className="ml-auto">{saving ? 'Saving…' : 'Save limit'}</Button>}
            </div>
          </form>
        ) : <p role={error ? 'alert' : 'status'} className="text-text-muted">{error || 'Loading…'}</p>}
      </PopoverContent>
    </Popover>
  );
}
