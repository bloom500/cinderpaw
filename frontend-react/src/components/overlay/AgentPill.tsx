import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import logoUrl from '@/assets/logo.svg';

type Step = { app: string; label: string };

/**
 * The pill at the top of the screen while Cinderpaw drives the computer: which
 * app it is using, what it is doing now, and Stop. Its own small window
 * (agent_overlay.rs), the one part of the overlay that takes a click, and it
 * never takes the keyboard focus from the app being driven.
 */
export function AgentPill() {
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    void invoke<{ step: Step | null }>('agent_overlay_state').then((s) => { if (s.step) setStep(s.step); }).catch(() => {});
    const off = listen<Step>('agent-overlay://step', (e) => setStep(e.payload));
    return () => { void off.then((f) => f()); };
  }, []);

  return (
    <div className="fixed inset-0 flex items-start justify-center pt-1.5">
      <div className="agent-pill" role="status">
        <span className="agent-pill-dot" aria-hidden />
        <img src={logoUrl} alt="" className="agent-pill-logo" />
        <span className="agent-pill-who">
          Cinderpaw is using {step?.app ? <b>{step.app}</b> : 'your computer'}
        </span>
        {step?.label && (
          // Keyed so each new step slides in instead of the words swapping.
          <span key={step.label} className="agent-pill-step">{step.label}</span>
        )}
        <button type="button" className="agent-pill-stop" onClick={() => void invoke('agent_overlay_stop')}>
          Stop <kbd className="agent-pill-kbd">Esc</kbd>
        </button>
      </div>
    </div>
  );
}
