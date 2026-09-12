/**
 * Privacy settings.
 *
 * This screen used to open with "Your data never leaves this machine", which
 * is true of a local-model install and false the moment a cloud key is
 * configured — which is most installs, since a cloud key is one of the two
 * things onboarding offers. A privacy screen that overstates is worse than no
 * privacy screen: it is the page a person quotes back at you.
 *
 * So the claims below are split by what is unconditional (no telemetry, no
 * account, no background upload) and what depends on the route the person
 * chose. The one setting here is the one place Cinderpaw could send a
 * conversation somewhere they did not pick, and it is off until they say so.
 */

import { useEffect } from 'react';
import { useSettings } from '@/stores/settings';

const rowCls =
  'flex items-start justify-between gap-4 p-4 rounded-lg border border-border-subtle bg-bg-surface';

export function PrivacyTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.updateSettings);
  const save = useSettings((s) => s.save);
  const fetchSettings = useSettings((s) => s.fetchSettings);

  useEffect(() => {
    if (!settings) void fetchSettings();
  }, [settings, fetchSettings]);

  const cloudFallback = settings?.cloud_fallback_enabled ?? false;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Privacy</h2>

      <div className="flex gap-4 p-4 rounded-lg border border-border-subtle bg-bg-surface">
        <span className="text-2xl shrink-0">⚿</span>
        <div>
          <p className="text-sm font-medium text-text-primary">Local storage, with network access for online features</p>
          <p className="text-xs text-text-muted mt-1">
            Local models run on your hardware. Cloud models, web tools, connectors, and configured
            background tasks can send data to external services.
          </p>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-text-primary">Data collection</p>
        <p className="text-xs text-text-muted mt-0.5">No automatic analytics or crash-report uploads. Online features still transmit the data they need.</p>
      </div>

      <ul className="space-y-1.5 text-sm text-text-secondary">
        {[
          'Conversation history is stored locally; cloud requests include conversation context',
          'Downloaded models are stored on disk; cloud models run at their providers',
          'Update checks and missing model or toolchain downloads can use the network at startup',
          'Configured background tasks, verification, and fallbacks can also contact cloud providers',
        ].map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span className="text-text-muted mt-0.5">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>

      {/*
        The only switch on this page, because it is the only setting that can
        change WHO receives a conversation. Off by default: a person should not
        find out that a rate limit re-routed their transcript to a second
        company by reading a settings screen afterwards.
      */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">
            Retry with a second cloud provider when the first one fails
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            While this is off, a rate-limited or unreachable provider means the message fails and
            Cinderpaw tells you why. Turn it on and Cinderpaw will instead resend that message, and
            the conversation so far, to another provider you have configured, using that provider’s
            key. It keeps you answering on a bad day; it also means a second company sees the
            conversation. Your call, not ours.
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Retry with a second cloud provider when the first one fails"
          checked={cloudFallback}
          disabled={!settings}
          onChange={(e) => {
            update({ cloud_fallback_enabled: e.target.checked });
            void save();
          }}
          className="h-4 w-4 accent-orange-500 shrink-0"
        />
      </div>
    </div>
  );
}
