// @ts-check
// module: what a ticket-mode worker is given -- its brief, and the settings file that holds its rules -- built as pure functions
//
// THE RULES LIVE IN A FILE, NOT ONLY IN FLAGS. herdr restores a session after its own restart as a bare `claude --resume`, which keeps none of the
// flags the pool started it with (`host-units.ts` records the shape). So the permission mode, the model and both hooks are written to the ticket
// folder's `.claude/settings.local.json`, which a resumed session reads again. The flags repeat them for the first start.
//
// THE WORKER CHOOSES THE REPOSITORY AND FINDS ITS COMMANDS. It starts in the ticket's own folder beside the person's repositories, reads the ticket,
// decides where the work lands, and makes a worktree there with `ticket:worktree`. Each repository's `CLAUDE.md`/`AGENTS.md` names how to install,
// test and typecheck it, which is where any engineer looks, so nothing about a repository is declared here or in the host file.
import { join } from "node:path";
import type { StackBase } from "./board-view/pull-status-and-notes.ts";
import type { MergedStep } from "./board-view/plan-steps.ts";
import type { DenyRule } from "./settings.ts";
import type { PullRequest, WriterForm, WriterMode } from "./queue/queue-entries-and-outcomes.ts";
import type { Placement } from "./writer-placement.ts";
import { DEFAULT_KEYWORDS, type Blocker, type Keywords, type Ticket } from "./source.ts";
import { PUBLISHED_FILE } from "../plugins/contracts/publisher.ts";
import type { TrackerWriting } from "../plugins/contracts/tracker.ts";
import { DECISIONS_FILE, MAX_CREATED, PRIORITIES, type Priority } from "./writer.ts";
import { repoOfProject } from "./project-repo.ts";
import { outcomeExamples } from "./outcome.ts";
import { closingWordsOf } from "./ticket-references.ts";
import { ESCALATION_RULE } from "./escalation.ts";
import { DISPUTE_PHRASES } from "./standoff-dispute.ts";
import { MOVE_RULE } from "./after-merge-move.ts";
import { BLOCKED_BY_RULE } from "./plan-blockers.ts";
import { AFTER_MERGE_CHECKS_RULE } from "./after-merge/plan-section.ts";
import { heldText, PUSH_ONCE_RULE } from "./ci-spend/rules.ts";
import { openDecisionOf, sectionsNeeded } from "./open-decisions.ts";
import { claimsText, type HeldClaim } from "./path-claims.ts";
import { PLANNER_TICKET_DECISIONS, RELAY_DECISION, TICKET_DECISIONS } from "./brief-decisions.ts";
import { closedWorkText, type KeptClosedWork } from "./closed-work-account.ts";
import { connectorsText, MISSING_SKILL, quoted, STALLING_COMMANDS } from "./brief-common.ts";
import { diffText, type Finding, findingsText, lostText, type OpenedPull, openedText, readLine, type Replan, replanText } from "./brief-ticket-text.ts";
import type { TicketRead } from "./ticket-read.ts";

/** The file a worker writes last, and the one thing the pool and the stop hook read to know a run has ended. */
export const OUTCOME_FILE = "outcome.json";
/**
 * Beside the outcome file once a person answers a parked run or talks to a finished one: the time (ms) the outcome it parked on was final. The stop
 * hook judges an outcome written at or before it as no outcome, so the worker writes a new one. Nothing is moved (A11-152).
 */
export const STALE_OUTCOME_FILE = "outcome-stale-before";
/**
 * Beside the outcome file while a stop hook reads it: the time (ms) the stop began, written by the hook and removed when it ends. The board does not
 * move the outcome while it is fresh (A11-152).
 */
export const STOP_ACTIVE_FILE = "stop-active";
/** How long a `stop-active` file holds the board off: an older one is a hook that crashed, which the board does not wait for. */
export const STOP_ACTIVE_MS = 60_000;
export const BRIEF_FILE = "brief.md";
/** The stop hook's count of refused stops in a row, beside the outcome file. */
export const STOP_COUNT_FILE = "stop-refusals";
/**
 * Beside a planning run's outcome file: the pull requests its brief listed as needing a line in the plan's `## What the blockers found` section, per ticket (A11-207). The board writes it from the
 * same list as the brief, and the stop hook checks the plan against it before the planner ends. No worker may write it.
 */
export const FINDINGS_GIVEN_FILE = "findings-given.json";
/**
 * Beside a planning run's outcome file: written by the stop hook when it asked the planner, once, to add the lines its plan missed (A11-207). Its presence ends the retry, and the settle step reads it to
 * say on the card that the retry was made. The board removes it when it prepares a run. No worker may write it.
 */
export const FINDINGS_RETRIED_FILE = "findings-retried.json";
/**
 * The time of the `working` outcome the stop hook last let a stop through on, beside the outcome file. A later stop on that same file is a turn
 * its background work woke and that ended without saying how the run stands, so the hook asks for a new outcome.
 */
export const WORKING_STOP_FILE = "working-stop";
/** The host file's `tickets.deny`, copied beside the outcome file, where the PreToolUse hook reads it. */
export const DENY_FILE = "deny.json";
/** The host file's `tickets.connectors`, copied beside the outcome file, where the PreToolUse hook reads it. */
export const CONNECTORS_FILE = "connectors.json";
/** The host's own programs a worker may not write (A11-84), copied beside the outcome file, where the PreToolUse hook reads it. */
export const PROTECTED_FILE = "protected-paths.json";

/** The host's programs a worker may not write, by name in its bin directory: the routing `gh` and the launcher `agent-org`. Their writers are the host's (`host:install`). */
export const PROTECTED_PROGRAMS = ["gh", "agent-org"] as const;
/** The bin directory the installer uses when `host.json` names none. */
export const defaultBinDir = (home: string): string => join(home, ".local", "bin");
/** The paths of the host's protected programs in `binDir`. */
export const protectedPaths = (binDir: string): string[] => PROTECTED_PROGRAMS.map((name) => join(binDir, name));
/**
 * Present beside the outcome file while the run is a REVIEW RUN, one a person started by approving its pull requests. It lets the PreToolUse
 * hook allow `gh pr ready`, which only that person's approval makes the worker's to run.
 */
export const REVIEW_FILE = "review-run";
/** How long a review run waits for a pull request's checks or its review before it hands the run back. */
export const REVIEW_WAIT_MINUTES = 30;
/**
 * Present beside a PUBLISH RUN's outcome file, written by the board: the connector tool names it may call, as `{ "connectors": [...] }`. It lets
 * the PreToolUse hook allow the publisher plugin's skill and those connectors, which only a person's Publish makes a run's to use.
 */
export const PUBLISH_FILE = "publish-run";
/**
 * Present beside the outcome file of a NEW-TICKET run (A11-94), written by the board: it lets the PreToolUse hook allow the read-only connector tools
 * `tickets.connectors` names, and no other connector, since the run may only read the tracker and never create a ticket.
 */
export const WRITER_FILE = "writer-run";
/**
 * Present beside the outcome file of a TALK SESSION (A11-257), written by the board: a person has opened the run's terminal and is in it. The stop hook does not refuse the session's `needs-human` for naming no item of the
 * escalation list, because that outcome only says the agent waits for the person. No worker may write it.
 */
export const TALK_FILE = "talk-run";
/**
 * The tracker tools a new-ticket run may call to file its ticket and attach its plan, which the board grants by name in the writer's mark beside the
 * outcome file (A11-135): the tracker plugin's create tool and attach tools (`TrackerWriting`). Creation only: `hook.ts` refuses any call with an input the plugin
 * names (an `id`, a relation that writes on another ticket) and an attachment to a ticket the run did not create. A build worker is granted none of them.
 */
export const writerTools = ({ createTool, attachTools }: Pick<TrackerWriting, "createTool" | "attachTools">): readonly string[] => Object.freeze([createTool, ...attachTools]);
/**
 * Present beside the outcome file of a grill run that is waiting for the person (A11-129), written by the board: the question its agent asked, as
 * `{ "question": "...", "at": <ms> }`. The stop hook writes it when the agent ends its turn with no outcome, and the board shows it on the run's card.
 */
export const WAITING_FILE = "waiting.json";
/**
 * Where a grill run's outcome file is moved once it is a question, so the board does not read the same outcome again after the person answers
 * (A11-129). Only the board writes it.
 */
export const ASKED_FILE = "asked.json";
/**
 * Present beside the outcome file of a run on a machine with `tickets.drafts: false`, written by the pool before the worker starts. It lets the
 * PreToolUse hook allow `gh pr create` without `--draft`: a worker on such a machine opens its pull request ready for review, and no other run may.
 */
export const READY_FILE = "ready-run";
/**
 * The skill the host file's `tickets.prReview` names, beside the outcome file as a JSON string, where the PreToolUse hook reads it. Absent when the
 * machine names none, and then the hook gates no push or pull request on a review (A11-86).
 */
export const PR_REVIEW_FILE = "pr-review.json";
/**
 * The hook's log of the pre-PR review gate, beside the outcome file: one line per event, `review` when the skill ran and `commit` when a commit
 * was made. A push or a pull request is refused unless its last line is `review`. Only the hook writes it, so no worker may (A11-86).
 */
export const PR_REVIEW_LOG_FILE = "pr-review-log";
/** What a publish run writes beside its outcome file: the messages it posted, as `{ "links": ["<message url>", ...] }`. The publisher contract names it (A11-158). */
export { PUBLISHED_FILE };

/**
 * How a review run waits. A worker that ended its turn to wait was read as a run that stopped: the Stop hook let the third stop through, the
 * agent went idle with no outcome, and the board parked the run mid-review (NBF-1463, 2026-10-16). So it waits in the foreground.
 */
const FOREGROUND_WAIT = `Wait in the foreground, with blocking commands, such as \`gh pr checks <url> --watch --interval 30\`. Keep each Bash call under 10 minutes, and run it again until what you wait for has finished or ${REVIEW_WAIT_MINUTES} minutes have passed. Never end your turn to wait, and never wait with \`run_in_background\` or a background task: the board reads a turn that ends without an outcome file as a run that stopped. The one background wait the brief allows is a Monitor on a process you started detached (with \`nohup\`, \`&\`, \`setsid\` or a unit), since such a process wakes you when it ends only if a Monitor is armed on its PID or its log, such as \`until ! kill -0 <pid>; do sleep 5; done\`: write \`working\` for it only while that Monitor runs, since a bare \`working\` for a detached process is refused.`;

/**
 * What a review round does when no check has started on its head commit (A11-89). GitHub runs no `pull_request` workflow on a pull request that
 * conflicts with its base, so a worker that waited for one parked as "CI never started" and asked a person to re-run CI, which a merge of the base
 * clears and a re-run cannot. It reads the merge state first. The approved round's "needs-human" for a check that has not finished is kept, and
 * this section is the exception to it for checks that did not start.
 */
