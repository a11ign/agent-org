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
import type { StackBase } from "./board-view.ts";
import type { DenyRule } from "./settings.ts";
import type { PullRequest } from "./queue.ts";
import { DEFAULT_KEYWORDS, type Blocker, type Keywords, type Ticket } from "./source.ts";

/** The file a worker writes last, and the one thing the pool and the stop hook read to know a run has ended. */
export const OUTCOME_FILE = "outcome.json";
/** Where a parked run's outcome is moved when a person answers its agent, so the stop hook asks for a new one. */
export const PREVIOUS_OUTCOME_FILE = "outcome.prev.json";
export const BRIEF_FILE = "brief.md";
/** The stop hook's count of refused stops in a row, beside the outcome file. */
export const STOP_COUNT_FILE = "stop-refusals";
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
 * the PreToolUse hook allow the `post-pr-to-slack` skill and those connectors, which only a person's Publish makes a run's to use.
 */
export const PUBLISH_FILE = "publish-run";
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
/** What a publish run writes beside its outcome file: the messages it posted, as `{ "links": ["<message url>", ...] }`. */
export const PUBLISHED_FILE = "published.json";

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

/** What a worker does when a skill its brief names is missing: a copy of the skill's files, read by hand, is not the skill and its helpers. */
const MISSING_SKILL = "If a skill this brief names is not available in this session, write a `needs-human` outcome naming it, rather than following a copy of its files.";

/**
 * What a planner does with a ticket that is only a parent: an epic whose work is all in the tickets under it is not work for one run, so its plan
 * says so and points the person at the children, rather than planning a run of its own (A11-24, an epic, was handed to a person on 2026-10-17).
 */
const PARENT_ONLY_PLAN = "A ticket that is only a parent, an epic whose work is all in the tickets under it, gets no plan for a run of its own. Its plan says that it is only a parent, names the child tickets that hold its work, and suggests the person queues those children instead of a run on it.";

/**
 * When a worker writes `checked` and when `needs-human`. `needs-human` puts the run in the board's Needs you and keeps its workspace open for an
 * answer, so a worker that only found nothing to change must not write it: that is `checked`, which ends the run without asking anyone.
 */
const CHECKED_OR_NEEDS_HUMAN = "Write `checked` when you looked at what the ticket asks and nothing needs to change: it is already done, the problem it describes is not there, or the ticket is only a parent whose work is all in its child tickets (name them, so the person queues them). Say in its reason what you checked and what you found. Write `needs-human` only for a real question or decision that only the person can make: it asks them for an answer, and the run waits for one.";

/**
 * When a worker writes `working` rather than `needs-human` (A11-80). A worker that ends its turn while its own background work runs on, a long
 * Ansible run watched by a Monitor say, must still write an outcome, and `needs-human` put the run in Needs you though nothing was asked of
 * anyone. `working` keeps the run In progress, with its reason as the run's note. It is never a way to park a question: that is `needs-human`.
 */
const WORKING_OR_NEEDS_HUMAN = "Write `working` only while your own background work (a background shell or a Monitor) is genuinely still running and will wake you when it finishes. Say in its reason what is running and what you will do when it ends. The board keeps the run In progress, and marks it stalled if you stay idle too long with no newer outcome. When the work wakes you, finish, and write the outcome file again with how the run ended, or with `working` again if more of it is still running. Never write `working` to park a question or to wait on a person: that is `needs-human`. A process you started detached is not background work of yours until a Monitor holds it: it wakes nothing when it ends, so arm a Monitor on its PID or its log (`until ! kill -0 <pid>; do sleep 5; done`) before you write `working`, or wait for it in the foreground. A `working` with no shell or Monitor running is refused: nothing will wake you.";

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

/** The connectors section of the brief, or nothing when the machine allows none. */
function connectorsText(connectors: readonly string[]): string {
  if (connectors.length === 0) return "";
  return `
## Connectors

This machine lets you call the connector tools whose names match ${connectors.map((pattern) => `\`${pattern}\``).join(", ")}. Use them for what your ticket needs, such as reading its parent, the tickets that block it and related work. Every other connector is refused.
`;
}

/**
 * The section naming the tickets this one waited on, or nothing for a ticket that waited on none. A blocker's merge can come minutes before the
 * release it feeds, such as a package version, so the worker checks the release is out rather than finding it missing.
 */
function blockersText(blockers: readonly Blocker[]): string {
  if (blockers.length === 0) return "";
  const pulls = (blocker: Blocker) => Object.entries(blocker.pulls).map(([url, state]) => `${url} (${state})`).join(", ") || "no pull request linked";
  return `
