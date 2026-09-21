import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { tauri } from '@/lib/tauri';

/**
 * Jev (TypeSafe) is the third voice provider beside Gemini and OpenAI, and a
 * different kind of call: it hears you through the app's STT choice
 * (Moonshine on device, or a cloud transcriber), decides which command you
 * meant in ~300 ms, and executes it. It never speaks. This is its key field,
 * ONE field for whichever provider's key the person has.
 *
 * Price is what OpenRouter's endpoint listing said on 21 Sep 2026: $0.042 per
 * million input tokens, output free (Jev returns a choice, not text). Update
 * the date when the number is re-read.
 */
export const JEV_PROVIDER_ID = 'jev';
export const JEV_PRICE = '$0.042 / M input tokens, output free';

/** Where a key of this shape is honoured. `sk-or-` is OpenRouter; anything else is TypeSafe's own console. */
export function jevRoute(key: string): { baseUrl: string; model: string; via: 'OpenRouter' | 'TypeSafe' } {
  return key.trim().startsWith('sk-or-')
    ? { baseUrl: 'https://openrouter.ai/api/v1', model: 'typesafe/jev-1.13', via: 'OpenRouter' }
    : { baseUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', via: 'TypeSafe' };
}

/** Whether a Jev key is in the keychain. The secret itself never comes back. */
export function jevKeyStored(): Promise<boolean> {
  return tauri.raw.byokHasKey(JEV_PROVIDER_ID).catch(() => false);
}

export function JevKeyRow({ stored, onStored }: { stored: boolean; onStored: (stored: boolean) => void }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setNote(null); }, [stored]);

  const save = async () => {
    const k = key.trim();
    if (!k) return;
    setSaving(true);
    try {
      const route = jevRoute(k);
      await tauri.raw.saveByokProvider(JEV_PROVIDER_ID, true, k, route.baseUrl, route.model);
      setKey('');
      onStored(true);
      setNote(`Saved. Requests go through ${route.via}.`);
    } catch (e) {
      setNote(`Could not save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const forget = async () => {
    try {
      await tauri.raw.removeByokProvider(JEV_PROVIDER_ID);
      onStored(false);
      setNote('Key removed.');
    } catch (e) {
      setNote(`Could not remove: ${String(e)}`);
    }
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          aria-label="Jev API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          placeholder={stored ? 'A key is stored. Paste another to replace it.' : 'OpenRouter (sk-or-…) or TypeSafe key'}
          className="h-9 text-sm"
        />
        <Button size="sm" onClick={() => void save()} disabled={!key.trim() || saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 text-2xs text-text-muted">
        <span className="truncate">{note ?? `${JEV_PRICE} (OpenRouter, 21 Sep 2026). ~300 ms per command.`}</span>
        {stored && (
          <button type="button" onClick={() => void forget()} className="shrink-0 underline-offset-2 hover:underline">Forget key</button>
        )}
      </div>
    </div>
  );
}