const CHECKS_NOT_STARTED = `When no check has started on your head commit, run \`gh pr view <url> --json mergeable,mergeStateStatus\` for each pull request first, before you wait longer or do anything else. GitHub runs no \`pull_request\` workflow on a pull request that conflicts with its base, so if it says CONFLICTING or DIRTY, merge the base branch in: \`git fetch\`, then \`git merge origin/<base>\` in its worktree. Never rebase, and never force-push. Resolve each conflict keeping both changes' intent, run the repository's own tests, typecheck and lint, push, and wait for the checks on the new head. Never write \`needs-human\`, and never ask a person to re-run CI, for checks that did not start while the pull request is CONFLICTING or DIRTY. If it says UNKNOWN, GitHub is still computing it: look again in a minute. Write \`needs-human\` for checks that did not start only when the pull request is mergeable and they still have not started after the wait.`;

/**
 * What a planner does with a ticket that is only a parent: an epic whose work is all in the tickets under it is not work for one run, so its plan
 * says so and points the person at the children, rather than planning a run of its own (A11-24, an epic, was handed to a person on 2026-10-17).
 */
const PARENT_ONLY_PLAN = "A ticket that is only a parent, an epic whose work is all in the tickets under it, gets no plan for a run of its own. Its plan says that it is only a parent, names the child tickets that hold its work, and suggests the person queues those children instead of a run on it.";

/**
 * When a worker writes `done`, `checked` and `needs-human` (A11-91). `done` completes the ticket on the board, so it is written only when every Done-when
 * item is verified and the evidence says what was seen. `checked` is for a ticket that is not finished but needs nothing changed: the board leaves it
 * open. `needs-human` puts the run in the board's Needs you and keeps its workspace open for an answer, so a worker that only found nothing to change
 * must not write it.
 */
const DONE_CHECKED_OR_NEEDS_HUMAN = [
  "Write `done` only when no code and no pull request is needed and **every Done-when item of the ticket is verified**: you ran or read what each item asks, and it holds. The `evidence` list has one line per Done-when item: what you ran or read, and what it showed (a command and its result, a link, a file and line). A prediction is not evidence: say what you saw, not what you expect. The board completes the ticket on your `done`. Never write `done` for a ticket with open sub-issues, which complete it, and never after you opened a pull request, whose merge completes the ticket.",
  "Write `checked` when you looked at what the ticket asks and nothing needs to change, but the ticket is **not finished**: a Done-when item is not verifiable by you, or the ticket is only a parent whose work is all in its child tickets (name them, so the person queues them). The ticket stays open. Say in its reason what you checked and what you found.",
  "Write `needs-human` only for an item on the escalation list, with its id in `escalation`: it asks a person for an answer, and the run waits for one. Any other question you decide yourself and list under \"Decisions made without a person\" in the pull request body: it is not a reason to stop.",
].join("\n\n");

/**
 * What a worker does with a choice the ticket and the plan did not settle (A11-257, which replaced A11-134's stop). Nobody answers a worker, and a stop for a choice the plan could have settled reached the chairman for nothing: the worker
 * decides in line with the plan and the ticket's Decisions, and lists the choice in its pull request, unless it falls on the escalation list. A product decision is still what it was: what a person sees or does, what a control is called or does,
 * what happens on an empty or failed state, or a trade-off between two behaviours the ticket names.
 */
const WORKER_DECISIONS = `${ESCALATION_RULE}\n\nA choice the plan and the ticket leave open, a product one or a technical one, is made in line with the plan and the ticket's Decisions, and listed in the pull request body under the heading "Decisions made without a person", as \`Technical:\` or \`Product:\` with its reason, so the reviewer checks it against the code. A product decision is what a person sees or does, what a control is called or does, what happens on an empty or failed state, or a trade-off between two behaviours the ticket names.`;

/**
 * What a planner does with a decision (A11-257, which replaced A11-134's rule that a product decision ends in a `QUESTION.md`). "The planner should have already planned anything out": it settles everything that is not on the escalation
 * list, taking the option it would have recommended, and writes each decision in the plan for the worker and the reviewer, which both treat the plan's decisions as binding. A screen's behaviour is settled the same way, under
 * `**Behaviour:** settled by the planner`; the plan check refuses a screen plan without it (`missingBehaviour`, `open-decisions.ts`).
 */
const PLANNER_DECISIONS = `${ESCALATION_RULE}\n\nYou decide everything that is not on the list yourself, from the boards, the code, the ADRs and the ticket's Decisions, so that a worker finds it settled in the plan and has nothing to ask. Where you would have recommended an option, take it. That covers a product decision, a wording question, an open line in the ticket such as "decide whether ...", and a screen's behaviour: there is no behaviour grill to wait for. A \`QUESTION.md\` is written only for an item on the list, and starts with \`**Escalation:** <id>\`; the plan check refuses one that does not. A decision of the ticket's that your plan cannot follow is the \`contradicts\` item: stop with a \`QUESTION.md\` that starts \`**Escalation:** contradicts\`, rather than a plan with a \`Conflicts:\` bullet. The plan records its decisions in a \`## Key decisions\` section and in its \`## Decisions made without a person\` section, which a worker and a reviewer are bound by. Each bullet of the second starts with \`Technical:\` or \`Product:\` and gives its reason; a \`Product:\` bullet is no defect. When the work changes a screen and the ticket has no \`**Behaviour:** settled\` line, the plan carries the line \`**Behaviour:** settled by the planner\`, followed by each behaviour decision with its reason: what the person sees, what each control does, and what happens on an empty and a failed state. The board refuses the plan of a screen ticket without that line.`;

/**
 * A worker's proposed edit to its ticket's own text (A11-91). The board never changes the ticket on the worker's word: a person applies the edit on the
 * board, and the board refuses it when the ticket has changed since the worker read it.
 */
const PROPOSE_EDIT = "A ticket's own title or description may be what is wrong: it names the wrong thing, or a Done-when item cannot be verified as it is written. Then propose the correction in the same outcome, as `\"edit\"`: a `title`, the whole `description` it should have, or both (a field you leave out stays as it is), and a `why` that says what is wrong with the text and what you found that shows it. The board does not change the ticket: a person applies the edit on the board. Propose an edit only to correct the text, never to narrow what the ticket asks.";


/**
 * The brief's paragraph for a plan with numbered steps (A11-219): the board shows the step the run is on, from the `currentStep` its worker writes in the outcome file as it moves on. A `working` written for it is a
 * progress note, written and carried on from in the same turn, so it says it is the one `working` that is not about background work.
 */
const STEP_NOTES = "The plan has numbered steps, and the board shows which one you are on. As you begin each step, write the outcome file with `{ \"kind\": \"working\", \"reason\": \"<the step you are on>\", \"currentStep\": <N> }` and carry on in the same turn. That is the one `working` that is not about background work: it is only a progress note, and your turn still ends on a real outcome, which may carry `currentStep` too. `currentStep` is a whole number of 1 or more, the number of the plan's step.";

/**
 * When a worker writes `working` rather than `needs-human` (A11-80). A worker that ends its turn while its own background work runs on, a long
 * Ansible run watched by a Monitor say, must still write an outcome, and `needs-human` put the run in Needs you though nothing was asked of
 * anyone. `working` keeps the run In progress, with its reason as the run's note. It is never a way to park a question: that is `needs-human`.
 */
const WORKING_OR_NEEDS_HUMAN = "To wait for a fleet job, a CI run, a pull request or a ticket, declare it: write `{ \"kind\": \"working\", \"reason\": \"...\", \"waitingOn\": [ { \"fleetJob\": \"<id>\" } | { \"ciRun\": \"<owner/repo>#<runId>\" } | { \"pullRequest\": \"<url>\", \"until\": \"merged|reviewed\" } | { \"ticket\": \"<KEY>\", \"until\": \"done\" } ], \"until\": \"<ISO time>\" }` and END YOUR TURN. The board reads each event itself and prompts you once, when all of them have finished or any has failed, saying what happened (a job's state and results path, a run's conclusion), and once more if `until` passes with some still pending; act on that prompt and do not declare the same wait again. A `ticket` wait ends your turn like the others: the board records that ticket as a blocker of yours, closes your run and queues the ticket behind it, and resumes your own session once that ticket is done, so you never hold the wait in your pane and never keep your files while you wait. `until` is optional here too (3 hours after you wrote the file when there is none). Never write a loop, a `sleep`, an `until` or `while` poll or a `pgrep -f` to wait for any of these: a loop that can never end sleeps the run for hours, and the board does the waiting for you. Otherwise, write `working` only while your own background work (a background shell or a Monitor) is genuinely still running and will wake you when it finishes. Say in its reason what is running and what you will do when it ends. Before a long wait, write `{ \"kind\": \"working\", \"reason\": \"...\", \"waitingOn\": \"<what>\", \"until\": \"<ISO time>\" }`: the board shows the run as waiting on background work until `until`, which is a time still ahead when you write it (3 hours after you wrote the file when there is no `until`), and prompts you once when `until` passes, then marks it stalled if you stay idle and write nothing newer, naming what it waited on. The board keeps the run In progress, and marks it stalled if you stay idle too long with no newer outcome and no such wait. When the work wakes you, finish, and write the outcome file again with how the run ended, or with `working` again if more of it is still running. Never write `working` to park a question or to wait on a person: that is `needs-human`. A process you started detached is not background work of yours until a Monitor holds it: it wakes nothing when it ends, so arm a Monitor on its PID or its log (`until ! kill -0 <pid>; do sleep 5; done`) before you write `working`, or wait for it in the foreground. A `working` with no declared events and no shell or Monitor running is refused: nothing will wake you.";

/** The folder in the ticket's own directory that a planning run writes its plan's files in, for the board to attach. */
export const PLAN_DIR = "plan";
/** What a batch planning run leaves in a ticket's folder, in place of its plan, when only a person can settle the plan. */
export const QUESTION_FILE = "QUESTION.md";
/** A batch planning run's order: each ticket's repository, and the tickets of the batch it waits on (`batch-order.ts`). */
export const ORDER_FILE = "order.json";

/** What a planning run may not do, beside the machine's own refusals: it reads the repositories and changes none. */
export const PLANNING_DENY: readonly DenyRule[] = Object.freeze([
  // git's subcommand, after any -C/-c/--option: a word only searched for, as in `git grep add`, is not one.
  { pattern: "\\bgit(?:\\s+-[Cc]\\s+\\S+|\\s+--?[\\w-]+(?:=\\S+)?)*\\s+(?:commit|push|checkout|switch|worktree|add|reset|restore|stash|merge|rebase|cherry-pick|am|apply|rm|mv|clean|tag)\\b",
    reason: "a planning run changes no repository: it reads them, and writes its plan's files and nothing else" },
  { pattern: "\\bgh\\s+pr\\s+(?:create|edit|ready|merge|close|comment|review)\\b", reason: "a planning run opens and changes no pull request: a worker does, once the plan is attached" },
  { pattern: "ticket:worktree", reason: "a planning run makes no worktree: it reads the repositories as they are" },
]);

/** The ticket a worker's ticket is part of, and the paths of its downloaded files. */
export type ParentTicket = Readonly<{ ticket: Ticket; attachments: readonly string[] }>;

