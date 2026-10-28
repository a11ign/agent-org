// A leaf of ticket mode, run by no command: what is wrong with a pull request an idle worker waits on or opened, and the one line the board tells it (A11-358). PURE.
//
// A WORKER THAT WROTE `working` AND WAITS FOR A PULL REQUEST TO MERGE waits for what cannot come while that pull request has a review asking for changes, a red required check or a conflict: the wait only ends at its `until`. The board reads
// these pull requests as it reads the run's own, and tells the worker at once. A head with the same trouble is told once (`sig`), and a new head or another kind of trouble is told again.
import type { PullFeedback } from "../../plugins/contracts/code-host.ts";
import { pullLabel } from "../board-view/pull-label.ts";

/** What is wrong with one pull request: `sig` names the head and the kinds, so the same trouble is told once; `changes` is whether a review asks for changes at the head (the kind an hour of waiting turns into Needs you); `line` is the words. */
export type PullTrouble = Readonly<{ sig: string; changes: boolean; line: string }>;

/** How long a review asking for changes may stand on a pull request an idle worker waits on before the run reads Needs you, in minutes. */
export const WAITED_BLOCK_MINUTES = 60;

/** What the newest review on the head says, as the host gave it: its own verdict at the head, else GitHub's decision when the host says no verdict at all. PURE. */
const asksForChanges = (read: PullFeedback): boolean => (read.verdictAtHead === undefined ? read.reviewDecision === "changes-requested" : read.verdictAtHead === "changes-requested");

/**
 * The trouble an open pull request has now, or null for one that is clear, merged or closed (a merge or a close is the wait's own end, which it is woken for). `reviewIsTheWait` leaves the review out: a wait `until: "reviewed"` ends on that review,
 * and the worker is woken for it by the wait. A red check is a required one (`failing`, which counts every check where none is required), as the board answers a run's own. PURE.
 */
export function troubleOf(url: string, read: PullFeedback, { reviewIsTheWait = false }: Readonly<{ reviewIsTheWait?: boolean }> = {}): PullTrouble | null {
  if (read.state !== "open") return null;
  const changes = !reviewIsTheWait && asksForChanges(read);
  const failing = read.failing;
  const parts = [
    ...(changes ? ["has a review asking for changes on its current head"] : []),
    ...(failing.length > 0 ? [`has failing required checks (${failing.join(", ")})`] : []),
    ...(read.conflicting ? ["conflicts with its base"] : []),
  ];
  if (parts.length === 0) return null;
  const kinds = [changes ? "changes" : "", failing.length > 0 ? `checks:${[...failing].sort().join(",")}` : "", read.conflicting ? "conflict" : ""].filter((kind) => kind !== "");
  return { sig: `${read.head ?? ""}|${kinds.join("|")}`, changes, line: `${pullLabel(url)} ${parts.join(" and ")}` };
}

/** The one line sent to an idle worker for the pull requests that need it. One line, as every prompt of the board is: a new line typed into a pane submits it early. PURE. */
export const troublePrompt = (lines: readonly string[]): string =>
  `A pull request you wait on or opened needs you: ${lines.join("; ")}. Read what it says (gh pr view <url> --comments, gh pr checks <url>), if it is yours, fix it on its branch and push; if it is not, say so. Then write a new working outcome for what you still wait on, or the outcome the run ends on. Waiting for it to merge as it stands waits for nothing.`;
