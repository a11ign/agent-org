import type { QueueView } from "../api/types.ts";
import { FoldChevron, StatusIcon } from "./icons.tsx";
import { TicketTree, type RowContext } from "./TicketRow.tsx";
import { pickableIn, type Section } from "./tickets-model.ts";

/** What a section needs of the page besides its rows' context: which sections are open, and how a section is opened or closed. */
export type SectionsContext = Readonly<{ row: RowContext; open: ReadonlySet<string>; toggleSection: (status: string) => void; queue: QueueView | null }>;

/** "Showing 12 of 25 backlog tickets": how many the filters keep of what the project holds in the status. */
export const footerText = (section: Section): string => `Showing ${section.shown} of ${section.total} ${section.status.toLowerCase()} tickets`;

/** The header of a section: its collapse button, Select all shown, the status icon, the status and how many tickets the project holds in it. */
function SectionHead({ section, open, context }: Readonly<{ section: Section; open: boolean; context: SectionsContext }>) {
  const { status, total } = section;
  const pickable = pickableIn(section, context.queue).map(({ key }) => key);
  const all = pickable.length > 0 && pickable.every((key) => context.row.selected.has(key));
  return (
    <div className="section-head">
      <button type="button" className="fold-button" aria-label={`${open ? "Collapse" : "Expand"} ${status}`} aria-expanded={open} onClick={() => context.toggleSection(status)}>
        <FoldChevron open={open} />
      </button>
      <input type="checkbox" aria-label={`Select all shown in ${status}`} checked={all} disabled={pickable.length === 0} onChange={(event) => (event.target.checked ? context.row.pick(pickable) : context.row.unpick(pickable))} />
      <StatusIcon status={status} />
      <span className="section-name">{status}</span>
      <span className="section-count">{total}</span>
    </div>
  );
}

/** One status of the list: its header, then, while it is open, its tickets as a tree (or "No tickets match this filter.") and the count of what is shown. */
export function SectionView({ section, context }: Readonly<{ section: Section; context: SectionsContext }>) {
  const open = context.open.has(section.status);
  return (
    <section aria-label={section.status} className="ticket-section">
      <SectionHead section={section} open={open} context={context} />
      {open ? (
        <>
          {section.nodes.map((node) => <TicketTree key={node.ticket.key} node={node} depth={0} context={context.row} />)}
          {section.nodes.length === 0 ? <div className="section-empty">No tickets match this filter.</div> : null}
          <div className="section-foot">{footerText(section)}</div>
        </>
      ) : null}
    </section>
  );
}

/** The list: one section per status. */
export function Sections({ sections, context }: Readonly<{ sections: readonly Section[]; context: SectionsContext }>) {
  return (
    <>
      {sections.map((section) => <SectionView key={section.status} section={section} context={context} />)}
    </>
  );
}

