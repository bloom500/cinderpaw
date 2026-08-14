import { useEffect, useState } from 'react';
import { Mic, Cloud, Loader2, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ExternalLink } from './ExternalLink';
import { useUI, type SttProvider } from '@/stores/ui';
import { tauri } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * First-mic-tap (and long-press) chooser for the speech-to-text backend:
 * local whisper (private, on-device) vs cloud Groq whisper-large-v3 (more
 * accurate, needs an API key, audio leaves the device). The Groq key reuses the
 * BYOK keychain, entered inline so non-technical users never leave the flow.
 */
export function VoiceProviderCard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const sttProvider = useUI((s) => s.sttProvider);
  const setSttProvider = useUI((s) => s.setSttProvider);

  const [choice, setChoice] = useState<SttProvider>(sttProvider ?? 'local');
  const [groqKey, setGroqKey] = useState('');
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync the selected option + Groq key status each time the card opens.
  useEffect(() => {
    if (!open) return;
    setChoice(sttProvider ?? 'local');
    setGroqKey('');
    tauri.raw
      .getByokSettings()
      .then((providers) => setHasGroqKey(providers.some((p) => p.id === 'groq' && p.has_api_key)))
      .catch(() => setHasGroqKey(false));
  }, [open, sttProvider]);

  // Cloud needs a key: either one already stored, or one typed in now.
  const needsKey = choice === 'groq' && !hasGroqKey && groqKey.trim().length === 0;

  const confirm = async () => {
    if (needsKey) return;
    setSaving(true);
    try {
      if (choice === 'groq' && groqKey.trim()) {
        await tauri.raw.saveByokProvider('groq', true, groqKey.trim());
      }
      setSttProvider(choice);
      onOpenChange(false);
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Default z-index: the call overlay sits at z-40, below this layer, so a
          dialog opened from inside a call is above it without a special case. */}
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto bg-bg-surface border-border-default">
        <DialogHeader>
          <DialogTitle>{t('voice.provider.title')}</DialogTitle>
          <DialogDescription>{t('voice.provider.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <OptionRow
            active={choice === 'local'}
            onClick={() => setChoice('local')}
            icon={<Mic size={18} />}
            title={t('voice.provider.local.title')}
            desc={t('voice.provider.local.desc')}
          />
          <OptionRow
            active={choice === 'groq'}
            onClick={() => setChoice('groq')}
            icon={<Cloud size={18} />}
            title={t('voice.provider.cloud.title')}
            desc={t('voice.provider.cloud.desc')}
          />
        </div>

        {choice === 'groq' &&
          (hasGroqKey ? (
            <p className="text-xs text-text-muted px-1">{t('voice.provider.cloud.keySet')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Input
                type="password"
                autoComplete="off"
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
                placeholder={t('voice.provider.cloud.keyPlaceholder')}
              />
              <ExternalLink href="https://console.groq.com/keys" className="text-xs self-start">
                {t('voice.provider.cloud.getKey')}
              </ExternalLink>
            </div>
          ))}

        {/* No "language you speak" picker. Detection is the transcriber's job
            and it does it per request; a setting here only gave someone a way to
            be wrong about themselves, and a wrong value is an ORDER to Whisper,
            not a hint — it transcribes Romanian through English phonetics and
            never recovers. */}

        <DialogFooter>
          <Button onClick={() => void confirm()} disabled={needsKey || saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : t('voice.provider.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionRow({
  active,
  onClick,
  icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
        active ? 'border-brand bg-bg-hover' : 'border-border-default hover:bg-bg-hover',
      )}
    >
      <span className="mt-0.5 text-text-secondary">{icon}</span>
      <span className="flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {title}
          {active && <Check size={14} className="text-brand" />}
        </span>
        <span className="block text-xs text-text-muted mt-0.5">{desc}</span>
      </span>
    </button>
  );
}