/** A ticket's downloaded files as a list, with the order to read them first, or "None.". */
function filesText(attachments: readonly string[]): string {
  if (attachments.length === 0) return "None.";
  return `Read every file here before you start. A plan among them is the agreed approach, so follow it.\n\n${attachments.map((path) => `- \`${path}\``).join("\n")}`;
}

/**
 * The parent's section of the brief, or nothing for a ticket with no parent. Its description is quoted, so its own headings, such as its acceptance
 * criteria for every part, cannot read as the worker's.
 */
function parentText(parent: ParentTicket | null): string {
  if (parent === null) return "";
  const { ticket, attachments } = parent;
  return `
## The parent ticket

${ticket.key}: ${ticket.title}

${ticket.url}

Your ticket is one part of ${ticket.key}, and its description covers every part. Do only your ticket's part, and follow each decision of the parent's that applies to it.

${quoted(ticket.description)}

### Files from ${ticket.key}

${filesText(attachments)}
`;
}

/**
 * The section naming the tickets this one waited on, or nothing for a ticket that waited on none. A blocker's merge can come minutes before the
 * release it feeds, such as a package version, so the worker checks the release is out rather than finding it missing.
 */
function blockersText(blockers: readonly Blocker[], findings: readonly Finding[] = []): string {
  if (blockers.length === 0) return "";
  const pulls = (blocker: Blocker) => Object.entries(blocker.pulls).map(([url, state]) => `${url} (${state})`).join(", ") || "no pull request linked";
  return `
## Tickets that blocked this one

This ticket waited until each of these was done:

${blockers.map((blocker) => `- ${blocker.key}, ${blocker.status}: ${pulls(blocker)}`).join("\n")}

If your work depends on something one of them releases, such as a new package version, check that the release is out before you rely on it, for example with \`gh release list --repo <owner>/<repo>\` or the package registry. A release can follow its merge by some minutes: wait for it rather than fail.
${findings.length === 0 ? "" : `\nWhat their merged pull requests found is saved in these files. Read each: it may change how this ticket is worked.\n\n${findings.map(({ key, number, file }) => `- \`${file}\` (${key}, #${number})`).join("\n")}\n`}`;
}

/** How a stacked run opens its pull request, on a machine that keeps drafts and on one that does not (A11-116). */
const STACK_OPENED_AS_DRAFT = "`gh pr create --draft --base <branch>`";
const STACK_OPENED_READY = "`gh pr create --base <branch>`, ready";

/**
 * The section naming the blockers this run is stacked on, or nothing for a run stacked on none. Each has its branch pushed in the repository where the run's
 * plan puts its work (A11-116), and an open pull request there when it has one: the worker branches from the branch, and bases its own pull request on it,
 * with or without that one. The branch is the tracker's, which a person may not have used, so the worker checks it.
 */
function stackText(bases: readonly StackBase[], worktreeCommand: string, opening: string): string {
  const [first] = bases;
  if (first === undefined) return "";
  const { repo } = first;
  return `
## Stack on the work you wait for

These tickets block this one and are not merged yet. Each has its branch pushed to \`${repo}\`, where your plan puts this ticket's work:

${bases.map(stackLine).join("\n")}

1. Build on the one your plan says this ticket builds on, or on the last one listed when the plan does not say. Make your worktree from its branch: \`${worktreeCommand} ${repo} --from <branch>\`. Check the branch first: with its pull request, \`gh pr view <its pull request url> --json headRefName\`, and use that one where it differs from the branch above; with none, \`git ls-remote origin <branch>\`.
2. Open your pull request in place of the pull request step below, with its base set to that branch: ${opening}. It is stacked on the branch even when no pull request is under it.
3. When the pull request of the one you build on exists by then, also link it, bottom first: \`gh stack link <its pull request url> <your pull request url>\`. Run no other \`gh stack\` command.
4. Say in your pull request body which branch, and which pull request if there is one, yours is stacked on.
5. The branch you build on may move while you work. Never rebase it, merge it in, or force-push while you work: agent-org merges that branch into yours for you after you stop. If that merge conflicts, a round after that starts with the conflict, and that round merges the branch in by hand. If \`git fetch\` shows that branch rewritten, that is expected: finish your work.
6. Once the pull request yours is stacked on has merged, agent-org retargets yours to the default branch itself. It then merges the default branch into yours. If that conflicts, you get a conflict round that names the pull request that merged: merge the default branch in, keep both changes, re-run the checks and push. Until it retargets, or when that pull request's branch was merged without being deleted, your pull request's base can be a stale branch. That is expected, not a failure: do not retarget, rebase, push or merge to fix it.
7. A stacked step needs no person to merge: once your pull request is approved, its required checks are green and the ones below it have merged, the arm bot merges it with GitHub's stack merge, up to yours and no further, and the board hands it back to the arm bot when needed. Never unstack a stack, since another ticket builds on it: \`gh stack unstack\` is the person's, and the hook refuses it.
`;
}

/** One stacked base as the brief lists it: its pull request when it has one, or its pushed branch when it has none yet (A11-116). PURE. */
const stackLine = ({ key, url, repo, branch }: StackBase): string => (url === null
  ? `- ${key}: its branch \`${branch}\` is pushed in \`${repo}\`; there is no pull request yet`
  : `- ${key}: ${url}, on branch \`${branch}\``);

/**
 * The section naming the plan steps already merged, or nothing for a run that is not a later step (A11-168). The board queued this run when a `Partial` pull request of the
 * ticket merged: its worktree is the earlier step's branch, whose pull request is merged, so the worker brings the default branch into it and opens a NEW pull request.
 */
function stepsText(steps: readonly MergedStep[]): string {
  const last = steps.at(-1);
  if (last === undefined) return "";
  const merged = steps.map(({ step, of, prs, counted }) => `- step ${step} of ${of}: ${prs.join(", ") || "no pull request recorded"}${counted ? " (counted by the board: the Partial line named no step)" : ""}`).join("\n");
  const counting = last.counted
    ? `\nThe Partial line of step ${last.step}'s pull request named no step, so the board counted it as step ${last.step} of ${last.of}. Check the merged pull requests above against the plan before you start, do the first step none of them did, and name it \`step <N> of <M>\` in your \`Partial:\` line.\n`
    : "";
  return `
## Steps already merged

This ticket's plan has numbered steps, one pull request each. The board queued you when the pull request of an earlier step merged. These steps are merged already:

${merged}

This run does step ${last.step + 1} of ${last.of}, and only that step. The worktree \`ticket:worktree\` gives you is the earlier step's branch, whose pull request merged: before you start, bring it up to date with \`git fetch origin && git merge origin/<the repository's default branch>\`, then open a NEW pull request from it for your step. Do not push to the merged pull request.
${counting}`;
}

/** What a worker is told about a plan a planning run wrote, which no person agreed: nothing when a person's plan, or none, is all it has. */
function plannedText({ planned }: { planned: boolean; }): string {
  if (!planned) return "";
  return "Your plan was written by an unattended planning run, not agreed with a person. Put each decision it says it made without a person in your pull request body, under the heading \"Decisions made without a person\", so the reviewer checks each one against the code.\n\n";
}

/** The host file's `tickets.planner.run` with the tickets it plans, comma-separated, and the folder their plans go in filled in. */
const plannerInstruction = (run: string, keys: readonly string[], dir: string): string =>
  run.replaceAll("{keys}", keys.join(", ")).replaceAll("{key}", keys.join(", ")).replaceAll("{dir}", dir);

/** The \`clones\` keys, each quoted, for a brief that asks for one of them by name. */
const cloneNames = (clones: Readonly<Record<string, string>>): string => Object.keys(clones).map((name) => `\`${name}\``).join(", ");

/**
 * What a planner is told of a ticket's repository: its project's, from the address in the project's summary (`project-repo.ts`), which is the default for
 * its `repo` unless the work belongs in another repository. A project naming none leaves the choice to the planner (A11-116). PURE.
 */
const projectRepoLine = (ticket: Ticket, clones: Readonly<Record<string, string>>): string => {
  const repo = repoOfProject(ticket.projectSummary, Object.keys(clones));
  const project = ticket.project === null ? "No project" : `Its project, ${ticket.project},`;
  return repo === null
    ? `${project} names no repository on this machine, so the plan names the one its work lands in.`
    : `${project} names the repository \`${repo}\`: the plan's \`repo\` is \`${repo}\` unless the work belongs in another repository, which the plan names.`;
};

const reposText = (clones: Readonly<Record<string, string>>): string => Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");

/**
 * The feedback line for a pull request that conflicts with its base, as `pool.ts` writes it into a round's feedback. `CONFLICT_LINE` finds it there,
 * so a round whose feedback names a conflict is briefed to merge the base in first.
 */
export const conflictLine = (url: string, base: string | null): string => `${url} conflicts with its base branch ${base ?? "unknown"}.`;

export const CONFLICT_LINE = /conflicts with its base branch/;

/** One conflict sentence, as `conflictLine` writes it: the pull request's address, then its base branch. */
const CONFLICT_SENTENCE = /\S+ conflicts with its base branch \S+\./g;

/** The conflict lines a text names, one per line, or null when it names none. PURE. */
export function conflictsIn(text: string): string | null {
  const found = text.match(CONFLICT_SENTENCE);
  return found === null ? null : found.join("\n");
}


/**
 * The planning run's brief, as markdown: plan the ticket with this machine's planner, change no code, and leave the plan's files in `planDir`
 * for the board to attach. `run` is the host file's `tickets.planner.run`, with the ticket and the folder filled in.
 */
export function planBriefText({ ticket, ticketDir, planDir, attachments, parent = null, clones, run, notes, connectors = [], read, blockers = [], findings = [], closed = [], claims = [], replan }: {
  ticket: Ticket; ticketDir: string; planDir: string; attachments: readonly string[]; parent?: ParentTicket | null;
  clones: Readonly<Record<string, string>>; run: string; notes?: string; connectors?: readonly string[]; read?: TicketRead; blockers?: readonly Blocker[]; findings?: readonly Finding[]; closed?: readonly KeptClosedWork[]; claims?: readonly HeldClaim[]; replan?: Replan;
}): string {
  const repos = reposText(clones);
  const instruction = plannerInstruction(run, [ticket.key], planDir);
  return `# Plan ${ticket.key}: ${ticket.title}

You are an unattended planner. Nobody will answer a question. Plan this ticket, and change no code: make no worktree, commit, push or pull request. A worker implements the plan once the board has attached it to the ticket.

## The ticket

${ticket.url}

${readLine(read)}${ticket.description.trim() || "(no description)"}

${projectRepoLine(ticket, clones)}

## Files from the ticket

${filesText(attachments)}
${parentText(parent)}${findingsText(blockers, findings)}${closedWorkText(closed, "plan")}${replanText(replan)}
## The repositories on this machine

Read them to plan, but never change them, commit in them or change their branches:

${repos}

${claimsSection(claims)}
## What to do

${instruction}

${PARENT_ONLY_PLAN}

${PLANNER_DECISIONS}

${BLOCKED_BY_RULE}

${PLANNER_TICKET_DECISIONS}

${MOVE_RULE}

${AFTER_MERGE_CHECKS_RULE}

${MISSING_SKILL}

${STALLING_COMMANDS}

The plan's files go in \`${planDir}\`, and nowhere else. The board attaches each one to the ticket under its file name. Write only markdown files there, each 1 MB or less: anything else stops the board attaching any of them.

${PATHS_RULE}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
${outcomeExamples(["planned", "needs-human"])}
\`\`\`

Write \`planned\` only when the plan's files are in \`${planDir}\`. A person may answer you here after a \`needs-human\` outcome. If one does, finish the plan with what they said, and write the outcome file again as the last thing you do.
`;
}

