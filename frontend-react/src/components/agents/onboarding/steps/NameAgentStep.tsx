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
    <div className="space-y-6 text-center">
      <div className="space-y-2">
        <div className="text-4xl leading-none" aria-hidden="true">✏️</div>
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          Give it a name
        </h2>
        <p className="text-sm text-text-muted">You can always rename it later.</p>
      </div>

      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(); }}
        placeholder="e.g. My Research Assistant"
        className="w-full rounded-xl border border-bg-hover bg-bg-primary px-4 py-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-brand placeholder:text-text-muted text-center"
      />
    </div>
  );
}
