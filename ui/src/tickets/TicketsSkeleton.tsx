import { Skeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";

/** The widths of the eight skeleton rows, as the Tickets loading board draws them. */
export const ROW_WIDTHS: readonly string[] = ["60%", "72%", "45%", "80%", "55%", "68%", "50%", "76%"];

/** The Tickets loading board's list: a section header block over eight rows, each a box, a dot, a key, a title of its own width and a pill. */
export function TicketsSkeleton() {
  return (
    <Skeleton label="Loading tickets" className="skeleton-panel">
      <div className="skeleton-panel-head">
        <SkeletonBlock shape="box" />
        <SkeletonBlock shape="section-label" />
      </div>
      {ROW_WIDTHS.map((width) => (
        <div className="skeleton-panel-row" key={width}>
          <SkeletonBlock shape="box" />
          <SkeletonBlock shape="dot" />
          <SkeletonBlock shape="key" />
          <SkeletonBlock shape="text" width={width} />
          <span className="skeleton-spacer" />
          <SkeletonBlock shape="pill" />
        </div>
      ))}
    </Skeleton>
  );
}
