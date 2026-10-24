import { Fragment } from "react";
import { footerOf, type Paged } from "./runs-model.ts";
import { RunRow, type RowContext } from "./RunRow.tsx";

/** The footer: how many of the runs are drawn, and Load more, which draws 50 more. Hidden when every run is drawn. */
function Footer({ page, onMore }: Readonly<{ page: Paged; onMore: () => void }>) {
  const words = footerOf(page);
  if (words === null) return null;
  return (
    <div className="runs-footer">
      <span>{words}</span>
      <button type="button" className="ghost ghost-footer" onClick={onMore}>Load more</button>
    </div>
  );
}

/** The runs under their headings, each heading with how many runs the filter puts in its group, and the footer. A filter with no runs says so. */
export function RunsList({ page, context, onMore }: Readonly<{ page: Paged; context: RowContext; onMore: () => void }>) {
  return (
    <div className="runs-list">
      {page.groups.map((group) => (
        <Fragment key={group.id}>
          <div className="runs-head">
            <span className="runs-head-label">{group.label}</span>
            <span className="runs-head-count">{group.count}</span>
          </div>
          {group.runs.map((entry) => <RunRow key={entry.ticket.key} entry={entry} context={context} />)}
        </Fragment>
      ))}
      {page.total === 0 ? <div className="runs-none">No runs in this status right now.</div> : null}
      <Footer page={page} onMore={onMore} />
    </div>
  );
}