## Tickets that blocked this one

This ticket waited until each of these was done:

${blockers.map((blocker) => `- ${blocker.key}, ${blocker.status}: ${pulls(blocker)}`).join("\n")}

If your work depends on something one of them releases, such as a new package version, check that the release is out before you rely on it, for example with \`gh release list --repo <owner>/<repo>\` or the package registry. A release can follow its merge by some minutes: wait for it rather than fail.
`;
}

/**
 * The section naming the blockers this run is stacked on, or nothing for a run stacked on none. Each is not merged yet, but has an open pull
 * request in the repository where the run's plan puts its work, so the worker branches from it and stacks its own pull request on it. The
 * branch is the tracker's, which a person may not have used, so the worker checks it against the pull request.
 */
function stackText(bases: readonly StackBase[], worktreeCommand: string): string {
  const [first] = bases;
  if (first === undefined) return "";
  const { repo } = first;
  return `
## Stack on the work you wait for

These tickets block this one and are not merged yet. Each has an open pull request in \`${repo}\`, where your plan puts this ticket's work:

${bases.map(({ key, url, branch }) => `- ${key}: ${url}, on branch \`${branch}\``).join("\n")}

1. Build on the one your plan says this ticket builds on, or on the last one listed when the plan does not say. Check its branch with \`gh pr view <its pull request url> --json headRefName\`, and use that one where it differs from the branch above. Make your worktree from it: \`${worktreeCommand} ${repo} --from <branch>\`.
2. After you open your own draft pull request, stack it on that one, bottom first: \`gh stack link <its pull request url> <your pull request url>\`. Run no other \`gh stack\` command.
3. Say in your pull request body which pull request yours is stacked on.
`;
}

/** What a worker is told about a plan a planning run wrote, which no person agreed: nothing when a person's plan, or none, is all it has. */
function plannedText(planned: boolean): string {
  if (!planned) return "";
  return "Your plan was written by an unattended planning run, not agreed with a person. Put each decision it says it made without a person in your pull request body, under the heading \"Decisions made without a person\", so the reviewer checks each one against the code.\n\n";
}

/** The host file's `tickets.planner.run` with the tickets it plans, comma-separated, and the folder their plans go in filled in. */
const plannerInstruction = (run: string, keys: readonly string[], dir: string): string =>
  run.replaceAll("{keys}", keys.join(", ")).replaceAll("{key}", keys.join(", ")).replaceAll("{dir}", dir);

/** The repositories a planning run reads, as a list. */
/** The \`clones\` keys, each quoted, for a brief that asks for one of them by name. */
const cloneNames = (clones: Readonly<Record<string, string>>): string => Object.keys(clones).map((name) => `\`${name}\``).join(", ");

const reposText = (clones: Readonly<Record<string, string>>): string => Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");

/**
 * The feedback line for a pull request that conflicts with its base, as `pool.ts` writes it into a round's feedback. `CONFLICT_LINE` finds it there,
 * so a round whose feedback names a conflict is briefed to merge the base in first.
 */
export const conflictLine = (url: string, base: string | null): string => `${url} conflicts with its base branch ${base ?? "unknown"}.`;

export const CONFLICT_LINE = /conflicts with its base branch/;

/** A description quoted, so its own headings cannot read as the brief's. */
const quoted = (description: string): string => (description.trim() || "(no description)").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");

/**
 * The planning run's brief, as markdown: plan the ticket with this machine's planner, change no code, and leave the plan's files in `planDir`
 * for the board to attach. `run` is the host file's `tickets.planner.run`, with the ticket and the folder filled in.
 */
