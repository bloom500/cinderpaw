import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { getRandomSuggestions } from '@/lib/suggestions';
import { cn } from '@/lib/utils';

const GREETINGS = [
  'What can I help you with?',
  "What's on your mind?",
  'How can I assist you today?',
  'What would you like to explore?',
  'What can I help you build?',
];

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
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [greetingVisible, setGreetingVisible] = useState(true);

  useEffect(() => {
    if (!isEmpty) return;
    const id = setInterval(() => {
      setGreetingVisible(false);
      setTimeout(() => {
        setGreetingIndex((i) => (i + 1) % GREETINGS.length);
        setGreetingVisible(true);
      }, 350);
    }, 4000);
    return () => clearInterval(id);
  }, [isEmpty]);

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Greeting + pills as one column, pushed above the centered input */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-52">
        <h1
          className="text-2xl font-semibold text-text-primary select-none transition-opacity duration-300"
          style={{ opacity: greetingVisible ? 1 : 0 }}
        >
          {GREETINGS[greetingIndex]}
        </h1>

        <div className="mt-4 flex flex-wrap justify-center gap-2 px-6 pointer-events-auto">
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
    </div>
  );
}
