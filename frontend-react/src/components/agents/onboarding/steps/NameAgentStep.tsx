import { useRef, useEffect } from 'react';

interface Props {
  name: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
}

export function NameAgentStep({ name, onChange, onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="max-w-md mx-auto space-y-4 pt-2">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-text-primary">What do you want to call it?</h2>
        <p className="text-xs text-text-muted">You'll be able to rename this in a future update.</p>
      </div>

      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(); }}
        placeholder="e.g. My Research Assistant"
        className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
      />
    </div>
  );
}
