import { useEffect, useRef, type CSSProperties } from "react";
import { NEEDS_DECISION, GRILL, GRILL_TITLE, safeHref } from "../../../src/ticket-mode/board-view.ts";
import { QUEUE_CHILDREN, QUEUE_CHILDREN_TITLE, childrenNote, isParentTicket, missingPlan, parentTick, projectOf, selectable, ticketCount, type TicketNode } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { ownerName } from "../../../src/ticket-mode/assignee-filter.ts";
import { groupTags } from "../../../src/ticket-mode/label-filters.ts";
import type { QueueView, TicketView } from "../api/types.ts";
import { FoldChevron, NoPlanMark, PriorityMark } from "./icons.tsx";

/** What a row needs of the page: the queue, the selection, which parents are open, whether rows name their owner, and what the row's buttons do. */
export type RowContext = Readonly<{
  queue: QueueView | null;
  selected: ReadonlySet<string>;
  openParents: ReadonlySet<string>;
  showsOwner: boolean;
  /** Why Grill is disabled on this machine, or null when it is not. */
  grillReason: string | null;
  /** The pattern a plan's name matches (`tickets.plan`), or null when the board looks for none, and every ticket the board knows, parents included: what the no-plan mark reads. */
  plan: RegExp | null;
  planUniverse: readonly TicketView[];
  /** True while the instance cannot be reached: the rows are the last known ones, and nothing on them can be picked, queued or grilled. */
  paused: boolean;
  pick: (keys: readonly string[]) => void;
  unpick: (keys: readonly string[]) => void;
  toggleParent: (key: string) => void;
  queueChildren: (ticket: TicketView) => void;
  grill: (ticket: TicketView) => void;
}>;

/** The note a row carries when its ticket is on the queue or another instance holds it. */
function standingOf(ticket: TicketView, queue: QueueView | null): string | null {
  const run = queue?.entries.find((entry) => entry.ticket.key === ticket.key);
  if (run !== undefined) return `On the queue: ${run.phase}`;
  return ticket.taken === undefined ? null : `Taken: ${ticket.taken}`;
}

/** The indent of a row under a parent: how many steps in it is, which the stylesheet turns into space. */
const indent = (depth: number): CSSProperties => ({ "--depth": depth }) as CSSProperties;

const TAKEN_TITLE = "Another instance holds this ticket: its claim in the tracker names that instance, not this one";

function Title({ ticket }: Readonly<{ ticket: TicketView }>) {
  const href = safeHref(ticket.url);
  return href === "" ? <span className="row-title" title={ticket.title}>{ticket.title}</span> : (
    <a className="row-title" href={href} target="_blank" rel="noreferrer" title={ticket.title}>{ticket.title}</a>
  );
}

/** The Queue its children button of a parent, and how many open sub-issues it has. */
function ChildrenOf({ ticket, context }: Readonly<{ ticket: TicketView; context: RowContext }>) {
  if (!isParentTicket(ticket)) return null;
  return (
    <>
      <span className="row-note">{childrenNote(ticket)}</span>
      <button type="button" className="ghost ghost-small" title={QUEUE_CHILDREN_TITLE} disabled={context.paused} onClick={() => context.queueChildren(ticket)}>{QUEUE_CHILDREN}</button>
    </>
  );
}

/** The Needs a decision pill and its Grill button, which a ticket with an open decision shows in place of its goal. */
function Decision({ ticket, context }: Readonly<{ ticket: TicketView; context: RowContext }>) {
  if (ticket.needsDecision === undefined) return null;
  return (
    <>
      <span className="pill-tag pill-tag-warn" title={ticket.needsDecision.reason}>{NEEDS_DECISION}</span>
      <button type="button" className="ghost ghost-small" title={context.grillReason ?? GRILL_TITLE} disabled={context.grillReason !== null || context.paused} onClick={() => context.grill(ticket)}>{GRILL}</button>
    </>
  );
}

/** The mark of a ticket with no plan of its own, muted when its parent's plan covers it. Nothing when it has a plan, or the board looks for none. */
function PlanMark({ ticket, context }: Readonly<{ ticket: TicketView; context: RowContext }>) {
  const missing = context.plan === null ? null : missingPlan(ticket, context.plan, context.planUniverse);
  if (missing === null) return null;
  return <NoPlanMark note={missing.note} covered={missing.covered} />;
}

/** The labels a ticket carries in a group, as small tags after its title, each titled with its group. The Goal group's is the goal pill's already, and the board's row with an open decision draws the decision in place of it. */
function LabelTags({ ticket }: Readonly<{ ticket: TicketView }>) {
  return (
    <>
      {groupTags(ticket).filter(({ group }) => group !== "Goal").map(({ name, group }) => <span key={`${group}|${name}`} className="pill-tag label-tag" title={group ?? ""}>{name}</span>)}
    </>
  );
}

