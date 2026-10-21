import { ShareUsageCard } from '@/components/usage/ShareUsageCard';

interface NewChatEmptyStateProps {
  isEmpty: boolean;
}

export function NewChatEmptyState({ isEmpty }: NewChatEmptyStateProps) {
  if (!isEmpty) return null;

  // Rendered inside the composer's wrapper, under the intent cards, like the
  // greeting: the centring there knows how tall everything is. Pinned to the
  // window's bottom edge instead, it slid under the intent cards on a short
  // window (a Mac, 17 Oct 2026), both see-through, the two texts on top of
  // each other.
  return (
    <div className="flex flex-col items-center px-4 pb-4 pointer-events-none">
      {/* Hides itself unless the usage question was never answered. The
          "add a cloud key" note that sat here is gone (20 Oct): one notice at a
          time is the rule, and the cloud choice lives on the Models page. */}
      <ShareUsageCard />
    </div>
  );
}
