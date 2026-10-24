import { Fragment } from "react";
import type { RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { Skeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { railOf, type RailItem } from "./runs-model.ts";

/** One status of the rail: a toggle pressed when it is the one shown, dimmed when no run has it. */
function RailButton({ label, count, pressed, onPress }: Readonly<{ label: string; count: number; pressed: boolean; onPress: () => void }>) {
  return (
    <button type="button" className={count === 0 ? "rail-button rail-button-empty" : "rail-button"} aria-pressed={pressed} onClick={onPress}>
      <span className="rail-label">{label}</span>
      <span className="rail-count">{count}</span>
    </button>
  );
}

/** The rail while the queue is read: the board's skeleton, heard as one status. */
function RailSkeleton() {
  return (
    <Skeleton label="Loading run statuses" className="skeleton-rail">
      <SkeletonBlock shape="line" />
      <SkeletonBlock shape="heading-short" />
      <SkeletonBlock shape="line" width="80%" />
      <SkeletonBlock shape="line" width="70%" />
      <SkeletonBlock shape="line" width="85%" />
    </Skeleton>
  );
}

export type RailProps = Readonly<{ filter: RunStatus | null; onChoose: (status: RunStatus | null) => void }>;

/**
 * The sidebar's Run status rail: "All runs", then every status under its head with how many runs have it, whether workers are paused or not. It is the board's skeleton while the queue is read, and is not
 * drawn while the queue holds no run or has never answered. The choice is the page's: the list shows the runs of the status chosen.
 */
export function StatusRail({ filter, onChoose }: RailProps) {
  const { queue } = useShell();
  if (queue.data === null) return queue.state === "loading" ? <RailSkeleton /> : null;
  if (queue.data.entries.length === 0) return null;
  const rail = railOf(queue.data);
  return (
    <nav aria-label="Run status" className="sidebar-section">
      <RailButton label="All runs" count={rail.all} pressed={filter === null} onPress={() => onChoose(null)} />
      {rail.heads.map((head) => (
        <Fragment key={head.label}>
          <div className="rail-head">{head.label}</div>
          {head.items.map((item: RailItem) => (
            <RailButton key={item.status} label={item.label} count={item.count} pressed={filter === item.status} onPress={() => onChoose(item.status)} />
          ))}
        </Fragment>
      ))}
    </nav>
  );
}
