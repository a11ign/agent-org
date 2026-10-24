import type { QueueView } from "../api/types.ts";
import { settingsSectionHref } from "../shell/routes.ts";
import type { Pool } from "../settings/use-pool.ts";
import { PauseIcon } from "./icons.tsx";
import { poolOf, poolWords } from "./runs-model.ts";

/**
 * The worker pool bar: whether workers are started, a square for each slot with one filled for each run holding one (the planning colour for a Planning run), what that comes to in words, what happens to
 * queued tickets, the way to the limit, and the button that pauses or starts workers. The numbers are the queue's own.
 */
export function PoolBar({ queue, pool }: Readonly<{ queue: QueueView; pool: Pool }>) {
  const words = poolWords(pool.paused === true ? "paused" : "started");
  const { slots, text } = poolOf(queue);
  return (
    <div className="pool-bar">
      <div className="pool-title">
        <span className="pool-dot" />
        <span className="pool-title-text">{words.title}</span>
      </div>
      <div className="pool-slots">
        <div role="img" aria-label={text} className="slots">
          {slots.map((slot, index) => (
            <span key={index} className={`slot slot-${slot}`} />
          ))}
        </div>
        <span className="pool-busy">{text}</span>
      </div>
      <span className="pool-note">{words.note}</span>
      <div className="pool-spacer" />
      <a className="pool-link" href={settingsSectionHref("workers")}>Change limit</a>
      <button type="button" className="ghost ghost-medium" disabled={pool.pauseState.kind === "saving"} onClick={pool.togglePause}>
        <PauseIcon />
        {words.button}
      </button>
    </div>
  );
}
