import { publishLabel } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { SELECTION_NOTE } from "./publish-model.ts";

/** What the selection bar does: the count of ticked runs, Clear, and the post. */
export type PublishBarControls = Readonly<{ count: number; busy: boolean; disabled: boolean; onClear: () => void; onPublish: () => void }>;

/**
 * The board's bar for the runs ticked for Publish: how many, what Publish does, Clear, and "Publish selected (N)". It is drawn only while at least one run is ticked, and Publish waits while the post is
 * out or the instance cannot be reached.
 */
export function PublishBar({ count, busy, disabled, onClear, onPublish }: PublishBarControls) {
  return (
    <div role="region" aria-label="Selected runs" className="publish-bar">
      <span className="publish-bar-count">{count} selected</span>
      <span className="publish-bar-note">{SELECTION_NOTE}</span>
      <div className="publish-bar-spacer" />
      <button type="button" className="ghost publish-bar-clear" onClick={onClear}>Clear</button>
      <button type="button" className="publish-bar-publish" disabled={busy || disabled} onClick={onPublish}>{publishLabel(count)}</button>
    </div>
  );
}
