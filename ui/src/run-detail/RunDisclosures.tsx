import { safeHref } from "../../../src/ticket-mode/board-view.ts";
import type { Disclosures, Proposal, TicketChange } from "./run-detail-model.ts";

/** What changed in the ticket's description, as a line diff: the old lines struck, the new ones added. The text is drawn as text, never as markup. */
function Changed({ change }: Readonly<{ change: TicketChange }>) {
  return (
    <details className="disclosure">
      <summary className="disclosure-summary">
        <span className="disclosure-title">{change.heading}</span>
        <span className="disclosure-note">{change.summary}</span>
      </summary>
      <pre className="disclosure-body disclosure-diff" tabIndex={0}>
        {change.lines.map(({ kind, text }, index) => {
          const shown = text === "" ? " " : text;
          if (kind === "removed") return <del key={index}>{shown}</del>;
          return kind === "added" ? <ins key={index}>{shown}</ins> : <span key={index} className="diff-same">{shown}</span>;
        })}
      </pre>
    </details>
  );
}

/** The pull requests of its blockers that a queued run's planner learns from, each linked. */
function Learns({ links }: Readonly<{ links: Disclosures["learns"] }>) {
  return (
    <p className="disclosure-line">
      learns from{" "}
      {links.map(({ text, url }, index) => {
        const href = safeHref(url);
        return (
          <span key={url}>
            {index === 0 ? "" : ", "}
            {href === "" ? text : <a className="link" href={href} target="_blank" rel="noreferrer">{text}</a>}
          </span>
        );
      })}
    </p>
  );
}

/** The worker's proposed edit to its ticket: the text the ticket has now, and the text it would have. Apply edit and Discard edit are the header's. */
function ProposedEdit({ proposal }: Readonly<{ proposal: Proposal }>) {
  return (
    <details className="disclosure">
      <summary className="disclosure-summary"><span className="disclosure-title">{proposal.summary}</span></summary>
      <div className="disclosure-body">
        <div className="disclosure-label">Now</div>
        <pre className="disclosure-text">{proposal.now}</pre>
        <div className="disclosure-label">Proposed</div>
        <pre className="disclosure-text">{proposal.proposed}</pre>
      </div>
    </details>
  );
}

/** Every line of the run's note, whole. */
function Noted({ lines }: Readonly<{ lines: readonly string[] }>) {
  return (
    <details className="disclosure">
      <summary className="disclosure-summary"><span className="disclosure-title">Everything this run noted</span></summary>
      <ul className="disclosure-body disclosure-list">
        {lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
      </ul>
    </details>
  );
}

const saysNothing = ({ changed, learns, proposal, noted }: Disclosures): boolean => changed === null && learns.length === 0 && proposal === null && noted.length === 0;

/**
 * What `ui.html` shows of a run that the callout does not: what changed in its ticket, what it learns from, the proposed edit's text and the whole of its note, each a disclosure in the boards'
 * style, closed to start with. A run with none of them draws nothing.
 */
export function RunDisclosures({ disclosures }: Readonly<{ disclosures: Disclosures }>) {
  const { changed, learns, proposal, noted } = disclosures;
  if (saysNothing(disclosures)) return null;
  return (
    <section aria-label="More about this run" className="disclosures">
      {changed === null ? null : <Changed change={changed} />}
      {learns.length === 0 ? null : <Learns links={learns} />}
      {proposal === null ? null : <ProposedEdit proposal={proposal} />}
      {noted.length === 0 ? null : <Noted lines={noted} />}
    </section>
  );
}
