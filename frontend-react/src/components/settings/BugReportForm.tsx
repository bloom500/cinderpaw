import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// What each send outcome says on screen. The Rust side returns short codes;
// a person never sees a code, they see the sentence for it.
const OUTCOME: Record<string, string> = {
  sent:         'Sent. Thank you, we read every one.',
  rate_limited: 'Too many reports from this address. Try again in an hour.',
  too_large:    'The report was too large for the server. Untick the log and send again.',
  network:      'Could not reach the report server. Check your connection and try again.',
};

/**
 * Report a bug without a GitHub account. The description and, if the box
 * stays ticked, the last lines of the app log go to a private channel we
 * read. The log is shown before sending because it contains paths with the
 * person's username in them; they decide whether it leaves the machine.
 */
export function BugReportForm() {
  const [description, setDescription] = useState('');
  const [includeLog, setIncludeLog]   = useState(true);
  const [logPreview, setLogPreview]   = useState('');
  const [busy, setBusy]               = useState(false);
  const [outcome, setOutcome]         = useState<string | null>(null);

  useEffect(() => {
    void tauri.system.bugReportLogPreview().then(setLogPreview).catch(() => setLogPreview(''));
  }, []);

  const send = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await tauri.system.submitBugReport(description.trim(), includeLog);
      setOutcome('sent');
      setDescription('');
    } catch (e) {
      setOutcome(OUTCOME[String(e)] ? String(e) : 'network');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-text-primary">Report a bug</p>
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What happened, and what did you expect instead?"
        rows={4}
        maxLength={4000}
      />
      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input type="checkbox" checked={includeLog} onChange={(e) => setIncludeLog(e.target.checked)} />
        Include the last {logPreview ? logPreview.split('\n').length : 0} lines of the app log
      </label>
      {includeLog && logPreview && (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">Show what will be sent</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-input p-2 whitespace-pre-wrap break-all">
            {logPreview}
          </pre>
        </details>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void send()} disabled={busy || !description.trim()} className="gap-2">
          <Send size={14} /> {busy ? 'Sending…' : 'Send report'}
        </Button>
        {outcome && (
          <span className={outcome === 'sent' ? 'text-xs text-success' : 'text-xs text-error'}>
            {OUTCOME[outcome]}
          </span>
        )}
      </div>
    </div>
  );
}
