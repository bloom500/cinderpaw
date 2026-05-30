import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { getRandomSuggestions } from '@/lib/suggestions';
import { cn } from '@/lib/utils';

export function NoModelEmptyState() {
  const navigate = useNavigate();
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-muted px-6">
      <h2 className="text-xl text-text-secondary mb-2">No model selected</h2>
      <p className="mb-6 text-center">Load a local model or configure a cloud key to start chatting.</p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate('/models')}>
          Open Models
        </Button>
        <Button variant="outline" onClick={() => navigate('/settings')}>
          Cloud Keys
        </Button>
      </div>
    </div>
  );
}

interface NewChatEmptyStateProps {
  isEmpty: boolean;
  onSuggestion: (text: string) => void;
}

export function NewChatEmptyState({ isEmpty, onSuggestion }: NewChatEmptyStateProps) {
  const [suggestions] = useState(() => getRandomSuggestions(3));

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Greeting — centered but pushed up to sit above the input */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-28">
        <h1 className="text-2xl font-semibold text-text-primary select-none">
          What can I help you with?
        </h1>
      </div>

      {/* Suggestion pills — sit below the input */}
      <div className="absolute inset-x-0 top-1/2 pt-16 flex flex-wrap justify-center gap-2 px-6 pointer-events-auto">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion(s)}
            className="px-4 py-1.5 rounded-full border border-border-default bg-bg-surface hover:bg-bg-hover text-sm text-text-secondary transition-colors cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