/** One ticket of a batch, as its planning brief names it: the ticket, its downloaded files, and the ticket it is part of. */
export type BatchTicket = Readonly<{ ticket: Ticket; attachments: readonly string[]; parent: ParentTicket | null; read?: TicketRead; blockers?: readonly Blocker[]; findings?: readonly Finding[]; closed?: readonly KeptClosedWork[] }>;

/** One ticket's section of a batch's brief. Its description is quoted, as a parent's is, so its headings cannot read as the brief's. */
function batchTicketText({ ticket, attachments, parent, read, blockers = [], findings = [], closed = [] }: BatchTicket, clones: Readonly<Record<string, string>>): string {
  const parentPart = parent === null ? "" : `
### ${ticket.key} is part of ${parent.ticket.key}: ${parent.ticket.title}

${parent.ticket.url}

${quoted(parent.ticket.description)}

#### Files from ${parent.ticket.key}

${filesText(parent.attachments)}
`;
  return `
## ${ticket.key}: ${ticket.title}

${ticket.url}

${readLine(read)}${quoted(ticket.description)}

${projectRepoLine(ticket, clones)}

### Files from ${ticket.key}

${filesText(attachments)}
${parentPart}${findingsText(blockers, findings).replace(/^\n## /, "\n### ")}${closedWorkText(closed, "plan").replace(/^\n## /, "\n### ")}`;
}

/**
 * A batch planning run's brief, as markdown: plan every ticket in `tickets` in one run, change no code, and leave a folder of plan files (or a
 * question) per ticket, and the batch's order, in `planDir`. `runDir` holds the run's outcome file. `run` is the host file's
 * `tickets.planner.run`, with the tickets and the folder filled in.
 */
export function batchPlanBriefText({ tickets, runDir, planDir, clones, run, notes, connectors = [], claims = [] }: {
  tickets: readonly BatchTicket[]; runDir: string; planDir: string; clones: Readonly<Record<string, string>>; run: string; notes?: string; connectors?: readonly string[]; claims?: readonly HeldClaim[];
}): string {
  const keys = tickets.map(({ ticket }) => ticket.key);
  return `# Plan ${keys.length} tickets together: ${keys.join(", ")}

You are an unattended planner. Nobody will answer a question. A person queued these tickets together, so they are likely linked: plan them as one batch, and change no code. Make no worktree, commit, push or pull request. A worker implements each plan once the board has attached it to its ticket.
${tickets.map((member) => batchTicketText(member, clones)).join("")}
## The repositories on this machine

Read them to plan, but never change them, commit in them or change their branches:

${reposText(clones)}

${claimsSection(claims, BATCH_CLAIMS_BULLET)}
## What to do

${plannerInstruction(run, keys, planDir)}

${PARENT_ONLY_PLAN}

${PLANNER_DECISIONS}

${PLANNER_TICKET_DECISIONS}

${MOVE_RULE}

${AFTER_MERGE_CHECKS_RULE}

${MISSING_SKILL}

${STALLING_COMMANDS}

## Where the plans go

Write everything in \`${planDir}\`, and nowhere else:

- \`${planDir}/<KEY>/\` for each ticket above holds that ticket's plan files, or a \`${QUESTION_FILE}\` when its plan needs an item of the escalation list. The board attaches each plan file to its own ticket under its file name. Write only markdown files there, each 1 MB or less: anything else stops the board attaching that ticket's plan. A question about one ticket does not stop the others, so plan the rest. ${PATHS_RULE}
- \`${planDir}/${ORDER_FILE}\` is one object with an entry for each ticket: \`{ "<KEY>": { "repo": "<repository>", "after": ["<KEY>", ...], "wait": "stacked" or "merged" } }\`, where \`wait\` is optional. \`repo\` is the repository the ticket's work lands in, or \`null\` for a ticket with a question. A ticket's \`repo\` is its project's repository, named with it above, unless its work belongs in another repository. It must be exactly one of these names, which are the host file's \`clones\` keys: ${cloneNames(clones)}. A name is not the folder its checkout sits in, so never take a \`repo\` from a path: the board refuses any other name, and hands that ticket to a person. \`after\` names the tickets of this batch whose work it needs first. Name only tickets of this batch, never the ticket itself, and make no cycle. The board records each one in the tracker as blocking the ticket, and its worker starts only once they are done, or, where it stacks on one, on that one's branch.

How \`wait\` says how a ticket waits on each ticket in its \`after\`:

- With no \`wait\`, or \`"stacked"\`, the ticket is stacked. When its work lands in the same repository as its blocker and that blocker's branch is pushed there, the board starts the ticket on that branch, with or without a pull request on it, and its pull request is based on the blocker's branch. Choose this when the code builds on the blocker's diff.
- \`"wait": "merged"\` keeps the ticket Blocked until every ticket in its \`after\` has merged, then starts it on the default branch. Choose this when the work needs the blocker's change live rather than in a diff: fleet state, a deployed or released package, a published artifact, or anything a worker checks on the running system.
- When a plan says "wait until X merges", set \`"wait": "merged"\`, or the board contradicts the plan.
- Order a ticket after another only when it needs that ticket's code, or both must change the same file. Tickets whose paths do not overlap get no \`after\` and run side by side: a shared folder, or the same area of the code, is no reason to order them. The board holds back a run whose paths overlap a run already in progress, so \`after\` is what keeps two tickets that change one file in turn, and a folder two tickets of the batch both claim is sent back once until each claims its own files.
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${runDir}/${OUTCOME_FILE}\` as the last thing you do, after every plan, question and \`${ORDER_FILE}\`, with exactly one of:

\`\`\`json
${outcomeExamples(["planned", "needs-human"])}
\`\`\`

Write \`planned\` once every ticket has its plan files or its \`${QUESTION_FILE}\`. A \`needs-human\` outcome hands every ticket of the batch back to a person, so write it only when no ticket can be planned without an item of the escalation list, and name the item in \`escalation\`. A person may answer you here after a \`needs-human\` outcome, and after a \`planned\` one that leaves a \`${QUESTION_FILE}\`: the board keeps this terminal open for them. If one does, finish the plans with what they said: once a person answers a ticket's question, replace that ticket's \`${QUESTION_FILE}\` with its plan files, and write the outcome file again as the last thing you do.
`;
}

/** The bullet the batch brief adds to its section on the paths other tickets hold: its own tickets are held against each other. */
const BATCH_CLAIMS_BULLET = `- **The tickets of this batch are held against each other the same way:** a folder two of them claim is sent back once, unless \`${ORDER_FILE}\` orders them.\n`;

/**
 * The brief's section on the paths other tickets hold and how to plan beside them (A11-212): the list, printed from the same array the board writes to the run's claims file, and the rules that keep tickets side by side.
 * `extra` is a bullet added after the rules. PURE.
 */
function claimsSection(claims: readonly HeldClaim[], extra = ""): string {
  return `## Paths other tickets hold

Every other ticket queued or running holds these paths. The board holds this ticket back for any file it shares with one of them, so plan it to run beside them:

${claimsText(claims)}

- **Claim the narrowest paths that hold the change:** files, or a folder only this ticket writes into. Never a shared parent such as a repository's whole \`test/\` or \`captures/\`. The board refuses a plan that claims a folder another queued or running ticket writes into, and names the narrower paths to use.
- **Plan around the held paths where the design allows:** per-feature folders, per-feature test data beside its tests, and no edit to a shared registration point that another ticket already prepared. Say in the plan, under \`## Overlaps that remain\`, which held paths it still shares and why.
- **A shared integration point many tickets would edit** (a route table, a registry, a fixtures file) is named in the plan of the ticket that first creates it. That ticket prepares it, with per-feature entries or placeholders, so later tickets do not edit it.
- **Steps:** prefer steps that can be worked side by side over a chain. A step depends on another only when it needs that step's code, never just because they touch the same folder. The board queues a ticket's next step after the last one has merged, so "side by side" is between tickets, and between a step and the tickets beside it: give each step only the paths it needs.
${extra}`;
}

/**
 * What every plan says of the paths its work touches, in its one `## Paths` section: the board's overlap wait reads it (`overlap.ts`), and `pr:open`
 * reads it as the Region its pull request's diff is checked against (A11-125). The board holds back a ticket whose paths overlap a run in progress, so
 * the list must be complete. A plan in numbered steps also lists each step's own paths in its step section, which is all the board holds for a run on that step (A11-175).
 */
const PATHS_RULE = "Each plan file ends with a `## Paths` section listing every file or directory its work will change, one bullet each, as `- \`<repo>:<path>\``: `<repo>` is one of the repository names above, and a path ending in `/` names a directory. That one section is what the board's overlap wait and `pr:open` both read, so list the narrowest paths that hold the work, and no more: each file the work changes, or a folder only this ticket writes into. Do not list `.acceptance/` or `.changeset/`: the board ignores them, and a pull request needs them whatever the plan says. A plan delivered in numbered steps, one pull request each, gives each step a `### Step <N> of <M>: <title>` section that ends with that step's own `- \`<repo>:<path>\`` bullets: the board holds only the current step's paths and its open pull requests' files, and gives a reviewer that step's section. `## Paths` still lists every path of every step, because `pr:open` reads it as the Region.";

/**
 * Step 5 of the brief, the commit. With the machine's pre-PR review skill named, the review runs after the commit, on the whole diff, before a push or a
 * pull request, and again after each commit of a fix: the hook gates a push on a review since the last commit, so this is the order it allows (A11-86).
 */
function commitStep(prReview: string | null): string {
  if (prReview === null) return "5. Commit with a conventional commit message.";
  return `5. Commit with a conventional commit message. Then, BEFORE you push or open a pull request, review your whole diff: call the Skill tool with \`${prReview}\` on \`git diff <the repository's default branch>...HEAD\` and anything uncommitted. Fix every finding, re-run the repository's tests, typecheck and lint, and commit the fixes. The hook refuses a push or a pull request until the skill has run since your last commit, so after you commit fixes run it again. Stop when a run finds nothing to change.`;
}

/** Step 7 of the brief on a machine with no design tool, the default: a worker declines a design gate's check, and says so in the pull request body. */
const DESIGN_CHECK_DECLINED = "7. If a design gate asks for a design check, decline it with \"unattended worker, no design tool access\" and say so in the pull request body.";

