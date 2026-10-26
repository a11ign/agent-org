// @ts-check
// module: the words of a stand-off (A11-290) -- the comment that records a refused re-review on its pull request, and the text of the round that settles it -- PURE
//
// THE COMMENT OPENS `rereview:` AND NEVER AS A VERDICT. The gate reads a comment as a verdict only when it opens `Review of` or `Re-read of` (`review-verdict.ts`, `CONVENTION_OPENER`), so this one is read as none, and it is posted by the board's
// own account, which is the account whose replies start a re-review: {@link isRereviewComment} is how a reply reader leaves it out.
import type { Standoff } from "./queue/standoff-types.ts";

/** How a comment that records a refused re-review starts. */
export const REREVIEW_OPENER = "rereview:";

/** Whether a reply is the board's own record of a refused re-review, which answers nothing and starts no re-review. */
export const isRereviewComment = (text: string): boolean => text.trimStart().toLowerCase().startsWith(REREVIEW_OPENER);

const quoted = (text: string): string => text.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");

/** The comment recorded on the pull request for a re-review the verdict door refused at `head`: the word first, then the re-reviewer's verdict and reasons as it wrote them. */
export function rereviewComment(head: string, verdict: "convinced" | "not-convinced", reasons: string): string {
  const word = verdict === "not-convinced" ? "still not convinced" : "convinced, but the verdict door refused it";
  return `${REREVIEW_OPENER} ${word} at \`${head.slice(0, 8)}\`\n\nThe re-review of this head ended, and the verdict door refused a second review at an equal patch, so the standing review stays as it is. `
    + `The re-reviewer's verdict and reasons, as it wrote them:\n\n${quoted(reasons)}`;
}

/** The text a stand-off's round carries in common: the review the worker answered, what it replied, and the re-review that stayed not convinced. */
function accountOf({ url, head, review, reply, reasons, decisions }: Standoff): string {
  return [
    `The reviewer re-reviewed ${url} at \`${head.slice(0, 8)}\` after the worker answered its block with no commit, and is still not convinced. The head has not changed, so the verdict door did not post a second review: it recorded the result.`,
    review === null ? "The review it answered: read it on the pull request." : `The review it answered:\n\n${quoted(review)}`,
    reply === null ? "The worker's reply: none was read; read the conversation on the pull request." : `The worker's reply:\n\n${quoted(reply)}`,
    `The re-review, as the re-reviewer wrote it:\n\n${quoted(reasons)}`,
    ...(decisions === null ? [] : [`The ticket's Decisions changed before this re-review, which had them in its prompt, and it still stayed not convinced. The changed Decision, as the ticket words it:\n\n${quoted(decisions)}`]),
  ].join("\n\n");
}

/** What the planner's round is told: the account, and that the decision is its to settle. */
export const standoffPlannerFeedback = (standoff: Standoff): string => (standoff.decisions === null
  ? `${accountOf(standoff)}\n\nThe worker's reply disputes a decision of the plan or the ticket, which only you can change.`
  : `${accountOf(standoff)}\n\nThe ticket's Decisions bind the reviewer and the plan, and a person made them: you cannot change one. Decide whether the re-reviewer's reasons deny or contradict the changed Decision. If they do, uphold it and quote the Decision in your reason, so the worker answers the pull request with it.`);

/** What the worker's round is told: the account, what the planner decided when it did, and what it must do. */
export function standoffWorkerFeedback(standoff: Standoff): string {
  const planner = standoff.planner === undefined ? ""
    : `\n\nThe planner decided this stand-off: it ${standoff.planner.decision} the decision. Its reason:\n\n${quoted(standoff.planner.reason)}`;
  return `${accountOf(standoff)}${planner}\n\nYou must meet the re-reviewer's reasons: change the code, or the measurement or the evidence they name, so that this head changes. A second reply with no change at this head is refused by the Stop hook `
    + "unless you stop with a `needs-human` outcome that names an item of the escalation list.";
}
