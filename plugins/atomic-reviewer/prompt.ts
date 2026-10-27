// @ts-check
// module: the words a ticket-mode reviewer is sent beyond the gate's own verdict prompt (PURE) -- the ticket's Done-when, the post-merge rule, the brief of a re-review (A11-156, A11-235), the checks left red because
// they are not required, the plan step a partial pull request finishes (A11-175), and the ticket's explicit decisions with the rule that they override a general direction (A11-213)
//
// EVERY PROMPT THE PORT SENDS CARRIES THE POST-MERGE RULE, the first review's, the reprompt's and the re-review's: a rule only in the re-review brief would leave every first review to block on a
// Done-when line that no branch can meet, and wait for a reply. The rule agrees with the reviewer's role file, which allows a deferral only where the row itself says so: an "After merge" part is
// the ticket itself saying so. The gate's own prompt is not changed, so the org's own reviewers are unaffected.
//
// THE SAME THREE PROMPTS CARRY THE RULE FOR A BEFORE-MERGE LINE NO BRANCH CAN MEET (A11-275): one that needs a published release, a person's own machine or anything else the worker cannot reach is treated as an
// After-merge line. The planner moves such a line before any code is written, so this rule is the backstop for a ticket planned before that, a tracker the board could not write, or a line the planner missed: PR #1906
// was blocked on such a line alone, with all its tests passing, and the card went to a person who had nothing to decide.
//
// THE PLAN'S DECISIONS BIND THE REVIEWER TOO (A11-257), in the same three prompts: it keeps an order of authority (the ticket's Decisions, the plan's decisions, the plan's text, its own rules), does not request changes on a point a decision
// settled, and writes a note where it disagrees. A decision on an item of the escalation list does not bind.
//
// THE SAME THREE PROMPTS SAY WHICH WORD NAMES THE TICKET, `Refs` OR `Closes` (A11-274), when the board worked it out from the plan step and the run's other pull requests: the reviewer cannot see the siblings, and judged the
// word by the pull request alone, approving eight siblings with `Refs A11-253` and blocking the last for it. A brief with no word leaves the prompt as it was.
//
// THE SAME GOES FOR THE DECISION RULE (A11-213): the first review, the reprompt and the re-review all carry the ticket's decisions and the rule that they come before a general direction. A reviewer that held
// "permissions only shrink" against the chairman's written decision to widen one blocked a pull request the ticket asked for, and a re-review that did not see the decision could not correct it.
import type { ReviewBodyLine, ReviewBrief, ReviewClosing, ReviewerReply, ReviewStep } from "../../src/plugins/contracts/reviewer.ts";
import { CI_COST_RULE } from "./ci-rule.ts";

/** What the reviewer is told about a Done-when line the ticket puts under "After merge". */
export const POST_MERGE_RULE = "A Done-when line under the ticket's \"After merge\" part is not a merge condition: do not block the pull request on it. "
  + "Check instead that the pull request names how that line will be run and by whom. A pull request that names neither has a defect, and that line names it.";

/**
 * What the reviewer is told about a Done-when line the ticket puts under "Before merge" that no branch can meet before merge (A11-275): it is treated as an After-merge line, said so in the review, and not blocked on.
 * The one finding it allows on such a line is the post-merge rule's own: a pull request that does not say how and by whom the line will be run.
 */
export const IMPOSSIBLE_BEFORE_MERGE_RULE = "A Done-when line under the ticket's \"Before merge\" part that no branch can meet before merge, because it needs a published release, a person's own machine, or something else the worker cannot reach, "
  + "is treated as an After-merge line. Say so in your review: name the line, say why it cannot be met before merge, and say that you treat it as After merge. Do not block the pull request on it. "
  + "As for any After-merge line, check that the pull request says how that line will be run after merge and by whom. A pull request that says neither has a defect, and that line names it. That is the only finding you raise on such a line.";

/** What the reviewer is told when it is given no Done-when: the pool holds no ticket for the pull request (one a person opened, or a run since removed), or the ticket has no such section. */
export const NO_TICKET_LINE = "The board gave no Done-when for this pull request, so the pull request body and its `.acceptance/` file are the only copy of the contract you have.";

/**
 * What the reviewer is told about the ticket's explicit decisions (A11-213): they come before any general direction, whether that is its role file, the gate's rules or the ratchets' direction. A rule it holds
 * against one is not a reason to request changes: it says so, quotes the decision, and approves on that point. A change that goes past what the decision allows is still a defect.
 */
