import './ember.css';
import type { EmberRun } from './useEmberRun';

/** A small campfire on the composer's edge, only while a long task runs. No
 *  text and no popup: whoever does not want the game never has to notice it. */
export function EmberInvite({ run }: { run: EmberRun }) {
  if (!run.offered) return null;
  return (
    <button
      type="button"
      onClick={run.openPanel}
      aria-label="Play the campfire game while Cinderpaw works"
      title="Play while Cinderpaw works"
      className="absolute -top-7 right-5 z-10 grid h-7 w-7 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-brand"
    >
      <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
        <path d="M5 23 L23 19 M5 19 L23 23" stroke="#6B4A33" strokeWidth="3" strokeLinecap="round" />
        <g className="ember-flame">
          <path d="M14 3 C18 8 21 11 21 15 C21 19 18 21 14 21 C10 21 7 19 7 15 C7 12 9 10 11 8 C11 11 12 12 13 12 C13 9 13 6 14 3 Z" fill="#F45B20" />
          <path d="M14 10 C16 13 17 14 17 16 C17 18 15.6 19 14 19 C12.4 19 11 18 11 16 C11 14.5 12 13.5 13 12.5 C13.2 13.6 13.6 14 14 14 C14 12.5 13.8 11.5 14 10 Z" fill="#FFC53D" />
        </g>
      </svg>
    </button>
  );
}
