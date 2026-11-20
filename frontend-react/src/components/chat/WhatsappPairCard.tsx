import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { linkCodeShown, tauri } from '@/lib/tauri';

/** Polls with no code and no link before the card says it is stuck (~30 s). */
const STUCK_POLLS = 10;

/**
 * The WhatsApp code, in the chat that asked for it (28 Oct, Darius: the code
 * where the person already is, not on another page). The same two reads as the
 * Connectors card: the code the engine writes to disk and whether the phone is
 * linked yet. With a number to link it is 8 characters to type on the phone
 * (31 Oct, like ChatGPT's Dot); without one, a square that changes about every
 * 20 s. WhatsApp turned off again: nothing.
 */
export function WhatsappPairCard() {
  const [svg, setSvg] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<'waiting' | 'linked' | 'off'>('waiting');
  const [empty, setEmpty] = useState(0);

  useEffect(() => {
    if (state === 'linked') return;
    let alive = true;
    const tick = async () => {
      const [qr, list] = await Promise.all([
        tauri.connectors.whatsappQr().catch(() => null),
        tauri.connectors.list().catch(() => null),
      ]);
      if (!alive) return;
      const wa = list?.find((c) => c.id === 'whatsapp');
      // ponytail: polls while the chat is open and unlinked; a cheap file read every 3 s.
      if (wa?.linked) return setState('linked');
      setState(wa && !wa.enabled ? 'off' : 'waiting');
      setCode(qr?.code ?? null);
      setSvg(qr?.svg ?? null);
      setEmpty((n) => (qr?.code || qr?.svg ? 0 : n + 1));
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [state]);

  if (state === 'off') return null;
  const box = 'rounded-2xl border border-border-default bg-bg-surface p-4 text-sm';
  // The Connectors card says it too; someone who links here never sees that card.
  const ban = <p className="text-2xs text-warning">WhatsApp can ban a number it sees as automated. A second number is safest.</p>;
  if (state === 'linked') {
    return (
      <p className={`${box} flex items-center gap-2 text-text-primary`}>
        <Check size={16} className="text-success" aria-hidden />
        Your phone is linked. Your tasks can now reach you on WhatsApp.
      </p>
    );
  }
  if (code) {
    return (
      <div className={`${box} flex flex-col items-center gap-2`}>
        <p className="text-text-primary">
          On that phone: WhatsApp, Settings, Linked devices, Link a device. Tap Link with phone number instead, and type:
        </p>
        <p className="select-all font-mono text-2xl tracking-widest text-text-primary" aria-label="WhatsApp link code">
          {linkCodeShown(code)}
        </p>
        <p className="text-2xs text-text-muted">The code stays here until the phone is linked. No rush.</p>
        {ban}
      </div>
    );
  }
  if (svg) {
    return (
      <div className={`${box} flex flex-col items-center gap-2`}>
        <p className="text-text-primary">On your phone: WhatsApp, Settings, Linked devices, Link a device. Then point the camera here.</p>
        <img
          alt="WhatsApp link code"
          className="block w-56 rounded"
          style={{ imageRendering: 'pixelated' }}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
        />
        <p className="text-2xs text-text-muted">A new code comes every 20 seconds. No rush.</p>
        {ban}
      </div>
    );
  }
  if (empty > STUCK_POLLS) {
    return (
      <p className={`${box} text-warning`}>
        No code is arriving. Turn WhatsApp off and on in{' '}
        <Link to="/settings?cat=accounts" className="underline">Settings, Accounts</Link> to try again.
      </p>
    );
  }
  return (
    <p className={`${box} text-text-muted`}>
      <Loader2 size={14} className="mr-1.5 -mt-0.5 inline animate-spin" aria-hidden />
      Getting your WhatsApp code ready…
    </p>
  );
}