export function planBriefText({ ticket, ticketDir, planDir, attachments, parent = null, clones, run, notes, connectors = [] }: {
  ticket: Ticket; ticketDir: string; planDir: string; attachments: readonly string[]; parent?: ParentTicket | null;
  clones: Readonly<Record<string, string>>; run: string; notes?: string; connectors?: readonly string[];
}): string {
  const repos = reposText(clones);
  const instruction = plannerInstruction(run, [ticket.key], planDir);
  return `# Plan ${ticket.key}: ${ticket.title}

You are an unattended planner. Nobody will answer a question. Plan this ticket, and change no code: make no worktree, commit, push or pull request. A worker implements the plan once the board has attached it to the ticket.

## The ticket

${ticket.url}

${ticket.description.trim() || "(no description)"}

## Files from the ticket

${filesText(attachments)}
${parentText(parent)}
## The repositories on this machine

Read them to plan, but never change them, commit in them or change their branches:

${repos}

## What to do

${instruction}

${PARENT_ONLY_PLAN}

${MISSING_SKILL}

The plan's files go in \`${planDir}\`, and nowhere else. The board attaches each one to the ticket under its file name. Write only markdown files there, each 1 MB or less: anything else stops the board attaching any of them. ${regionInstruction(clones)}

${PATHS_RULE}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "planned" }
{ "kind": "needs-human", "reason": "<the question only a person can answer, and why the evidence does not settle it>" }
\`\`\`

Write \`planned\` only when the plan's files are in \`${planDir}\`. A person may answer you here after a \`needs-human\` outcome. If one does, finish the plan with what they said, and write the outcome file again as the last thing you do.
`;
}

/** One ticket of a batch, as its planning brief names it: the ticket, its downloaded files, and the ticket it is part of. */
export type BatchTicket = Readonly<{ ticket: Ticket; attachments: readonly string[]; parent: ParentTicket | null }>;

/** One ticket's section of a batch's brief. Its description is quoted, as a parent's is, so its headings cannot read as the brief's. */
function batchTicketText({ ticket, attachments, parent }: BatchTicket): string {
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

${quoted(ticket.description)}

### Files from ${ticket.key}

${filesText(attachments)}
${parentPart}`;
}

/**
 * A batch planning run's brief, as markdown: plan every ticket in `tickets` in one run, change no code, and leave a folder of plan files (or a
 * question) per ticket, and the batch's order, in `planDir`. `runDir` holds the run's outcome file. `run` is the host file's
 * `tickets.planner.run`, with the tickets and the folder filled in.
 */
export function batchPlanBriefText({ tickets, runDir, planDir, clones, run, notes, connectors = [] }: {
  tickets: readonly BatchTicket[]; runDir: string; planDir: string; clones: Readonly<Record<string, string>>; run: string; notes?: string; connectors?: readonly string[];
}): string {
  const keys = tickets.map(({ ticket }) => ticket.key);
  return `# Plan ${keys.length} tickets together: ${keys.join(", ")}

You are an unattended planner. Nobody will answer a question. A person queued these tickets together, so they are likely linked: plan them as one batch, and change no code. Make no worktree, commit, push or pull request. A worker implements each plan once the board has attached it to its ticket.
${tickets.map(batchTicketText).join("")}
## The repositories on this machine

Read them to plan, but never change them, commit in them or change their branches:

${reposText(clones)}

## What to do

${plannerInstruction(run, keys, planDir)}

${PARENT_ONLY_PLAN}

${MISSING_SKILL}

## Where the plans go

Write everything in \`${planDir}\`, and nowhere else:

- \`${planDir}/<KEY>/\` for each ticket above holds that ticket's plan files, or a \`${QUESTION_FILE}\` when only a person can settle its plan. The board attaches each plan file to its own ticket under its file name. Write only markdown files there, each 1 MB or less: anything else stops the board attaching that ticket's plan. A question about one ticket does not stop the others, so plan the rest. ${regionInstruction(clones)} ${PATHS_RULE}
- \`${planDir}/${ORDER_FILE}\` is one object with an entry for each ticket: \`{ "<KEY>": { "repo": "<repository>", "after": ["<KEY>", ...], "wait": "stacked" or "merged" } }\`, where \`wait\` is optional. \`repo\` is the repository the ticket's work lands in, or \`null\` for a ticket with a question. It must be exactly one of these names, which are the host file's \`clones\` keys: ${cloneNames(clones)}. A name is not the folder its checkout sits in, so never take a \`repo\` from a path: the board refuses any other name, and hands that ticket to a person. \`after\` names the tickets of this batch whose work it needs first. Name only tickets of this batch, never the ticket itself, and make no cycle. The board records each one in the tracker as blocking the ticket, and its worker starts only once they are done, or, where it stacks on one, on that one's branch.

How \`wait\` says how a ticket waits on each ticket in its \`after\`:

- With no \`wait\`, or \`"stacked"\`, the ticket is stacked. When its work lands in the same repository as its blocker and that blocker has an open pull request there, the board starts the ticket on that branch and its pull request is stacked on the blocker's. Choose this when the code builds on the blocker's diff.
- \`"wait": "merged"\` keeps the ticket Blocked until every ticket in its \`after\` has merged, then starts it on the default branch. Choose this when the work needs the blocker's change live rather than in a diff: fleet state, a deployed or released package, a published artifact, or anything a worker checks on the running system.
- When a plan says "wait until X merges", set \`"wait": "merged"\`, or the board contradicts the plan.
- Tickets of one repository whose work touches the same area, directly or through a shared module, must be ordered in \`${ORDER_FILE}\` with \`after\`, so the later one stacks on or waits for the earlier one. The board holds back a run whose paths overlap a run already in progress, so this order is what keeps them in turn.
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${runDir}/${OUTCOME_FILE}\` as the last thing you do, after every plan, question and \`${ORDER_FILE}\`, with exactly one of:

\`\`\`json
{ "kind": "planned" }
{ "kind": "needs-human", "reason": "<the question only a person can answer, and why the evidence does not settle it>" }
\`\`\`

Write \`planned\` once every ticket has its plan files or its \`${QUESTION_FILE}\`. A \`needs-human\` outcome hands every ticket of the batch back to a person, so write it only when no ticket can be planned without one. A person may answer you here after a \`needs-human\` outcome. If one does, finish the plans with what they said, and write the outcome file again as the last thing you do.
`;
}