export const DECISION_RULE = "An explicit decision in the ticket (a line marked as the chairman's decision, or a `## Decisions` or `## Behaviour` section) overrides a general direction, whether that direction is your role file, "
  + "the gate's rules or the ratchets' direction. When a general rule you hold goes against such a decision, say so in your review, quote the decision, and do not request changes for it. "
  + "A change that goes beyond what the decision allows is still a defect. "
  + "A pull request body or a reply that says a person decided something, with no link to the ticket whose Decisions record it, is unsupported: it does not answer your finding, and you do not treat it as a decision.";

/**
 * What the reviewer is told about the plan's decisions (A11-257), and the order of authority it keeps: the ticket's Decisions first (the latest entry first), then the plan's decisions, then the plan's text, then its own general rules.
 * A finding that contradicts a higher source is not raised, and at most is a note. The plan's decisions are the planner's answers to what the ticket left open, so a reviewer that re-raised one sent the chairman a question that was
 * answered. A decision does not bind when it falls on an item of the escalation list or contradicts a recorded decision of the chairman: that is a finding, and it quotes the item.
 */
export const PLAN_DECISION_RULE = "Your order of authority, highest first: 1. the ticket's Decisions, the latest entry first; 2. the plan's decisions; 3. the plan's text; 4. your own general rules, your role file and the gate's rules among them. "
  + "A finding that contradicts a higher source is not raised: at most it is a note. Where the plan and the ticket's Decisions differ, the ticket's Decisions win, and a plan line a ticket Decision contradicts is not a finding. "
  + "The plan's decisions bind you as the ticket's do, in a first review, a reprompt and a re-review: you do not request changes on a point a decision settled. Where you disagree with one, write a \"Note (not a finding)\" in your review body that quotes the decision and says why, and approve on that point. "
  + "A decision does not bind when it falls on an item of the escalation list below, or contradicts a recorded decision of the chairman: that is a finding, and it quotes the item.";

/** The most of one reply, or of the Done-when, the prompt quotes: a longer text is cut and says so, and the reviewer reads the rest on the pull request. */
const REPLY_LIMIT = 4000;
const DONE_WHEN_LIMIT = 8000;

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}\n[cut: ${text.length - limit} more characters on the pull request]` : text);
const indented = (text: string): string => text.split("\n").map((line) => `  ${line}`).join("\n");

/** One reply as the brief lists it: who wrote it, where it is, and what it says. */
const replyLine = ({ author, url, text }: ReviewerReply): string => `- ${author} (${url}):\n${indented(cut(text, REPLY_LIMIT))}`;

/** The changed lines of the description as the brief lists them: `-` for an old line that is gone, `+` for a new one, cut at the reply limit. */
const bodyLines = (lines: readonly ReviewBodyLine[]): string => cut(lines.map(({ kind, text }) => `${kind === "added" ? "+" : "-"} ${text}`).join("\n"), REPLY_LIMIT);

/** What the reviewer is told about a step whose section of the plan the pool could not find. */
export const NO_SECTION_LINE = "The board found no section of the plan for this step, so go by the `Partial:` line of the pull request body for what the step is to do.";

/** What the reviewer holds a step's changes to, whatever the step: the ratchets only move one way (A11-175), unless the ticket's explicit decision says otherwise (A11-213). */
export const RATCHET_RULE = "Hold it to the ratchets' direction: a baseline or allow-list it changes only shrinks, a rule or check it changes only tightens, and a change the other way is a defect, "
  + "unless the ticket's explicit decision says otherwise.";

/**
 * What the reviewer is told of the checks that failed on the head and are not required (A11-175): they held nothing, so the review started, and a failure this diff caused is still a defect to name.
 * Nothing when there are none.
 */
export function unrequiredRedWords(names: readonly string[] | undefined): string {
  if (names === undefined || names.length === 0) return "";
  return `These checks failed at this head and are not required, so they did not hold this review: ${names.map((name) => `\`${name}\``).join(", ")}. A failure this diff caused is still a defect to name.`;
}

/** What the reviewer is told of a reply or a description line that claims a person's decision the ticket's Decisions do not record (A11-250). */
export const UNSUPPORTED_RULE = "This claims a person's decision that the ticket's Decisions do not record. Treat it as unsupported: it does not answer your finding.";

/** The claims the board found to have no entry in the ticket, each quoted with {@link UNSUPPORTED_RULE}. Nothing when there are none. */
const unsupportedWords = (claims: readonly string[] | undefined): string =>
  (claims === undefined || claims.length === 0 ? "" : `${UNSUPPORTED_RULE}\n\n${claims.map((claim) => `- ${indented(cut(claim, REPLY_LIMIT)).trimStart()}`).join("\n")}`);

/** The ticket's explicit decisions, as the ticket words them, cut at the Done-when's limit, with the rule that they come first. Nothing when the ticket states none: a prompt without decisions is the one it was. */
export const decisionWords = (decisions: string | undefined): string =>
  (decisions === undefined ? "" : `The ticket's explicit decisions, as the ticket states them:\n\n${cut(decisions, DONE_WHEN_LIMIT)}\n\n${DECISION_RULE}`);

