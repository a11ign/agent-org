import type { InterventionsView, QueueView } from "../api/types.ts";
import { settingsSectionHref } from "../shell/routes.ts";
import type { Pool } from "../settings/use-pool.ts";
import { PauseIcon } from "./icons.tsx";
import { poolOf, poolWords } from "./runs-model.ts";
import { useHealth } from "./use-health.ts";

/** A day of the title: its date and count, and the stand-offs the board settled with no person that day when it settled any (A11-290). */
const dayLine = ({ date, total, standoffs }: InterventionsView["days"][number]): string => (standoffs > 0 ? `${date}: ${total} (${standoffs} stand-offs settled with no person)` : `${date}: ${total}`);

/**
 * The health number (A11-257): today's person-interventions, with the last 7 days, each as its date and count, in the title. When the board settled stand-offs with no person today (a re-review that stayed not convinced, settled by the planner and the worker, A11-290),
 * the words say so after the number, so the chairman sees that route work. Nothing while the number is unread or its read failed.
 */
function HealthNumber({ health }: Readonly<{ health: InterventionsView | null }>) {
  if (health === null) return null;
  const settled = health.days.at(-1)?.standoffs ?? 0;
  return <span className="pool-note pool-health" title={health.days.map(dayLine).join("\n")}>Person interventions today: {health.today}{settled > 0 ? `, stand-offs settled with no person: ${settled}` : ""}</span>;
}

/**
 * The worker pool bar: whether workers are started, a square for each slot with one filled for each run holding one (the planning colour for a Planning run), what that comes to in words, the health number, what happens to
 * queued tickets, the way to the limit, and the button that pauses or starts workers. The numbers are the queue's own.
 */
export function PoolBar({ queue, pool, disabled }: Readonly<{ queue: QueueView; pool: Pool; disabled: boolean }>) {
  const words = poolWords(pool.paused === true ? "paused" : "started");
  const { slots, text } = poolOf(queue);
  const health = useHealth();
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
        <HealthNumber health={health} />
      </div>
      <span className="pool-note">{words.note}</span>
      <div className="pool-spacer" />
      <a className="pool-link" href={settingsSectionHref("workers")}>Change limit</a>
      <button type="button" className="ghost ghost-medium" disabled={disabled || pool.pauseState.kind === "saving"} onClick={pool.togglePause}>
        <PauseIcon />
        {words.button}
      </button>
    </div>
  );
}
