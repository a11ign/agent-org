import type { FlakesView, InterventionsView, QueueView } from "../api/types.ts";
import { settingsSectionHref } from "../shell/routes.ts";
import type { Pool } from "../settings/use-pool.ts";
import { PauseIcon } from "./icons.tsx";
import { poolOf, poolWords } from "./runs-model.ts";
import { useFlakes } from "./use-flakes.ts";
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

/** The tests that need a fix (A11-300): how many flaked three times in seven days, each named with its count in the title. Nothing while the list is unread (a read that failed) and nothing while no test needs a fix; a log that is there and cannot be read is said. */
function FlakyTests({ flakes }: Readonly<{ flakes: FlakesView | null }>) {
  if (flakes === null) return null;
  // An unreadable log is not an empty one: the list of flaky tests is unknown, and the note says so (A11-300).
  if (flakes.unreadable !== undefined) return <span className="pool-note pool-flakes" title={flakes.unreadable}>Flaky tests: the flake log cannot be read</span>;
  if (flakes.tests.length === 0) return null;
  const { tests, limit, days } = flakes;
  return <span className="pool-note pool-flakes" title={tests.map(({ test, count, check }) => `${test} (${check}): flaked ${count} times in ${days} days`).join("\n")}>Flaky tests needing a fix: {tests.length} (flaked {limit}+ times in {days} days)</span>;
}

/**
 * The count of After-merge checks the org itself has open past three days (A11-302): the org verifies its own work, so the person sees only their own checks in the list, and this number says whether the org keeps up. Its title says how many
 * are open in all. Nothing from an instance that sends no count.
 */
function OrgChecks({ org, unreadable }: Readonly<{ org: QueueView["afterMergeOrg"]; unreadable: QueueView["afterMergeUnreadable"] }>) {
  // A checks file that cannot be read is said, not counted as none: the list and the count would both read clean (A11-302).
  if (unreadable !== undefined) return <span className="pool-note pool-org-checks" title={unreadable}>Org checks: cannot be read</span>;
  if (org === undefined) return null;
  return <span className="pool-note pool-org-checks" title={`${org.open} After-merge checks the org verifies are open; this counts those older than 3 days and outside their window`}>Org checks open over 3 days: {org.stale}</span>;
}

/**
 * The worker pool bar: whether workers are started, a square for each slot with one filled for each run holding one (the planning colour for a Planning run), what that comes to in words, the health number, what happens to
 * queued tickets, the way to the limit, and the button that pauses or starts workers. The numbers are the queue's own.
 */
export function PoolBar({ queue, pool, disabled }: Readonly<{ queue: QueueView; pool: Pool; disabled: boolean }>) {
  const words = poolWords(pool.paused === true ? "paused" : "started");
  const { slots, text } = poolOf(queue);
  const health = useHealth();
  const flakes = useFlakes();
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
        <OrgChecks org={queue.afterMergeOrg} unreadable={queue.afterMergeUnreadable} />
        <FlakyTests flakes={flakes} />
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
