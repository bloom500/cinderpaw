import { CheckCircle } from 'lucide-react';

interface Props {
  agentName: string;
  onViewAgents: () => void;
}

export function DoneStep({ agentName, onViewAgents }: Props) {
  return (
    <div className="max-w-md mx-auto space-y-6 pt-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <CheckCircle size={40} className="text-green-400" />
        <h2 className="text-xl font-semibold text-text-primary">
          "{agentName}" is saved
        </h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          Your agent profile has been saved. It's ready to use once you load a model.
        </p>
      </div>

      <div className="rounded-md bg-bg-hover p-4 text-left space-y-1.5">
        <p className="text-xs font-medium text-text-primary">Next steps</p>
        <ol className="text-xs text-text-muted space-y-1 list-decimal list-inside">
          <li>Go to <span className="text-text-secondary font-medium">Models</span> and load a local model.</li>
          <li>Come back to <span className="text-text-secondary font-medium">Agents</span> to run your agent.</li>
        </ol>
      </div>

      <button
        type="button"
        onClick={onViewAgents}
        className="px-5 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
      >
        View my agents
      </button>
    </div>
  );
}