/**
 * What every plan says of the paths its work touches, in a `## Paths` section the board reads (`overlap.ts`): the board holds back a ticket whose
 * paths overlap a run in progress, so the list must be complete.
 */
const PATHS_RULE = "Each plan file ends with a `## Paths` section listing every file or directory its work will change, one bullet each, as `- \`<repo>:<path>\``: `<repo>` is one of the repository names above, and a path ending in `/` names a directory. The board holds back another ticket whose work touches the same paths, so list every path the work changes, and no more.";

/**
 * Step 5 of the brief, the commit. With the machine's pre-PR review skill named, the review runs after the commit, on the whole diff, before a push or a
 * pull request, and again after each commit of a fix: the hook gates a push on a review since the last commit, so this is the order it allows (A11-86).
 */
function commitStep(prReview: string | null): string {
  if (prReview === null) return "5. Commit with a conventional commit message.";
  return `5. Commit with a conventional commit message. Then, BEFORE you push or open a pull request, review your whole diff: call the Skill tool with \`${prReview}\` on \`git diff <the repository's default branch>...HEAD\` and anything uncommitted. Fix every finding, re-run the repository's tests, typecheck and lint, and commit the fixes. The hook refuses a push or a pull request until the skill has run since your last commit, so after you commit fixes run it again. Stop when a run finds nothing to change.`;
}

/**
 * Step 6 of the brief: how the worker opens its pull requests, as a draft (the default) or ready for review (`tickets.drafts: false`). The command is
 * `pr:open`, which checks the body and the diff against the ticket before it sends anything (A11-74); `gh pr create` is not used. The body names the
 * ticket with the tracker's closing keyword when the pull request completes it, and with its non-closing one, plus a `Partial:` line, when it is partial
 * (A11-92): the tracker closes a ticket on a merge only for the first.
 */
function openPullRequestStep(drafts: boolean, ticket: Ticket, prOpenCommand: string, prReview: string | null, { closing, nonClosing }: Keywords): string {
  const reviewLine = prReview === null ? "" : `carries the line \`Pre-PR review: ${prReview} ran on the whole diff; it changed: <what, or nothing>\`, `;
  return `6. Push the branch and open ONE ${drafts ? "DRAFT" : "READY"} pull request per repository you changed: write its body to a file, then run \`${prOpenCommand} create${drafts ? " --draft" : ""} --title "<type>(<scope>): <what changed>" --body-file <file>\`. The body links ${ticket.url}, and names the ticket \`${closing} ${ticket.key}\` when this pull request completes it (its done-when is fully met), so the tracker closes the ticket when it merges. When the pull request is partial and leaves part of the ticket to do, it names the ticket \`${nonClosing} ${ticket.key}\` instead, with a \`Partial: <what remains>\` line, and the ticket stays open; a pull request that completes the ticket is never written with \`${nonClosing}\`. The body says what changed and how you verified it, ${reviewLine}and, when the change is visible, shows it: take screenshots with what this machine provides (see "On this machine" when there is such a section), or else end the body with "Screenshot pending". It carries an \`Outside-Region: <path> — <reason>\` line for each path outside the plan's \`## Region\`, and either a changeset or a \`no-release: <reason>\` line. A pull request that needs another repository's unmerged one says so in its body. If \`pr:open\` refuses, fix what it names and run it again. Exit code 3 means the pull request exists: do not run it again, and run only the step its message names.`;
}

