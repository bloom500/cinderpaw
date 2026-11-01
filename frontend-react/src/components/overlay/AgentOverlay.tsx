import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** A box on this monitor, in CSS pixels (agent_overlay.rs converts from UIA). */
type Box = { x: number; y: number; w: number; h: number };

/**
 * The full-screen half of the computer-use overlay (agent_overlay.rs; Darius's
 * pick, 1 Nov): the ember edge that says Cinderpaw has the computer, a
 * glowing cursor of its own, which glides to what it is about to press, the
 * ring on that target and the ripple of the press. Every click goes through
 * this window to the app underneath; the pill is a window of its own.
 */
export function AgentOverlay() {
  const [target, setTarget] = useState<Box | null>(null);
  const [press, setPress] = useState(0);

  useEffect(() => {
    // The first step went out before this page was listening.
    void invoke<{ aim: Box | null }>('agent_overlay_state').then((s) => { if (s.aim) setTarget(s.aim); }).catch(() => {});
    const offs = [
      listen<Box>('agent-overlay://aim', (e) => setTarget(e.payload)),
      listen('agent-overlay://act', () => setPress((n) => n + 1)),
    ];
    return () => { for (const off of offs) void off.then((f) => f()); };
  }, []);

  // Before the first target it waits mid-screen, then glides from there.
  const x = target ? target.x + target.w / 2 : window.innerWidth / 2;
  const y = target ? target.y + target.h / 2 : window.innerHeight * 0.45;

  return (
    <div className="agent-overlay pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      <div className="agent-edge absolute inset-0" />
      {press > 0 && [0, 1].map((i) => <div key={`${press}-${i}`} className="agent-ripple absolute" style={{ left: x, top: y }} />)}
      <div className="agent-cursor-halo absolute left-0 top-0" style={{ transform: `translate(${x}px, ${y}px)` }}>
        <div key={press} className={press > 0 ? 'agent-halo-flash' : undefined} />
      </div>
      <div className="agent-cursor absolute left-0 top-0" style={{ transform: `translate(${x}px, ${y}px)` }}>
        {/* Keyed so each glide replays the lean and each press replays the dip. */}
        <span key={`${x},${y}`} className={target ? 'agent-cursor-lean' : undefined}>
          <span key={press} className={press > 0 ? 'agent-cursor-press' : undefined}>
            <svg width="20" height="25" viewBox="0 0 26 32">
              <path d="M2 2 L2 26 L8.5 20 L13 30 L17 28.2 L12.6 18.6 L21.5 18.6 Z" fill="#fff" stroke="#1b1410" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </div>
    </div>
  );
}
