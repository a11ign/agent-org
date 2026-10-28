// @ts-check
// module: a run that ended `wrong-repo` naming a repository of the organisation is moved there and queued again (A11-355) -- PURE
import { replace, retry, type Outcome, type Queue, type Entry } from "./queue-entries-and-outcomes.ts";
import { finish } from "./queue-transitions.ts";

/** What `finish` records of the run that ended: its tokens and Claude session. */
type RunRecord = Readonly<{ tokens?: Entry["tokens"]; session?: string }>;

/**
 * A run that ended `wrong-repo` naming `repo`, a repository of the organisation, is moved there and queued again at once: the outcome is logged as the run's ending, as any other would be, the repository becomes the one it is planned
 * for, and a fresh worker is queued in it. Nothing is handed to a person, so it logs no Needs-you event. PURE.
 */
export function reroute(queue: Queue, key: string, { outcome, repo }: Readonly<{ outcome: Outcome; repo: string }>, now: number, record: RunRecord = {}): Queue {
  // After the retry, which builds the entry afresh and so would drop it: the new run is planned for `repo`.
  return replace(retry(finish(queue, key, outcome, now, record), key, now, "rerouted"), key, (entry) => (entry.phase === "queued" ? { ...entry, plannedRepo: repo } : entry));
}
