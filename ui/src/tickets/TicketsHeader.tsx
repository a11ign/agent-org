import { SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { PlusIcon } from "./icons.tsx";

type HeaderProps = Readonly<{
  /** The count's words ("37 assigned to you"), or null while the tickets load, which draws the board's skeleton. */
  count: string | null;
  /** Whether Expand all reads "Collapse all", and whether it does anything: it has nothing to open or close while the list is not drawn. */
  allOpen: boolean;
  foldable: boolean;
  onFold: () => void;
  /** Whether this instance writes tickets, which New ticket needs; an instance that does not has no button. */
  writer: boolean;
}>;

/** The page's header: the h1, the count, Expand all, and New ticket, which is present and disabled until the dialog (its own ticket) opens from it. */
export function TicketsHeader({ count, allOpen, foldable, onFold, writer }: HeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-title">
        <h1 className="page-heading">Tickets</h1>
        {count === null ? <SkeletonBlock shape="count" /> : <span className="page-count">{count}</span>}
      </div>
      <button type="button" className="ghost" disabled={!foldable} onClick={onFold}>{allOpen ? "Collapse all" : "Expand all"}</button>
      {writer ? (
        <button type="button" className="primary primary-small" disabled>
          <PlusIcon />
          New ticket
        </button>
      ) : null}
    </div>
  );
}