/**
 * The planner's instruction for the `## Region` section a plan ends with, which `pr:open` reads to check each pull request's diff (A11-74). A plan without
 * one is still accepted: `pr:open` says the Region was not checked.
 */
function regionInstruction(clones: Readonly<Record<string, string>>): string {
  return `End each plan with a \`## Region\` section listing every path the work will change, one per line, inside a fenced code block. When the work spans more than one repository, prefix each path with \`<repo>:\`, the repository's name among the host file's \`clones\` (${cloneNames(clones)}).`;
}

/**
 * The brief, as markdown. `worktreeCommand` is the full command line that makes a worktree, short of the repository's name, and `prOpenCommand` the one
 * that opens a pull request (`pr:open`). `notes` is the host
 * file's `tickets.brief`, how workers behave on this machine, and `connectors` its `tickets.connectors`. `blockers` are the tickets this one
 * waited on, and `stackedOn` the ones it starts on top of. `drafts` false (`tickets.drafts`) has the worker open its pull requests ready for review.
 * `prReview` is the skill `tickets.prReview` names, which the worker runs on its whole diff before any push or pull request, or null for none.
 * `keywords` are the two words the tracker reads a pull request's body by (`source.ts`), which the brief names; a source without its own gets the defaults.
 */
export function briefText({ ticket, folder, ticketDir, attachments, parent = null, blockers = [], stackedOn = [], clones, worktreeCommand, prOpenCommand, notes,
  connectors = [], planned = false, drafts = true, prReview = null, keywords = DEFAULT_KEYWORDS }: {
  ticket: Ticket; folder: string; ticketDir: string; attachments: readonly string[]; parent?: ParentTicket | null; blockers?: readonly Blocker[];
  stackedOn?: readonly StackBase[]; clones: Readonly<Record<string, string>>; worktreeCommand: string; prOpenCommand: string; notes?: string;
  connectors?: readonly string[]; planned?: boolean; drafts?: boolean; prReview?: string | null; keywords?: Keywords;
}): string {
  const stacked = new Set(stackedOn.map(({ key }) => key));
  const repos = Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");
  return `# ${ticket.key}: ${ticket.title}

You are an unattended worker. Nobody will answer a question, so decide, do the work, and end by writing the outcome file below.

## The ticket

${ticket.url}

${ticket.description.trim() || "(no description)"}

## Files from the ticket

${filesText(attachments)}
${parentText(parent)}${blockersText(blockers.filter(({ key }) => !stacked.has(key)))}${stackText(stackedOn, worktreeCommand)}
## Where the work lands: you decide

You are in this ticket's own folder, \`${folder}\`. These are the repositories on this machine, checked out by the person you work for. Read them, but never commit or change branches in them:

${repos}

1. From the ticket, decide which repository the fix belongs in. A ticket may name a repository that has since been retired or moved into another one: check where the code lives now, and use that. If the fix belongs in none of these (a backend service, a plugin, another team's code), change nothing and write a \`wrong-repo\` outcome naming where it belongs.
2. Make your worktree there with \`${worktreeCommand} <repo>\`. It creates \`${folder}/<repo>\` on the ticket's branch \`${ticket.branch}\`, from the repository's default branch, and on a retry it gives you back the one an earlier run made: continue from its commits rather than starting again. Run it once per repository you change; most tickets need one.
3. Work, commit and push only inside those worktrees. Read each repository's \`CLAUDE.md\` and \`AGENTS.md\` before you change anything, and use the install, test, typecheck and lint commands they give, scoped to the package you change.

## What to do

${plannedText(planned)}1. Find the cause in the code. Fix it, with a test that fails without the fix.
2. Run the repository's checks on what you changed. Then start a subagent that has not seen your reasoning, give it your diff and its base, and ask it to find, read only, every behaviour your diff changes that you meant to keep. Fix each real finding with a test that fails without the fix.${prReview === null ? " Then run the clean-code-review skill on your diff and fix what it finds." : ""}
3. Check your diff against what was asked. List each acceptance criterion in the ticket. Add each decision in its files, its parent's description and its parent's files that applies to this ticket. Find where your diff meets each one, and finish any it misses. If you leave one unmet on purpose, say which and why in the pull request body.
4. Check what your pull request body will claim. For each behaviour it says you fixed, kept or changed, name the test assertion that checks exactly that behaviour, not a neighbouring value. Run it on the base: a fix must fail there, and a kept behaviour must pass there too. Claim nothing you have no such assertion for, or say it is unchecked.
${commitStep(prReview)}
${openPullRequestStep(drafts, ticket, prOpenCommand, prReview, keywords)}
7. If a design gate asks for a design check, decline it with "unattended worker, no design tool access" and say so in the pull request body.

Never mark a pull request ready, request a review, merge, force-push, run a workflow, or post to Slack. Those are the person's.

${MISSING_SKILL}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "${drafts ? "draft-pr" : "ready-pr"}", "prs": [{ "repo": "<repo>", "url": "<pull request url>" }] }
{ "kind": "wrong-repo", "where": "<the repository or service the fix belongs in, and why>" }
{ "kind": "checked", "reason": "<what you checked, what you found, and why nothing needs to change>" }
{ "kind": "needs-human", "reason": "<what a person must decide or provide>" }
{ "kind": "working", "reason": "<what of yours is still running in the background, and what you do when it wakes you>" }
\`\`\`

A partial pull request adds \`"partial": "<what remains>"\` to its \`${drafts ? "draft-pr" : "ready-pr"}\` line, the same words as its body's \`Partial:\` line, so the board leaves the ticket open when it merges. A pull request that completes the ticket has no \`partial\`.

${CHECKED_OR_NEEDS_HUMAN}

${WORKING_OR_NEEDS_HUMAN}

A person may answer you here after a \`needs-human\` or \`wrong-repo\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}

/**
 * A review run's brief, as markdown: the person approved `prs`, so mark each ready, see it through its checks and its review, and fix what they
 * find. `reviewNotes` is the host file's `tickets.review`, how this machine's pull requests are checked and reviewed, and `notes` its
 * `tickets.brief`. `resumed` is true when the worker is the one that wrote the code, resumed with its own conversation. `feedback` is set on a
 * round the board started on its own: the new feedback on the pull requests, which are ready already, that the round answers. `asked` is set
 * on a round a person asked for with Respond to review: it answers the ready pull requests' current feedback. `prReview` is the skill `tickets.prReview`
 * names, which each round runs on its whole diff before it pushes, or null for none.
 */
export function reviewBriefText({ ticket, folder, ticketDir, prs, notes, reviewNotes, connectors = [], resumed, feedback, asked = false, prReview = null }: {
  ticket: Ticket; folder: string; ticketDir: string; prs: readonly PullRequest[]; notes?: string; reviewNotes?: string;
  connectors?: readonly string[]; resumed: boolean; feedback?: string; asked?: boolean; prReview?: string | null;
}): string {
  const list = prs.map(({ repo, url }) => `- ${url}, worked in \`${folder}/${repo}\``).join("\n");
  const who = resumed
    ? "You wrote these pull requests earlier in this conversation."
    : "Another worker wrote these pull requests, and its conversation could not be found: read each pull request's diff and the ticket before you change anything.";
  const round = asked ? answerRound(who, "A person asked you to answer the current feedback on your pull requests: their reviews, comments and failing checks.", null, prReview)
    : feedback === undefined ? approvedRound(who, prReview)
    : answerRound(who, `New feedback reached your pull requests after your last round, so the board started this round to answer it.\n\nThis started the round:\n\n${quoted(feedback)}`,
      CONFLICT_LINE.test(feedback) ? MERGE_FIRST : null, prReview);
  return `# ${ticket.key}: ${round.title} for ${ticket.title}

${round.opening}

## The ticket

${ticket.url}

## The pull requests

${list}

## What to do

${round.steps}

${FOREGROUND_WAIT}

## When no check has started

${CHECKS_NOT_STARTED}

Never merge, approve, request a review, force-push, run a workflow, or post to Slack. Those are the person's.

${MISSING_SKILL}
${connectorsText(connectors)}${reviewNotes?.trim() ? `\n## How this machine reviews\n\n${reviewNotes.trim()}\n` : ""}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "reviewed" }
{ "kind": "needs-human", "reason": "<what a person must decide or provide>" }
\`\`\`

${round.reviewed} A person may answer you here after a \`needs-human\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}

type Round = Readonly<{ title: string; opening: string; steps: string; reviewed: string }>;

/** The round a person started by approving the draft pull requests: mark them ready, then see them through their checks and review. */
function approvedRound(who: string, prReview: string | null): Round {
  const wait = REVIEW_WAIT_MINUTES;
  return {
    title: "review round",
    opening: `A person reviewed your draft pull requests and approved them. ${who} You are unattended again: nobody will answer a question, so decide, do the work, and end by writing the outcome file below.`,
    steps: `If a pull request conflicts with its base branch (\`gh pr view <its url> --json mergeable,mergeStateStatus\` says CONFLICTING or DIRTY), merge the base into your branch first, as step 1 of a feedback round says: never rebase, and never force-push.

1. Mark each pull request ready with \`gh pr ready <url>\`.
2. Wait for each one's checks and its review, as "How this machine reviews" says. Wait at most ${wait} minutes for each. If a check or the review has not finished by then, write a \`needs-human\` outcome that names what you waited for.
3. Read every review comment and every failed check. Fix each real finding in the worktree, with a test that fails without the fix where the finding is about behaviour. A finding you judge wrong is not fixed: say why in your reply instead. Run the repository's checks on what you changed.
4. ${roundPushStep(prReview)}
5. Reply on each pull request with one comment: each finding, and what you did about it.
6. Wait at most ${wait} minutes for the checks on the commit you pushed. If one fails, fix it, push, and wait again. Do not wait for a second review: the board starts another round when new feedback comes.`,
    reviewed: "Write `reviewed` only when every pull request is ready, every finding is answered, and every check passed on its last commit.",
  };
}

