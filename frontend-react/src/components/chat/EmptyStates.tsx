import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useModel } from '@/stores/model';

export function NoModelEmptyState() {
  const navigate = useNavigate();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-muted px-6">
      <h2 className="text-xl text-text-secondary mb-2">No model loaded</h2>
      <p className="mb-6">Load a model to start chatting.</p>
      <Button variant="outline" onClick={() => navigate('/models')}>
        Open Models
      </Button>
    </div>
  );
}

export function NewChatEmptyState() {
  const loaded = useModel((s) => s.loaded);
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-muted px-6">
      <h2 className="text-2xl text-text-secondary mb-2">{loaded?.name ?? 'Ready'}</h2>
      <p>Start a conversation.</p>
    </div>
  );
}
