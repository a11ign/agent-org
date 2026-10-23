// @ts-check
// module: the words a ticket-mode reviewer is sent beyond the gate's own verdict prompt (PURE) -- the ticket's Done-when, the post-merge rule, the brief of a re-review (A11-156), the checks left red because
// they are not required, and the plan step a partial pull request finishes (A11-175)
//
// EVERY PROMPT THE PORT SENDS CARRIES THE POST-MERGE RULE, the first review's, the reprompt's and the re-review's: a rule only in the re-review brief would leave every first review to block on a
// Done-when line that no branch can meet, and wait for a reply. The rule agrees with the reviewer's role file, which allows a deferral only where the row itself says so: an "After merge" part is
// the ticket itself saying so. The gate's own prompt is not changed, so the org's own reviewers are unaffected.
import type { ReviewBrief, ReviewerReply, ReviewStep } from "../../src/plugins/contracts/reviewer.ts";

/** What the reviewer is told about a Done-when line the ticket puts under "After merge". */
export const POST_MERGE_RULE = "A Done-when line under the ticket's \"After merge\" part is not a merge condition: do not block the pull request on it. "
  + "Check instead that the pull request names how that line will be run and by whom. A pull request that names neither has a defect, and that line names it.";

/** What the reviewer is told when it is given no Done-when: the pool holds no ticket for the pull request (one a person opened, or a run since removed), or the ticket has no such section. */
export const NO_TICKET_LINE = "The board gave no Done-when for this pull request, so the pull request body and its `.acceptance/` file are the only copy of the contract you have.";

/** The most of one reply, or of the Done-when, the prompt quotes: a longer text is cut and says so, and the reviewer reads the rest on the pull request. */
const REPLY_LIMIT = 4000;
const DONE_WHEN_LIMIT = 8000;

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}\n[cut: ${text.length - limit} more characters on the pull request]` : text);
const indented = (text: string): string => text.split("\n").map((line) => `  ${line}`).join("\n");

/** One reply as the brief lists it: who wrote it, where it is, and what it says. */
const replyLine = ({ author, url, text }: ReviewerReply): string => `- ${author} (${url}):\n${indented(cut(text, REPLY_LIMIT))}`;

/** What the reviewer is told about a step whose section of the plan the pool could not find. */
export const NO_SECTION_LINE = "The board found no section of the plan for this step, so go by the `Partial:` line of the pull request body for what the step is to do.";

/** What the reviewer holds a step's changes to, whatever the step: the ratchets only move one way (A11-175). */
export const RATCHET_RULE = "Hold it to the ratchets' direction: a baseline or allow-list it changes only shrinks, a rule or check it changes only tightens, and a change the other way is a defect.";

/**
 * What the reviewer is told of the checks that failed on the head and are not required (A11-175): they held nothing, so the review started, and a failure this diff caused is still a defect to name.
 * Nothing when there are none.
 */
export function unrequiredRedWords(names: readonly string[] | undefined): string {
  if (names === undefined || names.length === 0) return "";
  return `These checks failed at this head and are not required, so they did not hold this review: ${names.map((name) => `\`${name}\``).join(", ")}. A failure this diff caused is still a defect to name.`;
}

/** The step a partial pull request finishes (A11-175): which step it is, its section of the plan or the line that says there is none, and the ratchets' direction. */
const stepWords = ({ step, of, section }: ReviewStep): string => [
  `This pull request is step ${step} of ${of} of its ticket's plan. Review it against that step and not against the whole ticket.`,
  section === null ? NO_SECTION_LINE : `The plan's section for step ${step}:\n\n${cut(section, DONE_WHEN_LIMIT)}`,
  RATCHET_RULE,
].join("\n\n");

/**
 * The contract the reviewer holds the pull request to: the ticket's Done-when when the pool has it, else the line that says there is none. For a step of a plan (A11-175) the step comes first, and the
 * Done-when is headed as the last step's: the ticket's whole-ticket lines are met by step `of` of `of`, so this step is not blocked on one, unless the step makes it harder to meet.
 */
function contractWords({ doneWhen, step }: Pick<ReviewBrief, "doneWhen" | "step">): string {
  if (step === undefined) return doneWhen === null ? NO_TICKET_LINE : `The ticket's Done-when, as the ticket states it:\n\n${cut(doneWhen, DONE_WHEN_LIMIT)}`;
  const forLast = doneWhen === null ? NO_TICKET_LINE
    : `The ticket's Done-when, for the last step (step ${step.of} of ${step.of}), as the ticket states it:\n\n${cut(doneWhen, DONE_WHEN_LIMIT)}\n\n`
      + "Do not block this step on a whole-ticket line that only the last step can meet, unless this step makes that line harder to meet.";
  return `${stepWords(step)}\n\n${forLast}`;
}

/** The words that follow the gate's prompt in a first review and in a reprompt, or a re-review: what was left red, then the contract. */
const afterGateWords = (brief: Pick<ReviewBrief, "doneWhen" | "step">, unrequiredRed: readonly string[] | undefined): string =>
  [unrequiredRedWords(unrequiredRed), contractWords(brief)].filter((words) => words !== "").join("\n\n");

/** What a first review and a reprompt are sent after the gate's own prompt: the checks left red, the contract (or the step), then the post-merge rule. */
export function reviewWords(gateWords: string, brief: ReviewBrief | undefined, unrequiredRed?: readonly string[]): string {
  return `${gateWords}\n\n${afterGateWords({ doneWhen: brief?.doneWhen ?? null, ...(brief?.step === undefined ? {} : { step: brief.step }) }, unrequiredRed)}\n\n${POST_MERGE_RULE}`;
}

/**
 * The prompt of a re-review of a head that has this reviewer's `not convinced` review and no new commit (A11-156), in this order: what this is, the replies since the review, the ticket's
 * Done-when (or the plan step), the post-merge rule, and how the verdict posts. The verdict door refuses a second review at an equal patch except an approval that names the standing block on a line after the
 * verdict line (agent-org#514), so a `not convinced` verdict is the expected end and not a failure.
 */
export function rereviewWords({ number, head, pr, roleFile, replies, doneWhen, step, unrequiredRed }: { number: number; head: string; pr: string; roleFile: string; replies: readonly ReviewerReply[]; doneWhen: string | null; step?: ReviewStep; unrequiredRed?: readonly string[] }): string {
  const head8 = head.slice(0, 8);
  // The verdict door finds the standing review by this spelling, with the backtick before the commit (`names_review` in pr-review-verdict.sh): without it the approval is refused.
  const standing = `Review of #${number} at \`${head8}\``;
  return [
    `This is a re-review of #${number} (${pr}) at \`${head8}\`. The head has no new commit since your \`not convinced\` review, "${standing}"; a reply has been posted to it since, and the head is yours to read once more with the reply.`,
    `The replies posted since that review:\n\n${replies.map(replyLine).join("\n")}`,
    afterGateWords({ doneWhen, ...(step === undefined ? {} : { step }) }, unrequiredRed),
    POST_MERGE_RULE,
    `Review it per ${roleFile} and post the verdict as it says, with this difference. A \`convinced\` verdict is an approval whose body names the standing review on a line after the verdict line: `
    + `"Corrects review: ${standing}", with the backticks as written. That is the one second review the verdict door accepts at this patch. A \`not convinced\` verdict is refused by the door at this patch (exit 3), and that refusal is `
    + "the expected end: the standing review stays as it is, and you post nothing more.",
  ].join("\n\n");
}