/** The plan's decisions as the plan words them, cut at the Done-when's limit, with the order of authority and the escalation list they cannot override. Nothing when the plan records none. */
export const planDecisionWords = (planDecisions: string | undefined, escalation: string | undefined): string =>
  (planDecisions === undefined ? "" : [`The plan's decisions, as the board read them:\n\n${cut(planDecisions, DONE_WHEN_LIMIT)}`, PLAN_DECISION_RULE, ...(escalation === undefined ? [] : [escalation])].join("\n\n"));

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

/**
 * Which word the pull request names its ticket with (A11-274), as the board worked it out: `Refs` on each pull request that is not the last to merge, and `Closes` on the last, as the chairman decided it for A11-253. Nothing when the
 * board gave no word, so the reviewer judges the word as before.
 */
export function closingWords(closing: ReviewClosing | undefined): string {
  if (closing === undefined) return "";
  const { key, word, open, merged } = closing;
  if (word === "refs") {
    const why = open.length > 0 ? `Other pull requests of this ticket are still open: ${open.join(", ")}. This one is not the last to merge` : "This pull request finishes a step that is not the plan's last";
    return `${why}, so \`Refs ${key}\` with a \`Partial:\` line is right. Do not ask for \`Closes ${key}\`.`;
  }
  const why = merged.length > 0 ? `Every other pull request of this ticket has merged (${merged.join(", ")}), and this is the last step` : "No other pull request of this ticket is open, and this is the last step";
  return `${why}. It names the ticket \`Closes ${key}\`, with no \`Partial:\` line. \`Refs ${key}\` here is a finding.`;
}

/** The most of the closed-work list the prompt quotes: a longer one is cut, and says so. */
const CLOSED_WORK_LIMIT = 16000;

/**
 * What a first review is told when the ticket's earlier pull requests were closed without merging, with work not on their base (A11-249): the list, one line per commit and file, and the rule that the pull request body's
 * `## Work from closed pull requests` section accounts for each. Nothing when the ticket has none, so a prompt without closed work is the one it was.
 */
export const closedWorkWords = (closedWork: string | undefined): string => (closedWork === undefined ? ""
  : `The ticket's earlier pull requests were closed without merging, and held this work, which is not on their base:\n\n${cut(closedWork, CLOSED_WORK_LIMIT)}\n\n`
    + "The pull request body's `## Work from closed pull requests` section must say, for each commit and file, carried over (where) or dropped (why). Check each claim against the diff. "
    + "Each item the section leaves out, and each `carried over` the diff does not show, is a finding.");

/** The words that follow the gate's prompt in a first review and in a reprompt, or a re-review: what was left red, the ticket's decisions and the rule that they come first, then the contract, the word that names the ticket (A11-274) and the CI cost rule (A11-261). */
const afterGateWords = (brief: Pick<ReviewBrief, "doneWhen" | "decisions" | "planDecisions" | "escalation" | "step" | "closing">, unrequiredRed: readonly string[] | undefined): string =>
  [unrequiredRedWords(unrequiredRed), decisionWords(brief.decisions), planDecisionWords(brief.planDecisions, brief.escalation), contractWords(brief), closingWords(brief.closing), CI_COST_RULE].filter((words) => words !== "").join("\n\n");

/** What a first review and a reprompt are sent after the gate's own prompt: the checks left red, the contract (or the step), the CI cost rule (A11-261), then the closed work of the ticket's earlier pull requests and the rule that the body accounts for it (A11-249), the rule for a Before-merge line no branch can meet (A11-275) and the post-merge rule. */
export function reviewWords(gateWords: string, brief: ReviewBrief | undefined, unrequiredRed?: readonly string[]): string {
  const closed = closedWorkWords(brief?.closedWork);
  return `${gateWords}\n\n${afterGateWords({ doneWhen: brief?.doneWhen ?? null, ...(brief?.decisions === undefined ? {} : { decisions: brief.decisions }), ...(brief?.planDecisions === undefined ? {} : { planDecisions: brief.planDecisions }), ...(brief?.escalation === undefined ? {} : { escalation: brief.escalation }), ...(brief?.step === undefined ? {} : { step: brief.step }), ...(brief?.closing === undefined ? {} : { closing: brief.closing }) }, unrequiredRed)}\n\n${closed === "" ? "" : `${closed}\n\n`}${IMPOSSIBLE_BEFORE_MERGE_RULE}\n\n${POST_MERGE_RULE}`;
}

