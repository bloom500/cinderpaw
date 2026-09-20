import { useState } from 'react';
import { Lightbulb, SquareArrowOutUpRight, X } from 'lucide-react';
import { readLocal, writeLocal } from '@/lib/utils';
import { useUI } from '@/stores/ui';

export const SKILLS_TIP_KEY = 'cinderpaw.tip.skills';

/**
 * What "Try" puts in the composer. A message from the person, not a hidden
 * instruction: they can read it, change it, and it is theirs to send. It
 * names the tool so the agent saves the result instead of only describing it.
 */
export const TEACH_PROMPT =
  'I want to teach you a skill. Ask me what the task is and exactly how I want it done, ' +
  'one question at a time. When you have it, save it with create_skill and show me what you saved.';

/**
 * One line above the composer that offers to teach the task as a skill.
 *
 * Shown only when the agent has called `suggest_skill` on the current task,
 * so it appears on "every Monday, send me..." and not on "what is 2+2": the
 * judgement is the model's, made while it reads the request, not a keyword
 * list here. A pill the width of the composer: a bulb, the sentence, "Try"
 * starting the teach chat, and an X that hides it for good on this machine.
 * Kept in the composer's wrapper so the centring of an empty chat measures it.
 */
export function ComposerTip({ isEmpty, onTry }: { isEmpty: boolean; onTry: () => void }) {
  const [never, setNever] = useState(() => readLocal(SKILLS_TIP_KEY) === 'never');
  const suggested = useUI((s) => s.skillTip);
  const setSkillTip = useUI((s) => s.setSkillTip);
  if (never || !suggested) return null;

  const dismiss = () => {
    writeLocal(SKILLS_TIP_KEY, 'never');
    setNever(true);
    setSkillTip(false);
  };

  return (
    // mb-12: the mascot stands 43 px above the composer's top edge, so a bar
    // right above the box sat under its feet (20 Sep).
    <div className={isEmpty ? 'mx-auto w-full max-w-2xl px-4' : 'px-4'}>
      <div className="mb-12 flex items-center gap-2.5 rounded-2xl border border-border-default bg-bg-elevated py-2 pl-3.5 pr-2 text-sm text-text-primary shadow-lg">
        <Lightbulb size={16} className="shrink-0 text-text-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Skills teach Cinderpaw to do a task exactly the way you want, every time.
        </span>
        <button
          type="button"
          onClick={() => { onTry(); setSkillTip(false); }}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border-default px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          Try <SquareArrowOutUpRight size={12} aria-hidden />
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss tip"
          className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
