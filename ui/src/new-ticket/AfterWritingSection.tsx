import type { QueueView } from "../api/types.ts";
import { afterTextOf, type AfterWriting } from "./new-ticket-model.ts";

type Props = Readonly<{ after: AfterWriting; /** The live queue, whose pause holds queued tickets; null before it is read. */ queue: QueueView | null; disabled: boolean; onChoose: (after: AfterWriting) => void }>;

/**
 * What happens to the tickets once the writer has filed them (A11-420): "Keep in backlog", chosen when the dialog opens, or "Queue them", with the board's one line under it. The toggle
 * is Placement's, and is disabled whenever the form cannot be sent.
 */
export function AfterWritingSection({ after, queue, disabled, onChoose }: Props) {
  return (
    <div className="nt-placement">
      <div className="nt-placement-head">
        <span className="nt-placement-title">After writing</span>
        <div role="radiogroup" aria-label="After writing" className="nt-toggle nt-after-toggle">
          <button type="button" role="radio" aria-checked={after === "backlog"} disabled={disabled} onClick={() => onChoose("backlog")}>Keep in backlog</button>
          <button type="button" role="radio" aria-checked={after === "queue"} disabled={disabled} onClick={() => onChoose("queue")}>Queue them</button>
        </div>
      </div>
      <p className="nt-auto-text">{afterTextOf(after, queue)}</p>
    </div>
  );
}
