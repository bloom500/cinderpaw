import { useEffect, useRef, useState } from 'react';
import { FeralMascot } from './FeralMascot';
import { ToolCallStack } from './ToolCallStack';
import { useChat } from '@/stores/chat';
import type { MascotState } from './frames';

// Idle sequence: idle →(8s)→ curious →(10s)→ run →(3.6s)→ sleep →(15s)→ stretching →(2s)→ idle
// After 2 complete idle cycles: gaming →(10s)→ back to curious
const CURIOUS_DELAY_MS       = 8_000;
const RUN_AFTER_CURIOUS_MS   = 10_000;
const LEG_MS                 = 1_800;
const SLEEP_AFTER_RUN_MS     = 15_000;
const STRETCHING_MS          = 2_000;
const GAMING_MS              = 10_000;
const GAMING_TRIGGER_CYCLES  = 2;
const LEFT_OFFSET            = 20;
const MASCOT_W               = 38;
const PUFF_EVERY_MS          = 380;
const PUFF_FADE_MS           = 600;

interface Puff { id: number; x: number; born: number; }

function DustPuff({ x }: { x: number }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), 40);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 8,
        left: x,
        width: 8,
        height: 5,
        borderRadius: '50%',
        background: 'rgba(180, 160, 140, 0.7)',
        pointerEvents: 'none',
        zIndex: 9,
        transition: `opacity ${PUFF_FADE_MS}ms ease-out, transform ${PUFF_FADE_MS}ms ease-out`,
        opacity: gone ? 0 : 0.7,
        transform: gone ? 'translateY(-12px) scale(2)' : 'translateY(0) scale(1)',
      }}
    />
  );
}

export function MascotPerch({ baseState }: { baseState: MascotState }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const [renderState, setRenderState] = useState<MascotState>(baseState);
  const [x, setX] = useState(0);
  const [flip, setFlip] = useState(false);
  const [traveling, setTraveling] = useState(false);
  const [puffs, setPuffs] = useState<Puff[]>([]);
  const puffId = useRef(0);
  const travelRef = useRef<{ startX: number; targetX: number; startTime: number } | null>(null);
  const idleCycleCount = useRef(0);

  useEffect(() => {
    const clearTimers = () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
    clearTimers();

    if (baseState !== 'idle') {
      setTraveling(false);
      setX(0);
      setFlip(false);
      setRenderState(baseState);
      setPuffs([]);
      travelRef.current = null;
      return clearTimers;
    }

    setTraveling(false);
    setX(0);
    setFlip(false);
    setRenderState('idle');
    setPuffs([]);
    travelRef.current = null;

    const startIdleSequence = () => {
      // After 2 full cycles, insert gaming before curious
      if (idleCycleCount.current >= GAMING_TRIGGER_CYCLES) {
        idleCycleCount.current = 0;
        setRenderState('gaming');
        timers.current.push(window.setTimeout(() => {
          setRenderState('idle');
          startGamingSequence();
        }, GAMING_MS));
        return;
      }

      // Step 1: curious after 8 s idle
      timers.current.push(window.setTimeout(() => {
        setRenderState('curious');

        // Step 2: run after 10 s more
        timers.current.push(window.setTimeout(() => {
          const parent = wrapRef.current?.offsetParent as HTMLElement | null;
          const maxX = parent
            ? Math.max(0, parent.clientWidth - MASCOT_W - LEFT_OFFSET * 2)
            : 120;

          setRenderState('running');
          setTraveling(true);
          setFlip(false);
          setX(maxX);
          travelRef.current = { startX: 0, targetX: maxX, startTime: Date.now() };

          // Step 3: run back left
          timers.current.push(window.setTimeout(() => {
            setFlip(true);
            setX(0);
            travelRef.current = { startX: maxX, targetX: 0, startTime: Date.now() };

            // Step 4: collapse into sleep
            timers.current.push(window.setTimeout(() => {
              setTraveling(false);
              setFlip(false);
              setPuffs([]);
              travelRef.current = null;
              setRenderState('sleep');

              // Step 5: stretching after sleep
              timers.current.push(window.setTimeout(() => {
                setRenderState('stretching');

                // Step 6: back to idle, loop
                timers.current.push(window.setTimeout(() => {
                  idleCycleCount.current += 1;
                  setRenderState('idle');
                  startIdleSequence();
                }, STRETCHING_MS));
              }, SLEEP_AFTER_RUN_MS));
            }, LEG_MS));
          }, LEG_MS));
        }, RUN_AFTER_CURIOUS_MS));
      }, CURIOUS_DELAY_MS));
    };

    const startGamingSequence = () => {
      timers.current.push(window.setTimeout(() => {
        setRenderState('idle');
        startIdleSequence();
      }, CURIOUS_DELAY_MS));
    };

    startIdleSequence();
    return clearTimers;
  }, [baseState]);

  useEffect(() => {
    if (!traveling) return;
    const id = window.setInterval(() => {
      const tr = travelRef.current;
      if (!tr) return;
      const progress = Math.min((Date.now() - tr.startTime) / LEG_MS, 1);
      const curX = tr.startX + (tr.targetX - tr.startX) * progress;
      const goingRight = tr.targetX > tr.startX;
      const puffX = LEFT_OFFSET + curX + (goingRight ? -4 : MASCOT_W + 2);
      setPuffs((prev) => [
        ...prev,
        { id: puffId.current++, x: Math.max(2, puffX), born: Date.now() },
      ]);
    }, PUFF_EVERY_MS);
    return () => window.clearInterval(id);
  }, [traveling]);

  useEffect(() => {
    if (puffs.length === 0) return;
    const t = window.setTimeout(() => {
      const cutoff = Date.now() - PUFF_FADE_MS - 50;
      setPuffs((prev) => prev.filter((p) => p.born > cutoff));
    }, PUFF_FADE_MS + 100);
    return () => window.clearTimeout(t);
  }, [puffs]);

  return (
    <>
      {puffs.map((p) => (
        <DustPuff key={p.id} x={p.x} />
      ))}
      <div
        ref={wrapRef}
        className="pointer-events-none absolute -top-8 left-5 z-10"
        style={{
          transform: `translateX(${x}px)`,
          transition: traveling ? `transform ${LEG_MS}ms linear` : 'none',
        }}
      >
        <FeralMascot state={renderState} flip={flip} />
        <ToolCallStack
          events={useChat((s) => s.toolCallStream)}
          active={renderState !== 'idle'}
        />
      </div>
    </>
  );
}