const goalsOf = (ticket: TicketView): string[] => (ticket.labels ?? []).filter(({ group }) => group === "Goal").map(({ name }) => name);

/** What follows a row's title: the parent's sub-issues, the open decision, the goal, the note, the owner and the project. */
function RowTail({ ticket, depth, context }: Readonly<{ ticket: TicketView; depth: number; context: RowContext }>) {
  const note = standingOf(ticket, context.queue);
  return (
    <>
      <ChildrenOf ticket={ticket} context={context} />
      <Decision ticket={ticket} context={context} />
      {ticket.needsDecision === undefined ? goalsOf(ticket).map((goal) => <span key={goal} className="pill-tag">{goal}</span>) : null}
      {depth > 0 ? <span className="row-note">{ticket.status}</span> : null}
      {note === null ? null : <span className="row-note" {...(ticket.taken === undefined ? {} : { title: TAKEN_TITLE })}>{note}</span>}
      {context.showsOwner ? <span className="pill-tag">{ownerName(ticket)}</span> : null}
      <span className="row-project" title={projectOf(ticket)}>{projectOf(ticket)}</span>
    </>
  );
}

/** A ticket with nothing under it in the list: its checkbox picks it, unless a parent, the queue, a decision or another instance holds it back. */
function LeafRow({ ticket, depth, context }: Readonly<{ ticket: TicketView; depth: number; context: RowContext }>) {
  const onQueue = context.queue?.entries.some((entry) => entry.ticket.key === ticket.key) === true;
  const free = selectable(ticket, context.queue?.entries ?? []);
  const picked = context.selected.has(ticket.key);
  const reason = isParentTicket(ticket) ? "A parent is not queued: queue its children" : undefined;
  return (
    <div className={`row${onQueue ? " row-dim" : ""}${picked ? " row-picked" : ""}`} style={indent(depth)} data-key={ticket.key}>
      <input type="checkbox" aria-label={`Select ${ticket.key}`} checked={picked} disabled={!free || context.paused} {...(reason === undefined ? {} : { title: reason })} onChange={(event) => (event.target.checked ? context.pick([ticket.key]) : context.unpick([ticket.key]))} />
      <PriorityMark priority={ticket.priority} />
      <span className="row-key">{ticket.key}</span>
      {isParentTicket(ticket) ? null : <PlanMark ticket={ticket} context={context} />}
      <Title ticket={ticket} />
      <LabelTags ticket={ticket} />
      <RowTail ticket={ticket} depth={depth} context={context} />
    </div>
  );
}

/** How many tickets are under a parent in the list: "3 tickets under it". */
const underIt = (node: TicketNode<TicketView>): string => {
  const count = ticketCount(node.children);
  return `${count} ticket${count === 1 ? "" : "s"} under it`;
};

/** A parent with tickets under it in the list: it folds them away, its checkbox picks them rather than itself, and one that is not the person's says so. */
function ParentRow({ node, depth, context }: Readonly<{ node: TicketNode<TicketView>; depth: number; context: RowContext }>) {
  const { ticket } = node;
  const open = context.openParents.has(ticket.key);
  const tick = parentTick(node, context.selected, context.queue?.entries ?? []);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current !== null) box.current.indeterminate = tick.indeterminate;
  }, [tick.indeterminate]);
  return (
    <div className="row row-parent" style={indent(depth)} data-key={ticket.key}>
      <button type="button" className="fold-button" aria-label={`${open ? "Collapse" : "Expand"} ${ticket.key}`} aria-expanded={open} onClick={() => context.toggleParent(ticket.key)}>
        <FoldChevron open={open} />
      </button>
      <input ref={box} type="checkbox" aria-label={`Select the tickets under ${ticket.key}`} checked={tick.checked} disabled={tick.keys.length === 0 || context.paused} onChange={(event) => (event.target.checked ? context.pick(tick.keys) : context.unpick(tick.keys))} />
      <span className="row-key">{ticket.key}</span>
      <Title ticket={ticket} />
      <LabelTags ticket={ticket} />
      <span className="row-note">{underIt(node)}</span>
      {node.context === true ? <span className="row-note">Not in this view</span> : null}
      <RowTail ticket={ticket} depth={depth} context={context} />
    </div>
  );
}

/** A ticket of the tree and, while it is open, the tickets under it, each indented a step further. */
export function TicketTree({ node, depth, context }: Readonly<{ node: TicketNode<TicketView>; depth: number; context: RowContext }>) {
  if (node.children.length === 0) return <LeafRow ticket={node.ticket} depth={depth} context={context} />;
  return (
    <>
      <ParentRow node={node} depth={depth} context={context} />
      {context.openParents.has(node.ticket.key) ? node.children.map((child) => <TicketTree key={child.ticket.key} node={child} depth={depth + 1} context={context} />) : null}
    </>
  );
}