/**
 * The step a round takes first when the feedback names a pull request that conflicts with its base: merge the base in, never rebase. A round the
 * feedback names no conflict in gets no such step, so its brief is what it was.
 */
const MERGE_FIRST = "The feedback above says a pull request conflicts with its base branch. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin/<base>` in the worktree of each such pull request. Never rebase, and never force-push. Resolve each conflict keeping both changes' intent, run the repository's own tests, typecheck and lint, and push. Say in your reply on that pull request which files conflicted and how each was resolved.";

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
    "Fix each finding that is right in the worktree, with a test that fails without the fix where the finding is about behaviour. A finding you judge wrong is not fixed: answer it with the evidence instead. Run the repository's checks on what you changed.",
    roundPushStep(prReview),
    "Reply on each pull request with one comment: each finding, and what you did about it.",
    `Wait at most ${wait} minutes for the checks on the commit you pushed. If one fails, fix it, push, and wait again.`,
  ];
  return {
    title: "feedback round",
    opening: [`${first} ${who} You are unattended: nobody will answer a question, so decide, do the work, and end by writing the outcome file below.`, ...rest].join("\n\n"),
    steps: (merge === null ? items : [merge, ...items]).map((item, index) => `${index + 1}. ${item}`).join("\n"),
    reviewed: "Write `reviewed` only when every finding is answered and every check passed on the last commit you pushed.",
  };
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

## The files you write

Write \`${dir}/${PUBLISHED_FILE}\` once the messages are posted, with the web address of each message you posted:

\`\`\`json
{ "links": ["<message url>"] }
\`\`\`

Then write \`${dir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "published" }
{ "kind": "needs-human", "reason": "<what stopped you posting, and what was posted already>" }
\`\`\`
`;
}

/** The hook command a settings file names: this tool's `ticket:hook`, by absolute path, so it runs without the tool on `PATH`. */
export type HookCommand = Readonly<{ node: string; bin: string }>;

/**
 * The ticket folder's `.claude/settings.local.json`. `readDirs` are the person's repositories, which the worker reads but never changes.
 * `plugins` are enabled here because a worker starts in the ticket's folder, where no project settings of the person's apply.
 */
export function workerSettings({ model, ticketDir, readDirs, hook, plugins = [] }: {
  model: string; ticketDir: string; readDirs: readonly string[]; hook: HookCommand; plugins?: readonly string[];
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
