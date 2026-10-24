// @ts-check
// module: whether a reviewed run's pull requests are ready to merge, and what the run waits on while they are not (A11-179) -- PURE
//
// A `reviewed` OUTCOME SAYS THE WORKER'S FEEDBACK ROUND ENDED; IT SAYS NOTHING OF GITHUB. A pull request is ready to merge when its newest verdict at its current head approves it, GitHub's own review decision
// does not still ask for a review, and no required check is red or running there. The pool records what each watch read of that (`pullHeads`); this reads the record, and never GitHub.
import { shortHead } from "./pull-review-state.ts";
import { pullLabel } from "./pull-label.ts";
import { openPulls, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

/** What a pull request's red check that is not the run's is marked with on the card, beside the note that names where it is red and who owns it (`checkNote`). */
const NOT_THIS_RUNS = "not this run's";

/** The clause that says a head has not been read for readiness: the watch has not run since the run ended, or the code host does not say. */
const NOT_READ = "not read yet";

/** Whether a head's readiness was read: its review, its red checks and its running checks are all there. */
const isRead = (head: PullHead | undefined): head is PullHead & Required<Pick<PullHead, "review" | "red" | "pending">> =>
  head?.review !== undefined && head.red !== undefined && head.pending !== undefined;

/** What one open pull request waits on, one clause each: its review, its red checks, its running checks, or that none of that was read yet. Empty when it is ready. PURE. */
function clausesOf(entry: ViewEntry, url: string): string[] {
  const head = entry.pullHeads?.[url];
  if (!isRead(head)) return [NOT_READ];
  const at = shortHead(head.head);
  const record = entry.checkHeads?.[url];
  const notOurs = record?.step === "not-ours" && record.head === head.head ? Object.keys(record.notOurs ?? {}) : [];
  const named = (name: string): string => (notOurs.includes(name) ? `${name} (${NOT_THIS_RUNS})` : name);
  return [
    ...(head.review === "approved" ? [] : [head.review === "changes-requested" ? `changes requested at ${at}` : `review: none yet at ${at}`]),
    ...(head.red.length === 0 ? [] : [`checks red: ${head.red.map(named).join(", ")}`]),
    ...(head.pending.length === 0 ? [] : [`checks not passed: ${head.pending.join(", ")}`]),
  ];
}

/**
 * Whether every open pull request of the run is ready to merge: read at its current head, approved there, and with no required check red or running. A run with no open pull request has none to wait for.
 * A pull request the watch has not read, or whose host does not say, is not proven ready. PURE.
 */
export const isReadyToMerge = (entry: ViewEntry): boolean => openPulls(entry).every(({ url }) => clausesOf(entry, url).length === 0);

/**
 * What a run waits on before it can be merged, or null when it waits on nothing: one clause for each thing, per open pull request, in the order review, red checks, checks not passed. With more than one
 * open pull request each is named by its address (`owner/repo #number: ...`), and they are told apart by " · ". PURE.
 */
export function mergeWaitLine(entry: ViewEntry): string | null {
  const open = openPulls(entry);
  const waits = open.flatMap(({ url }) => {
    const clauses = clausesOf(entry, url);
    return clauses.length === 0 ? [] : [open.length === 1 ? clauses.join("; ") : `${pullLabel(url)}: ${clauses.join("; ")}`];
  });
  return waits.length === 0 ? null : waits.join(" · ");
}
