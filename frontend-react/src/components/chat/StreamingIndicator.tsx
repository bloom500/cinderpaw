export function StreamingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-2 text-text-muted text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse [animation-delay:300ms]" />
    </div>
  );
}