/** Step 7 of the brief on a machine with `tickets.designTools: true`: a worker does the check, and declines it only when a design tool call is refused. */
const DESIGN_CHECK_DONE = "7. If a design gate asks for a design check, do it: read the design's values with the design tool, measure your result in the running app, look at the design node, and fill in the check the gate gives you. Decline it only when a design tool call is refused, quoting the refusal in the pull request body.";

/**
 * Step 5a of the brief on a machine with `tickets.capture: true`, before step 6 opens the pull request: a change that alters a page of the board is captured, and the
 * image is shown there, so the worker does not end `needs-human` to ask a person to look (A11-151). The image is committed under `.acceptance/`, which the
 * board ignores, and linked by its commit's sha, which exists once it is committed.
 */
function captureStep(ticketDir: string): string {
  return `5a. If your change alters what a page of the board looks like, capture each such page before you open the pull request in step 6: run \`agent-org ticket:capture <route> --size 1280x800 --out ${ticketDir}/captures/\`, where <route> is the board's route to the page, such as \`/settings/models\` for the Settings page or \`/tickets\` for the board. The command prints the PNG's path, or names what stopped it: fix what it names and run it again. Commit each PNG as \`.acceptance/captures/<name>.png\` on your branch, and link it in the pull request body as \`![<name>](https://github.com/<owner>/<repo>/blob/<head sha>/.acceptance/captures/<name>.png?raw=true)\`, with the sha of the commit that adds it. If step 5 names a review skill, run it again after this commit, as step 5 says of any commit. Do not end \`needs-human\` to ask a person to look at the page: the capture is that check.`;
}

/** Step 6 of the brief for a worker that opens its pull requests as drafts, the default. */
function draftPullRequestStep(ticket: Ticket, prOpenCommand: string, prReview: string | null, keywords: Keywords, read: TicketRead | undefined): string {
  return openPullRequestStep(`ONE DRAFT pull request per repository you changed: write its body to a file, then run \`${prOpenCommand} create --draft --title "<type>(<scope>): <what changed>" --body-file <file>\`.`, ticket, prReview, keywords, read);
}

/** Step 6 of the brief for a worker that opens its pull requests ready for review (`tickets.drafts: false`). */
function readyPullRequestStep(ticket: Ticket, prOpenCommand: string, prReview: string | null, keywords: Keywords, read: TicketRead | undefined): string {
  return openPullRequestStep(`ONE READY pull request per repository you changed: write its body to a file, then run \`${prOpenCommand} create --title "<type>(<scope>): <what changed>" --body-file <file>\`.`, ticket, prReview, keywords, read);
}

/**
 * Step 6 of the brief: how the worker opens its pull requests, as a draft (the default) or ready for review (`tickets.drafts: false`). The command is
 * `pr:open`, which checks the body and the diff against the ticket before it sends anything (A11-74); `gh pr create` is not used. The body names the
 * ticket with the tracker's closing keyword when the pull request completes it, and with its non-closing one, plus a `Partial:` line, when it is partial
 * (A11-92): the tracker closes a ticket on a merge only for the first.
 */
function openPullRequestStep(opening: string, ticket: Ticket, prReview: string | null, keywords: Keywords, read: TicketRead | undefined): string {
  const { closing, nonClosing } = keywords;
  // A reviewer reads the pull request and not this brief, so the body says which version of the ticket the work was done against (A11-167).
  const workedAgainst = read?.updatedAt == null ? "" : ` It carries the line \`Worked against the ticket as updated ${read.updatedAt}\`, so a reviewer can tell which text the work was done against.`;
  const reviewLine = prReview === null ? "" : `carries the line \`Pre-PR review: ${prReview} ran on the whole diff; it changed: <what, or nothing>\`, `;
  return `6. Push the branch and open ${opening} The body links ${ticket.url}, and names the ticket \`${closing} ${ticket.key}\` when this pull request completes it (its done-when is fully met), so the tracker closes the ticket when it merges. When the pull request is partial and leaves part of the ticket to do, it names the ticket \`${nonClosing} ${ticket.key}\` instead, with a \`Partial: <what remains>\` line, and the ticket stays open; a pull request that completes the ticket is never written with \`${nonClosing}\`. The tracker also completes the ticket on merge when it reads any of ${closingWordsOf(keywords).map((word) => `\`${word}\``).join(", ")} followed by a ticket key ANYWHERE in the body, code spans and quoted examples included, whatever else the body says: a partial body never writes one next to the ticket's key, even to quote it, and describes the example in words instead ("the closing keyword followed by the key"). \`Partial:\` is for build work a later run of this ticket does, a plan step. An After-merge line of the ticket's Done-when is not partial: the board completes the ticket when the pull requests merge and lists those lines, so a pull request that leaves only After-merge lines names the ticket \`${closing} ${ticket.key}\`. When your pull requests finish the ticket together (two repositories, say), each names the ticket \`${nonClosing} ${ticket.key}\`, because one \`${closing}\` would complete the ticket on the first merge, and each \`Partial:\` line names the run's other pull requests; your outcome then has no \`partial\`, and the board completes the ticket once all of them have merged. When the plan has numbered steps, the \`Partial:\` line begins \`step <N> of <M>\`, and the last step's pull request names the ticket \`${closing} ${ticket.key}\` and has no \`Partial:\` line. The body says what changed and how you verified it, ${reviewLine}and, when the change is visible, shows it: take screenshots with what this machine provides (see "On this machine" when there is such a section), or else end the body with "Screenshot pending". It carries an \`Outside-Region: <path> — <reason>\` line for each path outside the plan's \`## Paths\` (or its \`## Region\`, in a plan written before \`## Paths\`), and either a changeset or a \`no-release: <reason>\` line. A pull request that needs another repository's unmerged one says so in its body. If \`pr:open\` refuses, fix what it names and run it again. Exit code 3 means the pull request exists: do not run it again, and run only the step its message names.${workedAgainst}`;
}

/**
 * The brief, as markdown. `worktreeCommand` is the full command line that makes a worktree, short of the repository's name, and `prOpenCommand` the one
 * that opens a pull request (`pr:open`). `notes` is the host
 * file's `tickets.brief`, how workers behave on this machine, and `connectors` its `tickets.connectors`. `blockers` are the tickets this one
 * waited on, and `stackedOn` the ones it starts on top of. `drafts` false (`tickets.drafts`) has the worker open its pull requests ready for review.
 * `prReview` is the skill `tickets.prReview` names, which the worker runs on its whole diff before any push or pull request, or null for none.
 * `keywords` are the two words the tracker reads a pull request's body by (`source.ts`), which the brief names; a source without its own gets the defaults.
 * `numberedSteps` is true when the run's plan numbers its steps, which has the worker write the step it is on in its outcome file (A11-219).
 */
