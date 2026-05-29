export const SIDEBAR_W = 240;
export const SIDEBAR_COLLAPSED_W = 56;

export function Sidebar() {
  return (
    <aside
      style={{ width: SIDEBAR_W }}
      className="fixed inset-y-0 left-0 bg-bg-surface z-20"
    />
  );
}
