import { ActionIcon } from "../runs/icons.tsx";
import { MESSAGE_TITLE, PUBLISH_TERMINAL_TITLE } from "../runs/publish-model.ts";
import type { Callout as CalloutView, MergeRow, RunBoard } from "./run-detail-model.ts";

/** The row beneath the words: the publish run's terminal while it posts, the button to the pull request a person merges, the posted message, and the board's sentence about merging. */
function Merge({ board, row }: Readonly<{ board: RunBoard; row: MergeRow }>) {
  const { terminalHref, open, messageHref, note } = row;
  return (
    <div className={board === "ready" ? "callout-merge" : "callout-merge callout-merge-tall"}>
      {terminalHref === null ? null : (
        <a className="ghost callout-terminal" href={terminalHref} target="_blank" rel="noreferrer" title={PUBLISH_TERMINAL_TITLE}>
          <ActionIcon verb="talk" />
          Open terminal
        </a>
      )}
      {open === null ? null : <a className="callout-open" href={open.href} target="_blank" rel="noreferrer">{open.label}</a>}
      {messageHref === null ? null : <a className="ghost callout-message" href={messageHref} target="_blank" rel="noreferrer" title={MESSAGE_TITLE}>Slack message</a>}
      <span className="callout-help">{note}</span>
    </div>
  );
}

/** "Current state": the board's title in its colours, the backend's own words beneath, and, on the boards of a run a person merges, the row to the pull request. */
export function Callout({ board, callout, merge }: Readonly<{ board: RunBoard; callout: CalloutView; merge: MergeRow | null }>) {
  return (
    <section aria-label="Current state" className={`callout callout-${board}`}>
      <div className="callout-title">{callout.title}</div>
      {callout.paragraphs.map((text) => <p key={text} className="callout-body">{text}</p>)}
      {callout.help === null ? null : <span className="callout-help">{callout.help}</span>}
      {merge === null ? null : <Merge board={board} row={merge} />}
    </section>
  );
}