export function briefText({ ticket, folder, ticketDir, attachments, parent = null, blockers = [], stackedOn = [], steps = [], clones, worktreeCommand, prOpenCommand, notes,
  connectors = [], planned = false, drafts = true, designTools = false, capture = false, prReview = null, keywords = DEFAULT_KEYWORDS, repo = null, read, findings = [], closed = [], numberedSteps = false, opened = [], held, lost }: {
  ticket: Ticket; folder: string; ticketDir: string; attachments: readonly string[]; parent?: ParentTicket | null; blockers?: readonly Blocker[];
  stackedOn?: readonly StackBase[]; steps?: readonly MergedStep[]; clones: Readonly<Record<string, string>>; worktreeCommand: string; prOpenCommand: string; notes?: string;
  connectors?: readonly string[]; planned?: boolean; drafts?: boolean; designTools?: boolean; capture?: boolean; prReview?: string | null; keywords?: Keywords; repo?: string | null;
  read?: TicketRead; findings?: readonly Finding[]; closed?: readonly KeptClosedWork[]; numberedSteps?: boolean; opened?: readonly OpenedPull[]; held?: string;
  /** When the board found the run lost in a restart and queued it again (A11-279), for the section that says its worktree holds the earlier run's work. */
  lost?: number;
}): string {
  const stacked = new Set(stackedOn.map(({ key }) => key));
  const repos = Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");
  return `# ${ticket.key}: ${ticket.title}

${heldText(held)}${lostText(lost)}You are an unattended worker. Nobody will answer you in this run. Decide anything that is not on the escalation list yourself, in line with the plan and the ticket's Decisions, and list each such choice under "Decisions made without a person" in the pull request body. End with \`needs-human\` only for an item on the list, naming its id.

${WORKER_DECISIONS}

${TICKET_DECISIONS}

${RELAY_DECISION}

## The ticket

${ticket.url}

${readLine(read)}${ticket.description.trim() || "(no description)"}

## Files from the ticket

${filesText(attachments)}
${parentText(parent)}${blockersText(blockers.filter(({ key }) => !stacked.has(key)), findings)}${stackText(stackedOn, worktreeCommand, drafts ? STACK_OPENED_AS_DRAFT : STACK_OPENED_READY)}${stepsText(steps)}${openedText(opened)}${closedWorkText(closed, "pull request")}
## Where the work lands: you decide

You are in this ticket's own folder, \`${folder}\`. These are the repositories on this machine, checked out by the person you work for. Read them, but never commit or change branches in them:

${repos}

1. From the ticket, decide which repository the fix belongs in. ${repo === null ? "" : `The ticket's project names \`${repo}\`, so its work lands there unless it belongs in another of these repositories: then name that one. `}A ticket may name a repository that has since been retired or moved into another one: check where the code lives now, and use that. If the fix belongs in none of these (a backend service, a plugin, another team's code), change nothing and write a \`wrong-repo\` outcome naming where it belongs.
2. Make your worktree there with \`${worktreeCommand} <repo>\`. It creates \`${folder}/<repo>\` on the ticket's branch \`${ticket.branch}\`, from the repository's default branch, and on a retry it gives you back the one an earlier run made: continue from its commits rather than starting again. Run it once per repository you change; most tickets need one.
3. Work, commit and push only inside those worktrees. Read each repository's \`CLAUDE.md\` and \`AGENTS.md\` before you change anything, and use the install, test, typecheck and lint commands they give, scoped to the package you change. ${PUSH_ONCE_RULE}

## What to do

${plannedText({ planned })}1. Find the cause in the code. Fix it, with a test that fails without the fix.
2. Run the repository's checks on what you changed. Then start a subagent that has not seen your reasoning, give it your diff and its base, and ask it to find, read only, every behaviour your diff changes that you meant to keep. Fix each real finding with a test that fails without the fix.${prReview === null ? " Then run the clean-code-review skill on your diff and fix what it finds." : ""}
3. Check your diff against what was asked. List each acceptance criterion in the ticket. Add each decision in its files, its parent's description and its parent's files that applies to this ticket. Find where your diff meets each one, and finish any it misses. If you leave one unmet on purpose, say which and why in the pull request body.
4. Check what your pull request body will claim. For each behaviour it says you fixed, kept or changed, name the test assertion that checks exactly that behaviour, not a neighbouring value. Run it on the base: a fix must fail there, and a kept behaviour must pass there too. Claim nothing you have no such assertion for, or say it is unchecked.
${commitStep(prReview)}
${capture ? `${captureStep(ticketDir)}\n` : ""}${drafts ? draftPullRequestStep(ticket, prOpenCommand, prReview, keywords, read) : readyPullRequestStep(ticket, prOpenCommand, prReview, keywords, read)}
${designTools ? DESIGN_CHECK_DONE : DESIGN_CHECK_DECLINED}

Never mark a pull request ready, request a review, merge, force-push, run a workflow, or post to Slack. Those are the person's.

${MISSING_SKILL}

${STALLING_COMMANDS}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
${outcomeExamples([drafts ? "draft-pr" : "ready-pr", "wrong-repo", "done", "checked", "needs-human", "working"])}
\`\`\`

\`prs\` is an array of \`{repo, url}\` even for one pull request: a \`pr\` field is refused. The Stop hook checks this file and refuses a wrong one, naming the field, so write it again in the same turn.

\`done\`, \`checked\` and \`needs-human\` may each add \`"edit": { "title": "<the title it should have>", "description": "<the whole description it should have>", "why": "<what is wrong, and what shows it>" }\`.

A partial pull request adds \`"partial": "<what remains>"\` to its \`${drafts ? "draft-pr" : "ready-pr"}\` line, the same words as its body's \`Partial:\` line, so the board leaves the ticket open when it merges. When the plan has numbered steps, \`partial\` begins \`step <N> of <M>\`: the board queues step N + 1 when that pull request merges. A pull request that completes the ticket has no \`partial\`. \`partial\` is what remains of the ticket once every pull request of this run has merged, and only build work a later run does. It is not what one pull request leaves to its sibling in this run, and not an After-merge line of the Done-when: a run whose pull requests finish the ticket together has no \`partial\`. \`partial\` names what is still owed, never what was done: when the pull request's body says \`${keywords.closing} ${ticket.key}\`, the outcome has no \`partial\` at all. The board follows the merged pull request's own \`${keywords.closing}\` or \`Partial:\` declaration when the two disagree, and shows the disagreement on the card.

${DONE_CHECKED_OR_NEEDS_HUMAN}

${PROPOSE_EDIT}

${WORKING_OR_NEEDS_HUMAN}
${numberedSteps ? `\n${STEP_NOTES}\n` : ""}
A person may answer you here after a \`needs-human\` or \`wrong-repo\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}

/**
 * A review run's brief, as markdown: the person approved `prs`, so mark each ready, see it through its checks and its review, and fix what they
 * find. `reviewNotes` is the host file's `tickets.review`, how this machine's pull requests are checked and reviewed, and `notes` its
 * `tickets.brief`. `resumed` is true when the worker is the one that wrote the code, resumed with its own conversation. `feedback` is set on a
 * round the board started on its own: the new feedback on the pull requests, which are ready already, that the round answers. `asked` is set
 * on a round a person asked for with Respond to review: it answers the ready pull requests' current feedback, and `conflict` is the conflict lines the board
 * handed the run back for at its round cap, when it was (`conflictsIn`). `prReview` is the skill `tickets.prReview`
 * names, which each round runs on its whole diff before it pushes, or null for none. `standoff` is set on the worker's round for a stand-off (A11-290): the re-review stayed not convinced at an unchanged head, and `feedback` carries its reasons.
 */
export function reviewBriefText({ ticket, folder, ticketDir, prs, notes, reviewNotes, connectors = [], resumed, feedback, asked = false, standoff = false, conflict, prReview = null, read, previous, held }: {
  ticket: Ticket; folder: string; ticketDir: string; prs: readonly PullRequest[]; notes?: string; reviewNotes?: string;
  connectors?: readonly string[]; resumed: boolean; feedback?: string; asked?: boolean; standoff?: boolean; conflict?: string; prReview?: string | null; read?: TicketRead; previous?: TicketRead; held?: string;
}): string {
  const list = prs.map(({ repo, url }) => `- ${url}, worked in \`${folder}/${repo}\``).join("\n");
  const who = resumed
    ? "You wrote these pull requests earlier in this conversation."
    : "Another worker wrote these pull requests, and its conversation could not be found: read each pull request's diff and the ticket before you change anything.";
  const round = standoff && feedback !== undefined ? standoffWorkerRound(who, feedback, prReview)
    : asked ? askedRound(who, conflict, feedback, prReview)
    : feedback === undefined ? approvedRound(who, prReview)
    : answerRound(who, `New feedback reached your pull requests after your last round, so the board started this round to answer it.\n\nThis started the round:\n\n${quoted(feedback)}`,
      CONFLICT_LINE.test(feedback) ? MERGE_FIRST : null, prReview);
  return `# ${ticket.key}: ${round.title} for ${ticket.title}

${heldText(held)}${round.opening}

## The ticket

${ticket.url}

${readLine(read)}${quoted(ticket.description)}
${changedText(previous, read)}
## The pull requests

${list}

## What to do

${round.steps}

${ESCALATION_RULE}

${TICKET_DECISIONS}

${RELAY_DECISION}

${FOREGROUND_WAIT}

## When no check has started

${CHECKS_NOT_STARTED}

Never merge, approve, request a review, force-push, run a workflow, or post to Slack. Those are the person's.

${MISSING_SKILL}

${STALLING_COMMANDS}
${connectorsText(connectors)}${reviewNotes?.trim() ? `\n## How this machine reviews\n\n${reviewNotes.trim()}\n` : ""}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
${outcomeExamples(["reviewed", "needs-human"])}
\`\`\`

${round.reviewed} A person may answer you here after a \`needs-human\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}

/**
 * The review round's section on a ticket that changed since the round before it read it: when each text was read and last updated, the lines that differ, and the text the round read before (A11-167). Nothing
 * when the description is the same, or when the round before it is not known.
 */
function changedText(previous: TicketRead | undefined, read: TicketRead | undefined): string {
  if (previous === undefined || read === undefined || previous.hash === read.hash) return "";
  const when = (text: TicketRead): string => (text.updatedAt === null ? `read at ${new Date(text.readAt).toISOString()}` : `last updated ${text.updatedAt}`);
  return `
### The ticket changed since your last round

The description above is the latest (${when(read)}). Your last round read it when it was ${when(previous)}. These lines differ:

${diffText(previous.description, read.description)}

The description your last round read:

${quoted(previous.description)}

Check your pull requests against the new text, and say in your reply what the change meant for them.
`;
}

type Round = Readonly<{ title: string; opening: string; steps: string; reviewed: string }>;

/**
 * What a round does with a review that requests changes against a decision (A11-257, which replaced A11-213's stop). A11-213 ended the round `needs-human` so the request reached a person; with the plan's decisions binding the reviewer too,
 * the worker makes no change for it, replies quoting the decision, and ends the round `reviewed`. That reply starts the reviewer's re-review of the same head (A11-156), which the decision now binds, and A11-213's flag for a
 * CHANGES_REQUESTED pull request left idle backs it up. A request it judges wrong on other grounds is answered with the evidence, and none of these ends in a stop that is not on the escalation list.
 */
const DISPUTED_REVIEW = "When a review requests changes that go against the plan or the ticket's Decisions: make no change for it, reply on that pull request quoting the decision (the plan's line, or the ticket's Decisions entry with its heading), "
  + "and end the round `reviewed`. Your reply starts the reviewer's re-review of the same head, which that decision binds. A request you judge wrong on other grounds is answered with the evidence. End `needs-human` only for an item on the escalation list. "
  + `Start the line that disputes a decision with \`${DISPUTE_PHRASES[0]}\`, and the line that says the plan's own decision cannot be met, with the evidence, with \`${DISPUTE_PHRASES[1]}\`: if the reviewer is still not convinced at the same head, the board sends the dispute to the planner, who can change a decision of the plan, and then back to you.`;

/** The line a round's `reviewed` condition carries for a review it disputed on a decision (A11-257): the reply is the answer, and the reviewer re-reviews the head. */
const REVIEWED_DISPUTED = "A review you disputed on a decision counts as answered once your reply quoting the decision is on the pull request.";

/** The round a person started by approving the draft pull requests: mark them ready, then see them through their checks and review. */
function approvedRound(who: string, prReview: string | null): Round {
  const wait = REVIEW_WAIT_MINUTES;
  return {
    title: "review round",
    opening: `A person reviewed your draft pull requests and approved them. ${who} You are unattended again: nobody will answer a question, so decide, do the work, and end by writing the outcome file below.`,
    steps: `If a pull request conflicts with its base branch (\`gh pr view <its url> --json mergeable,mergeStateStatus\` says CONFLICTING or DIRTY), merge the base into your branch first, as step 1 of a feedback round says: never rebase, and never force-push.

1. Mark each pull request ready with \`gh pr ready <url>\`.
2. Wait for each one's checks and its review, as "How this machine reviews" says. Wait at most ${wait} minutes for each. If a check or the review has not finished by then, write a \`needs-human\` outcome that names what you waited for.
3. Read every review comment and every failed check. Fix each real finding in the worktree, with a test that fails without the fix where the finding is about behaviour. A finding you judge wrong is not fixed: say why in your reply instead. ${DISPUTED_REVIEW} Run the repository's checks on what you changed.
4. ${roundPushStep(prReview)}
5. Reply on each pull request with one comment: each finding, and what you did about it.
6. Wait at most ${wait} minutes for the checks on the commit you pushed. If one fails, fix it, push, and wait again. Do not wait for a second review: the board starts another round when new feedback comes.`,
    reviewed: `Write \`reviewed\` only when every pull request is ready, every finding is answered, and every check passed on its last commit. ${REVIEWED_DISPUTED}`,
  };
}

/**
 * The step a round takes first when the feedback names a pull request that conflicts with its base: merge the base in, never rebase. A round the
 * feedback names no conflict in gets no such step, so its brief is what it was.
 */
const MERGE_FIRST = "The text above says a pull request conflicts with its base branch. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin/<base>` in the worktree of each such pull request. Never rebase, and never force-push. Resolve each conflict keeping both changes' intent, run the repository's own tests, typecheck and lint, and push. Say in your reply on that pull request which files conflicted and how each was resolved.";

/**
 * The commit-and-push step of a round. With the machine's pre-PR review skill named, the round reviews the whole diff after its last commit and before
 * it pushes, as step 5 of the brief does, so the hook's gate on a push is met (A11-86).
 */
function roundPushStep(prReview: string | null): string {
  if (prReview === null) return "Commit with a conventional commit message, and push. Never force-push.";
  return `Commit with a conventional commit message. Then, BEFORE you push, review the whole diff of each pull request, base to head: call the Skill tool with \`${prReview}\`, fix every finding, re-run the repository's tests, typecheck and lint, and commit the fixes. The hook refuses a push until the skill has run since your last commit, so after you commit fixes run it again. Stop when a run finds nothing to change, then push. Never force-push. Say in your reply on each pull request what the review changed.`;
}

