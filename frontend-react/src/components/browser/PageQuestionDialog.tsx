import { useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useBrowser, type PageQuestion } from '@/stores/browser';

/**
 * A web page's own question: `alert`, `confirm`, `prompt`, or "Leave site?"
 * when the person is about to leave a page with changes it has not saved.
 *
 * Chromium draws these itself, where the page is. For a tab parked off screen
 * that was nowhere, and the dialog still blocked the whole app (29 Oct). The
 * host hands every one to this dialog instead, which is always on screen: see
 * `hook_dialogs` in src-tauri/src/browser.rs. The page waits for the answer.
 * Closing the dialog is Cancel, or Stay.
 */
export function PageQuestionDialog() {
  const ask = useBrowser((s) => s.dialogs[0]);
  // Keyed: a second question waiting behind the first starts with its own text.
  return ask ? <Question key={ask.id} ask={ask} /> : null;
}

function Question({ ask }: { ask: PageQuestion }) {
  const answer = useBrowser((s) => s.answerDialog);
  const [text, setText] = useState(ask.text);
  const leave = ask.kind === 'leave';
  const ok = () => answer(true, ask.kind === 'prompt' ? text : undefined);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) answer(false); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{leave ? `Leave ${ask.site}?` : `${ask.site} says`}</DialogTitle>
          <DialogDescription className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
            {leave ? 'This page has changes that are not saved yet. If you leave, they are gone.' : ask.message}
          </DialogDescription>
        </DialogHeader>
        {ask.kind === 'prompt' && (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ok(); }}
            aria-label={`Answer to ${ask.site}`}
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-hidden focus:ring-1 focus:ring-brand"
          />
        )}
        <DialogFooter>
          {ask.kind !== 'alert' && (
            <button
              type="button"
              onClick={() => answer(false)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              {leave ? 'Stay' : 'Cancel'}
            </button>
          )}
          <button
            type="button"
            onClick={ok}
            className="px-3 py-1.5 text-sm rounded bg-brand text-on-brand"
          >
            {leave ? 'Leave' : 'OK'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
