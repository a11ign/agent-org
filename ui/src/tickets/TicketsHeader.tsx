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
  /** Opens the New ticket dialog. Without it the button is drawn disabled: the instance's config is not read yet, or the connection is paused. */
  onNewTicket?: () => void;
  /** The name of the SSH connection that cannot be reached, which pauses New ticket until it answers; null while it can. */
  pausedFor?: string | null;
  /** Whether the tickets drawn are the last known ones: the board's "Last known" pill beside the count. */
  lastKnown?: boolean;
}>;

/** The page's header: the h1, the count, Expand all, and New ticket, which opens the dialog. */
export function TicketsHeader({ count, allOpen, foldable, onFold, writer, onNewTicket, pausedFor = null, lastKnown = false }: HeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-title">
        <h1 className="page-heading">Tickets</h1>
        {count === null ? <SkeletonBlock shape="count" /> : <span className="page-count">{count}</span>}
        {lastKnown ? <span className="pill-tag pill-tag-warn">Last known</span> : null}
      </div>
      <button type="button" className="ghost" disabled={!foldable} onClick={onFold}>{allOpen ? "Collapse all" : "Expand all"}</button>
      {writer ? (
        <button type="button" className="primary primary-small" disabled={onNewTicket === undefined} onClick={onNewTicket} {...(pausedFor === null ? {} : { title: `Paused until ${pausedFor} is reachable` })}>
          <PlusIcon />
          New ticket
        </button>
      ) : null}
    </div>
  );
}