/**
 * A round that answers the feedback on pull requests that are ready already: one the board started on new feedback, or one a person asked for.
 * `why` says which, and what started it. `merge` is the step that merges a conflicting base in first, or null for a round with no conflict.
 * `prReview` is the skill the machine's review runs before the round's push, or null.
 */
function answerRound(who: string, why: string, merge: string | null, prReview: string | null): Round {
  const wait = REVIEW_WAIT_MINUTES;
  const [first, ...rest] = why.split("\n\n");
  const items = [
    "Read that feedback and everything else on each pull request since your last reply: its reviews, its conversation comments, its inline review comments and its failed checks. The pull requests are ready already: do not run `gh pr ready`.",
    `Fix each finding that is right in the worktree, with a test that fails without the fix where the finding is about behaviour. A finding you judge wrong is not fixed: answer it with the evidence instead. ${DISPUTED_REVIEW} Run the repository's checks on what you changed.`,
    roundPushStep(prReview),
    "Reply on each pull request with one comment: each finding, and what you did about it.",
    `Wait at most ${wait} minutes for the checks on the commit you pushed. If one fails, fix it, push, and wait again.`,
  ];
  return {
    title: "feedback round",
    opening: [`${first} ${who} You are unattended: nobody will answer a question, so decide, do the work, and end by writing the outcome file below.`, ...rest].join("\n\n"),
    steps: (merge === null ? items : [merge, ...items]).map((item, index) => `${index + 1}. ${item}`).join("\n"),
    reviewed: `Write \`reviewed\` only when every finding is answered and every check passed on the last commit you pushed. ${REVIEWED_DISPUTED}`,
  };
}

/**
 * The worker's round for a STAND-OFF (A11-290): the reviewer re-reviewed the head after the worker's reply and is still not convinced, and the planner has upheld the decision the reply disputed, or the reply disputed none. The worker must
 * meet the re-reviewer's reasons with a change: a push, or a change to the measurement or the evidence the description holds. A second reply with no change at the same head is refused by the Stop hook (`standoff-round.json`), so the only other way out is a
 * stop that names an item of the escalation list.
 */
function standoffWorkerRound(who: string, feedback: string, prReview: string | null): Round {
  const wait = REVIEW_WAIT_MINUTES;
  const items = [
    "Read the stand-off above: the review you answered, your reply, the re-reviewer's reasons, and what the planner decided when it did. Each reason is a finding you must meet.",
    "Meet each reason with a change in the worktree, with a test that fails without it where the reason is about behaviour: change the code, or redo the measurement or the evidence the reason names, and put the new figures in the pull request description. Do not reply again without a change: a second reply at the same head, with the description as it was, is refused by the Stop hook. Where you still judge a reason wrong, the evidence you change is how you show it. Run the repository's checks on what you changed.",
    roundPushStep(prReview),
    "Reply on each pull request with one comment: each reason, and what you changed for it.",
    `Wait at most ${wait} minutes for the checks on the commit you pushed. If one fails, fix it, push, and wait again.`,
  ];
  return {
    title: "stand-off round",
    opening: `The board started this round for a stand-off on your pull requests. ${who} You are unattended: nobody will answer a question, so decide, do the work, and end by writing the outcome file below.\n\n${quoted(feedback)}`,
    steps: items.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    reviewed: "Write `reviewed` only when each reason is met by a change: the head of each pull request has moved, or its description's measurement or evidence has changed, and every check passed on the last commit you pushed. A `reviewed` that changes neither is refused. The only other end is `needs-human` that names an item of the escalation list.",
  };
}

/**
 * A round a person asked for. When the board handed the run back at its round cap for a conflict (`conflict`), the round says so. When its merge of the
 * blocker's branch conflicted before it started (`feedback`, A11-150), the round says that. Either way it merges the base in first, as a feedback round does;
 * any other asked round keeps the brief it had, with no merge step.
 */
function askedRound(who: string, conflict: string | undefined, feedback: string | undefined, prReview: string | null): Round {
  const asked = "A person asked you to answer the current feedback on your pull requests: their reviews, comments and failing checks.";
  if (conflict !== undefined) return answerRound(who, `${asked}\n\nThe board handed this run back because:\n\n${quoted(conflict)}`, MERGE_FIRST, prReview);
  if (feedback !== undefined) return answerRound(who, `${asked}\n\nThe merge of the blocker's branch into yours conflicted:\n\n${quoted(feedback)}`, MERGE_FIRST, prReview);
  return answerRound(who, asked, null, prReview);
}

/**
 * A publish run's brief, as markdown: post the pull requests a person chose with this machine's instruction, and write down the messages it
 * posted. `run` is the host file's `tickets.publish.run`, with the pull requests, one per line, and the run's folder filled in.
 */
export function publishBriefText({ dir, prs, run }: { dir: string; prs: readonly PullRequest[]; run: string }): string {
  const urls = prs.map(({ url }) => url);
  return `# Publish ${urls.length} pull request${urls.length === 1 ? "" : "s"}

You are an unattended publisher. A person chose these pull requests on the board and pressed Publish. Nobody will answer a question.

${urls.map((url) => `- ${url}`).join("\n")}

## What to do

${run.replaceAll("{prs}", urls.join("\n")).replaceAll("{dir}", dir)}

Post each pull request once. Change no code, and open, edit or merge no pull request.

${MISSING_SKILL}

${STALLING_COMMANDS}

## The files you write

Write \`${dir}/${PUBLISHED_FILE}\` once the messages are posted, with the web address of each message you posted:

\`\`\`json
{ "links": ["<message url>"] }
\`\`\`

Then write \`${dir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
${outcomeExamples(["published"])}
{ "kind": "needs-human", "reason": "<why the messages could not be posted, which the board shows as the run's failure>" }
\`\`\`
`;
}

/** The hook command a settings file names: this tool's `ticket:hook`, by absolute path, so it runs without the tool on `PATH`. */
export type HookCommand = Readonly<{ node: string; bin: string }>;

/**
 * The ticket folder's `.claude/settings.local.json`. `readDirs` are the person's repositories, which the worker reads but never changes.
 * `plugins` are enabled here because a worker starts in the ticket's folder, where no project settings of the person's apply. A new-ticket run
 * (`writer`, the tracker's create tool) also records each ticket it creates, as the creation returns (`ticket:hook post-tool-use`), so the board can check its outcome.
 */
export function workerSettings({ model, ticketDir, readDirs, hook, plugins = [], writer = null }: {
  model: string; ticketDir: string; readDirs: readonly string[]; hook: HookCommand; plugins?: readonly string[]; writer?: Pick<TrackerWriting, "createTool"> | null;
}): Record<string, unknown> {
  const command = (event: string) => ({ type: "command", command: hook.node, args: [hook.bin, "ticket:hook", event, ticketDir], timeout: 30 });
  return {
    autoMemoryEnabled: false,
    model,
    permissions: { defaultMode: "bypassPermissions", additionalDirectories: [ticketDir, ...readDirs] },
    ...(plugins.length > 0 ? { enabledPlugins: Object.fromEntries(plugins.map((plugin) => [plugin, true])) } : {}),
    hooks: {
      Stop: [{ hooks: [command("stop")] }],
      PreToolUse: [{ matcher: "*", hooks: [command("pre-tool-use")] }],
      ...(writer === null ? {} : { PostToolUse: [{ matcher: writer.createTool, hooks: [command("post-tool-use")] }] }),
    },
  };
}

/**
 * The flags after the first prompt. `resume` is a Claude session to continue, the worker's own conversation, rather than a new one.
 * `--disallowedTools` is last, so a list never swallows a flag after it (`wake.ts`'s seat flags say why).
 */
export function workerFlags({ name, model, effort, addDirs, resume }: { name: string; model: string; effort: string; addDirs: readonly string[]; resume?: string }): string[] {
  return [...(resume ? ["--resume", resume] : []), "--model", model, "--effort", effort, "--name", name, ...addDirs.flatMap((dir) => ["--add-dir", dir]),
    "--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"];
}

/** The first prompt of a new-ticket run: a pointer to its brief. */
export function writerPrompt(dir: string, mode: WriterMode = "quick"): string {
  const first = mode === "grill" ? " Your first message to me is your first question." : "";
  return `Read ${dir}/${BRIEF_FILE} and follow it.${first}`;
}

/**
 * The first prompt of a talk session, which resumes a finished run's own session when a person opens it from the board. The agent is attended again: it says where it stands,
 * waits, and hands the ticket back as `needs-human` meanwhile, which keeps its terminal open (the stop hook refuses a stop with no outcome).
 */
export function talkPrompt(ticketDir: string): string {
  return `A person has opened this session to talk to you. You are no longer unattended: answer them, and ask them any question you need. Say in one or two sentences where you stand, then wait for what they write, and do no work until they do. Your stop is refused until an outcome file exists, so while you wait write a \`needs-human\` outcome in ${ticketDir}/${OUTCOME_FILE} whose reason is "waiting for the person in the terminal". Once the work they ask for is done, write the real outcome, as your brief says. ${TICKET_DECISIONS} ${RELAY_DECISION}`;
}

/** The first prompt: a pointer to the brief, short enough that no quoting or argument limit can cut it. */
export function firstPrompt(ticketDir: string): string {
  return `Read ${ticketDir}/${BRIEF_FILE} and follow it.`;
}

/** Why a review round started, which its first prompt says: a person approved the drafts, the board saw new feedback, or a person asked. */
export type RoundCause = "approved" | "feedback" | "asked";

const ROUND_CAUSES: Readonly<Record<RoundCause, string>> = {
  approved: "A person reviewed this ticket's pull requests and approved them.",
  feedback: "New feedback reached this ticket's pull requests.",
  asked: "A person asked you to answer the feedback on this ticket's pull requests.",
};

/** A review run's first prompt, which a resumed worker reads after its own earlier turns. */
export function reviewPrompt(ticketDir: string, cause: RoundCause = "approved"): string {
  return `${ROUND_CAUSES[cause]} Read ${ticketDir}/${BRIEF_FILE} and follow it.`;
}

/** The request, quoted line by line, so a request that names a command or a path reads as the person's words, not as instructions to this run. */
const requestQuoted = (request: string): string => request.split("\n").map((line) => `> ${line}`).join("\n");

/** What each mode asks of the run, which the brief's `## The mode` section says. */
const MODE_TEXT: Readonly<Record<WriterMode, string>> = {
  quick: "You are unattended. Nobody will answer a question: the skill's unattended create answers its own grill, and you file the ticket.",
  grill: "You are interactive: the person is in this run's terminal. Run the skill's grill with them: ask your questions one at a time, and wait for each answer before the next. Your first message to them is your first question. To ask a question, end your turn with it: the board shows the question to the person and keeps this run, in its terminal, until they answer. Do not write an outcome to ask a question. Write `created` only once the grill is done, the ticket is filed and its plan is attached.",
};