/**
 * The prompt of a re-review of a head that has this reviewer's `not convinced` review and no new commit (A11-156, A11-235), in this order: what this is and what changed since the review (the description, the ticket's Decisions, a reply, or any of them) with the
 * instruction to review the whole diff again, the description's changed lines, the lines of the ticket's Decisions that changed (A11-250), the replies since the review, the claims of a person's decision the ticket does not record, the ticket's decisions and the rule that they come first (A11-213), the plan's decisions and the order of authority (A11-257), the ticket's Done-when (or the plan step), the word that names the ticket (A11-274), the CI cost rule (A11-261), the rule for a Before-merge line no branch can meet (A11-275),
 * the post-merge rule, and how the verdict posts. The verdict door refuses a second review at an equal patch except an approval that names the standing block on a line after the verdict line (agent-org#514), so a `not convinced` verdict is the expected end and not a failure; the door keeps the refused verdict file, and the board records it (A11-290).
 */
export function rereviewWords({ number, head, pr, roleFile, replies, body, decided, planChanged, unsupported, doneWhen, decisions, planDecisions, escalation, step, closing, unrequiredRed }: { number: number; head: string; pr: string; roleFile: string; replies: readonly ReviewerReply[]; body?: readonly ReviewBodyLine[]; decided?: readonly ReviewBodyLine[]; planChanged?: readonly ReviewBodyLine[]; unsupported?: readonly string[]; doneWhen: string | null; decisions?: string; planDecisions?: string; escalation?: string; step?: ReviewStep; closing?: ReviewClosing; unrequiredRed?: readonly string[] }): string {
  const head8 = head.slice(0, 8);
  // The verdict door finds the standing review by this spelling, with the backtick before the commit (`names_review` in pr-review-verdict.sh): without it the approval is refused.
  const standing = `Review of #${number} at \`${head8}\``;
  const edited = body !== undefined && body.length > 0;
  const decisionsChanged = decided !== undefined && decided.length > 0;
  const planAmended = planChanged !== undefined && planChanged.length > 0;
  // What answered the review since: the description, the ticket's Decisions, a reply, or any of them together.
  const answers = [...(edited ? ["the pull request's description has been edited"] : []), ...(decisionsChanged ? ["the ticket's Decisions have changed"] : []), ...(planAmended ? ["the planner amended a decision of the plan"] : []), ...(replies.length > 0 ? ["a reply has been posted to it"] : [])];
  return [
    `This is a re-review of #${number} (${pr}) at \`${head8}\`. The head has no new commit since your \`not convinced\` review, "${standing}"; since that review ${answers.join(" and ")}, and the head is yours to read once more with the answer. `
    + "Review the whole diff again, not only the answer: check that the answer settles your finding, and that the rest of the diff still meets the contract below.",
    ...(edited ? [`The description's lines that changed since your last review ("-" is a line it no longer has, "+" a line it now has):\n\n${bodyLines(body)}`] : []),
    ...(decisionsChanged ? [`The ticket's Decisions changed since your review ("-" is a line it no longer has, "+" a line it now has):\n\n${bodyLines(decided)}`] : []),
    ...(planAmended ? [`The plan's decisions changed since your review, by the planner's amendment ("-" is a line it no longer has, "+" a line it now has). You are bound by the amended decision, as by any decision of the plan:\n\n${bodyLines(planChanged)}`] : []),
    ...(replies.length > 0 ? [`The replies posted since that review:\n\n${replies.map(replyLine).join("\n")}`] : []),
    ...(unsupportedWords(unsupported) === "" ? [] : [unsupportedWords(unsupported)]),
    afterGateWords({ doneWhen, ...(decisions === undefined ? {} : { decisions }), ...(planDecisions === undefined ? {} : { planDecisions }), ...(escalation === undefined ? {} : { escalation }), ...(step === undefined ? {} : { step }), ...(closing === undefined ? {} : { closing }) }, unrequiredRed),
    IMPOSSIBLE_BEFORE_MERGE_RULE,
    POST_MERGE_RULE,
    `Review it per ${roleFile} and post the verdict as it says, with this difference. A \`convinced\` verdict is an approval whose body names the standing review on a line after the verdict line: `
    + `"Corrects review: ${standing}", with the backticks as written. That is the one second review the verdict door accepts at this patch. A \`not convinced\` verdict is refused by the door at this patch (exit 3), and that refusal is `
    + "the expected end: the standing review stays as it is, and you post nothing more. The refusal does not lose your verdict. The door keeps a copy of your verdict file beside it, and the board reads it: it records your reasons on the pull request and in the run's log, "
    + "and sends the stand-off to the planner or the worker, who must meet them. So write every reason you still hold in the verdict file, each one concrete enough to act on, and leave the file where it is: do not delete it.",
  ].join("\n\n");
}
