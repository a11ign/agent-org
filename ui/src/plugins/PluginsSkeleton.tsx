import { Skeleton } from "../lifecycle/Skeleton.tsx";

const CARDS = [1, 2, 3, 4, 5, 6] as const;

/** The Plugins Loading board's layout: six cards, each a round mark, two lines and a pill. */
export function PluginsSkeleton() {
  return (
    <Skeleton label="Loading plugins" className="skeleton-plugins">
      {CARDS.map((card) => (
        <div key={card} className="skeleton-plugin-card">
          <div className="sk sk-plugin-mark" />
          <div className="skeleton-plugin-lines">
            <div className="sk sk-plugin-title" />
            <div className="sk sk-plugin-text" />
          </div>
          <div className="sk sk-plugin-pill" />
        </div>
      ))}
    </Skeleton>
  );
}