/** Where each of the form's choices lands on the ticket, as the brief says it. */
const CHOICE_LANDS: Readonly<Record<keyof WriterForm, string>> = {
  project: "the project of the ticket, by its name",
  repo: "the last line of the description: `**Repository:** <repo>`",
  goal: "a label in the group `Goal`",
  priority: "the ticket's priority number",
  parent: "the ticket's `parentId`: the ticket is filed as a child of it",
};

/** How many choices the form offers: project, repository, goal, priority and parent. */
const CHOICES_OFFERED = Object.keys(CHOICE_LANDS).length;

/** What the brief says of an `auto` request: the writer makes each of the five choices (A11-199). */
const AUTO_TEXT = "Auto placement: choose the project, repository, goal, priority and parent from the request, as the skill's Steps 7 and 8 say.";

/**
 * The form's choices as the brief's requirements (A11-199). An `auto` request names none, and the writer makes all five. A `manual` request lists each
 * choice the person made, as a requirement, and leaves the rest to the writer. PURE.
 */
const formText = (placement: Placement, form: WriterForm, priorities: TrackerWriting["priorities"]): string => {
  if (placement === "auto") return AUTO_TEXT;
  const lines = [
    form.project === undefined ? undefined : `- Project: ${form.project} (${CHOICE_LANDS.project})`,
    form.repo === undefined ? undefined : `- Repository: \`${form.repo}\` (${CHOICE_LANDS.repo})`,
    form.goal === undefined ? undefined : `- Goal: ${form.goal} (${CHOICE_LANDS.goal})`,
    form.priority === undefined ? undefined : `- Priority: ${form.priority}, number ${priorities[form.priority as Priority]} (${CHOICE_LANDS.priority})`,
    form.parent === undefined ? undefined : `- Parent: ${form.parent} (${CHOICE_LANDS.parent})`,
  ].filter((line): line is string => line !== undefined);
  const rest = lines.length === CHOICES_OFFERED ? "" : " Each of the five not listed here is yours to choose from the request.";
  if (lines.length === 0) return `Manual placement, and the person set none of the five.${rest}`;
  return `Manual placement:\n${lines.join("\n")}\n\nThese are requirements. Use them as given: you set each one on the ticket you file.${rest}`;
};

/** The priorities as the brief lists them for the writer to choose from: each name with the tracker's number, most urgent first. PURE. */
const priorityChoices = (priorities: TrackerWriting["priorities"]): string => PRIORITIES.map((name) => `${name} ${priorities[name]}`).join(", ");

/**
 * A Grill run's brief (A11-134): the grill of one existing ticket, which the board holds back until its open decisions are settled. The run asks the person,
 * in its terminal, each open line and, for a screen, its behaviour, and writes the answers to `decisions.md` in its folder. The board writes them into the
 * ticket when the run ends `decided`. The run files nothing and changes nothing in the tracker.
 */
function grillBriefText({ ticket, dir }: { ticket: Ticket; dir: string }): string {
  const open = openDecisionOf(ticket.description);
  const needed = sectionsNeeded(ticket);
  const decisions = needed.includes("Decisions")
    ? `- **Decisions:** the open line is \`${open?.line ?? ""}\`, in ${open?.section ?? "the ticket"}. Ask the person about it, and about each other open decision in the ticket's Acceptance, Done-when and Open-check, one question at a time.`
    : "- **Decisions:** none is open.";
  const behaviour = needed.includes("Behaviour")
    ? "- **Behaviour:** the ticket changes a screen. Ask the person what they see, what each control does, and what the empty and the failed states show, one question at a time."
    : "- **Behaviour:** none is to be grilled.";
  return `# Grill ${ticket.key}: ${ticket.title}

You are a ticket writer on this machine, and a person asked for a grill on ${ticket.key}. The board holds the ticket back from a worker until the person has settled its open decisions, and this run is where they settle them.

## The ticket

${ticket.url}

${quoted(ticket.description)}

## What to settle

${decisions}
${behaviour}

## The mode

You are interactive: the person is in this run's terminal. Ask one question at a time, and wait for each answer before the next. To ask a question, end your turn with it: the board shows the question to the person and keeps this run until they answer. Do not write an outcome to ask a question.

## What to do

1. Run the \`a11ign:create-ticket\` skill's grill on ${ticket.key}, in its "grill ${ticket.key}" form, and ask only what is listed under "What to settle".
2. Write \`${dir}/${DECISIONS_FILE}\`: a \`## Decisions\` section when a decision was open, and a \`## Behaviour\` section when the behaviour was to be grilled. Each holds each question and the person's answer, in the person's words as they confirmed them in the terminal. Write nothing else in it.
3. Write \`${dir}/${OUTCOME_FILE}\` as the last thing you do.

File no ticket, attach nothing, and change nothing in the tracker: no create, update, comment or attachment. The read-only tracker tools are yours to use. Change no repository.

${MISSING_SKILL}

## The outcome file

Write \`${dir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "decided", "ticket": "${ticket.key}" }
{ "kind": "needs-human", "reason": "<the one question the person must answer before the grill can finish>" }
\`\`\`

Write \`decided\` once \`${DECISIONS_FILE}\` holds each section listed under "What to settle" that is not "none". A person may answer you here after a \`needs-human\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}

/**
 * The Team line of a new-ticket brief (A11-267): ONE ordered rule, in the same words for every run, so two runs of the same request cannot decide differently. The teams it names are the only part that varies, and they come from the
 * request and the host, never from the run: the request's own team (the board's, set on a request it makes itself), else the team the parent the form names is in, then the configured tracker team (`tickets.pick`), then the workspace's only
 * team, which the run reads with the tracker's read-only tools (the create-ticket skill's own unattended rule), and needs-human only when none is left. PURE.
 */
function teamRule({ team, pickTeam, writing }: Readonly<{ team: string | null; pickTeam: string | null; writing: TrackerWriting }>): string {
  const requested = team === null
    ? "the request sets no team of its own, so the team of the parent ticket the form names, if it names one. A parent you choose yourself under Auto placement takes its team in the same way"
    : `\`${team}\`, the team the board set on this request. File the ticket in it`;
  const configured = pickTeam === null ? "no team is set on this machine" : `\`${pickTeam}\`, the team the Pick view lists`;
  return `the first of these four that gives a team. The skill's Step 6 takes the team from this brief, and asks nobody.
  1. **The request's own team:** ${requested}.
  2. **The configured tracker team:** ${configured}.
  3. **The workspace's only team:** list the teams with the read-only ${writing.label} tools, leave out each team that is retired or archived, and use the one team left when exactly one is.
  4. **Otherwise** end needs-human, since no team is known. Never choose among several teams.`;
}

/**
 * A new-ticket run's brief (A11-94, A11-124, A11-135): the instruction the machine configures, with the person's request, the folder and the board's mode
 * filled in, the choices the form made and where each lands, the team, the repositories it may read, and the outcome it writes last. The run runs the
 * create-ticket skill in full, in the mode the board chose, and files its own ticket and plan through the tracker's tools (`writerTools`).
 * Its one prohibition is an update to a ticket it did not create. PURE.
 */
export function writerBriefText({ run, request, mode, placement, form, clones, dir, team = null, pickTeam, ticket, writing }: {
  run: string; request: string; mode: WriterMode; placement: Placement; form: WriterForm; clones: Readonly<Record<string, string>>; dir: string;
  /** What the tracker plugin files a ticket with: its tools, its priority numbers and what to call it. */
  writing: TrackerWriting;
  /** The team the board set on this request (`WriterRun.team`), or null: the first team the brief's Team rule takes (A11-267). */
  team?: string | null;
  /** The team `tickets.pick` lists, or null: the configured tracker team, the second the Team rule takes. */
  pickTeam: string | null;
  /** The ticket a Grill run grills, read as it is now. A Grill run's brief is the grill of that ticket, and files nothing (A11-134). */
  ticket?: Ticket;
}): string {
  if (ticket !== undefined) return grillBriefText({ ticket, dir });
  const instruction = run.replaceAll("{request}", request).replaceAll("{dir}", dir).replaceAll("{mode}", mode);
  return `# New ticket: ${request.split("\n")[0].slice(0, 120)}

You are a ticket writer on this machine. A person asked for a ticket on the board. Run the \`a11ign:create-ticket\` skill in full for it: its grill, its plan, its ticket in the skill's format, and the plan attached to the ticket. You file the ticket yourself, through the tracker's tools, and the board shows the ticket it made when this run ends.

The one thing you must not do: call the tracker's create-or-update tool with an \`id\`, or change, close, move or delete a ticket you did not create in this run. Create a ticket only with no \`id\`.

## The request

${requestQuoted(request)}

## The person's choices

${formText(placement, form, writing.priorities)}

## The mode

The board chose this run's mode, and it decides how the run works, whatever the instruction under "What to do" says: \`${mode}\`.

${MODE_TEXT[mode]}

## What to do

${instruction}

If the instruction above mentions draft files, ignore that: this run writes no draft, and it files its ticket as this brief says.

Check the tracker before you file, with the read-only ${writing.label} tools (\`get\`, \`list\`, \`search\`, \`extract\`), for an open ticket that already asks for the same thing. Name each one under "Possible duplicates" in the description, with the reason. Read the repositories below to write the Done-when from what the code does today.

Repositories on this machine (read only; never change them):

${reposText(clones)}

${MISSING_SKILL}

${STALLING_COMMANDS}

## The ticket

- **Team:** ${teamRule({ team, pickTeam, writing })}
- **Title, description, labels, project and goal:** the skill's Steps 5, 7 and 8, as written. The description ends with \`**Repository:** <repo>\`: the form's repository or, when it names none, the one of the repositories below that holds the work, if one clearly does.
- **Priority:** the number of the form's priority when it names one, else the priority the request warrants, as one of these numbers: ${priorityChoices(writing.priorities)}.
- **Relations:** \`parentId\`, \`blockedBy\` and \`relatedTo\` are set on the ticket you create. Never set \`blocks\`: it writes a relation on another ticket.
- **Status:** make no status move. The skill's Planned move does not happen in this run: the ticket stays in the state it lands in, since a ticket is never updated after it is created here.
- **Plan:** write the plan and its ADRs as the skill's unattended create form says, with "Decisions made without a person", and attach them to the ticket you created, as its Step 10 and \`plan-attachment.md\` say.
- **Tracker tools:** create the ticket with \`${writing.createTool}\`, with no \`id\`. Attach files with ${writing.attachTools.map((tool) => `\`${tool}\``).join(" and ")}, naming only a ticket this run created. ${writing.briefNote}
- **Several tickets:** an epic is its parent and one child per repository. This run creates at most ${MAX_CREATED} tickets.

## The outcome file

Write \`${dir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "created", "created": ["A11-140"] }
{ "kind": "needs-human", "reason": "<why the run cannot finish, which the board shows as its failure>", "created": ["A11-140"] }
\`\`\`

List in \`created\` every ticket you made, each by its key. Write \`created\` once every ticket is filed and its plan is attached. Write \`needs-human\` only when the run cannot finish at all, and then list in \`created\` any ticket you made before it stopped, so the board shows it. The board checks each key against the tickets this run created, so a key it did not make fails the run.
`;
}
