import type { Callout as CalloutView, RunBoard } from "./run-detail-model.ts";
import { MERGE_NOTE } from "./run-detail-model.ts";

/** "Current state": the board's title in its colours, the backend's own words beneath, and, on the Ready board, the button to the pull request a person merges. */
export function Callout({ board, callout, open }: Readonly<{ board: RunBoard; callout: CalloutView; open: Readonly<{ href: string; label: string }> | null }>) {
  return (
    <section aria-label="Current state" className={`callout callout-${board}`}>
      <div className="callout-title">{callout.title}</div>
      {callout.paragraphs.map((text) => <p key={text} className="callout-body">{text}</p>)}
      {callout.help === null ? null : <span className="callout-help">{callout.help}</span>}
      {board === "ready" ? (
        <div className="callout-merge">
          {open === null ? null : <a className="callout-open" href={open.href} target="_blank" rel="noreferrer">{open.label}</a>}
          <span className="callout-help">{MERGE_NOTE}</span>
        </div>
      ) : null}
    </section>
  );
}
