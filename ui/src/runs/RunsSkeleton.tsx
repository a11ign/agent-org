import { Skeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";

const ROW_WIDTHS: readonly string[] = ["55%", "70%", "48%", "65%", "58%", "72%"];

/** The loading layout of the Runs board: the pool bar's block, then a card with a heading and six rows, heard as one status. */
export function RunsSkeleton() {
  return (
    <Skeleton label="Loading runs" className="skeleton-runs">
      <SkeletonBlock shape="banner" />
      <div className="skeleton-runs-card">
        <div className="skeleton-runs-head">
          <div className="sk sk-runs-heading" />
        </div>
        {ROW_WIDTHS.map((width) => (
          <div className="skeleton-runs-row" key={width}>
            <div className="sk sk-runs-icon" />
            <div className="skeleton-runs-lines">
              <SkeletonBlock shape="crumb" width={width} />
              <SkeletonBlock shape="text" width="35%" />
            </div>
            <div className="sk sk-runs-pill" />
          </div>
        ))}
      </div>
    </Skeleton>
  );
}
