import { Skeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";

const CARDS = [1, 2, 3, 4] as const;

/** The Settings Loading board's layout: a title block and four cards, each a heading, a line and a panel. */
export function SettingsSkeleton({ label = "Loading settings" }: Readonly<{ label?: string }>) {
  return (
    <Skeleton label={label} className="skeleton-settings">
      <div className="sk sk-settings-title" />
      {CARDS.map((card) => (
        <div key={card} className="skeleton-settings-card">
          <SkeletonBlock shape="count" />
          <SkeletonBlock shape="text" width="55%" />
          <div className="sk sk-settings-panel" />
        </div>
      ))}
    </Skeleton>
  );
}
