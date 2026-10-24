import { safeHref } from "../../../src/ticket-mode/board-view.ts";
import type { RunEntry } from "../runs/runs-model.ts";
import type { Properties as PropertiesView } from "./run-detail-model.ts";

/** The ticket's key, linking to the tracker when the queue sends an address that is safe to follow. */
function TicketLink({ entry }: Readonly<{ entry: RunEntry }>) {
  const href = safeHref(entry.ticket.url);
  return href === "" ? <span className="mono prop-key">{entry.ticket.key}</span> : <a className="link mono prop-key" href={href} target="_blank" rel="noreferrer">{entry.ticket.key}</a>;
}

/** "Properties": the ticket, repositories, model and plan, then the worker, tokens and version, each only when the run has one. */
export function Properties({ entry, values }: Readonly<{ entry: RunEntry; values: PropertiesView }>) {
  return (
    <aside aria-label="Run properties" className="props">
      <div className="props-head">Properties</div>
      <dl className="props-list">
        <dt>Ticket</dt>
        <dd><TicketLink entry={entry} /></dd>
        <dt>Repositories</dt>
        <dd>{values.repos}</dd>
        <dt>Model</dt>
        <dd>{values.model}</dd>
        <dt>Plan</dt>
        <dd>{values.plan}</dd>
        {values.worker === null ? null : (
          <>
            <dt>Worker</dt>
            <dd className="mono"><span className="prop-key">{values.worker}</span></dd>
          </>
        )}
        {values.tokens === null ? null : (
          <>
            <dt>Tokens</dt>
            <dd className="prop-tokens">{values.tokens}</dd>
          </>
        )}
        {values.version === null ? null : (
          <>
            <dt>Version</dt>
            <dd>{values.version}</dd>
          </>
        )}
      </dl>
    </aside>
  );
}
