import { ReactNode } from 'react';
import { ModelSelector } from './ModelSelector';

interface Props {
  children: ReactNode;
}

export function AgentsPageLayout({ children }: Props) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-primary">
      {/* Left sidebar: Model selector (fixed 280px) */}
      <div className="w-80 flex-shrink-0 flex flex-col">
        <ModelSelector />
      </div>

      {/* Right side: Agents content (flex-1) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
