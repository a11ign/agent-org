// @ts-check
// module: whether a pull request answers the question a `needs-human` run asked (PURE)
//
// A RUN THAT ENDED `needs-human` STAYS ON ITS PULL REQUEST, WHERE ITS QUESTION IS ANSWERED (A11-153). The pool records the head each open pull request was at
// when the run ended (`outcomeHeads`) and the head it is at now, with whether a reviewer approved it there (`pullHeads`); this reads the two.
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";

/** How a pull request answers a `needs-human` run's question: a reviewer approved it at its head, or its head moved on from the one the run ended at. */
export type PullAnswer = "approved" | "answered";

/**
 * Whether the pull requests of a finished `needs-human` run answer its question (A11-153), from the heads the pool read: `approved` when every open pull
 * request is approved at its current head, otherwise `answered` when any open pull request's head is not the one the run ended at, and null otherwise. The
 * heads are compared, not commit dates: agent-org's own merge of a blocker's branch moves the outcome head with it, and is no answer. A run whose outcome
 * file could not be read (`unreadable`) is about that file, which a push to a pull request does not answer, and a run with no open pull request has
 * nothing to read. A pull request whose head or outcome head is not read yet answers nothing. PURE.
 */
export function pullAnswer(entry: ViewEntry): PullAnswer | null {
  if (entry.phase !== "finished" || entry.outcome?.kind !== "needs-human" || entry.outcome.unreadable === true) return null;
  const open = openPulls(entry);
  if (open.length === 0) return null;
  if (open.every(({ url }) => entry.pullHeads?.[url]?.approved === true)) return "approved";
  const moved = open.some(({ url }) => {
    const now = entry.pullHeads?.[url]?.head;
    const then = entry.outcomeHeads?.[url];
    return now !== undefined && then !== undefined && now !== then;
  });
  return moved ? "answered" : null;
}
