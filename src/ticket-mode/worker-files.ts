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
import type { DenyRule } from "./settings.ts";
import type { Blocker, Ticket } from "./source.ts";

/** The file a worker writes last, and the one thing the pool and the stop hook read to know a run has ended. */
export const OUTCOME_FILE = "outcome.json";
/** Where a parked run's outcome is moved when a person answers its agent, so the stop hook asks for a new one. */
export const PREVIOUS_OUTCOME_FILE = "outcome.prev.json";
export const BRIEF_FILE = "brief.md";
/** The stop hook's count of refused stops in a row, beside the outcome file. */
export const STOP_COUNT_FILE = "stop-refusals";
/** The host file's `tickets.deny`, copied beside the outcome file, where the PreToolUse hook reads it. */
export const DENY_FILE = "deny.json";
/** The host file's `tickets.connectors`, copied beside the outcome file, where the PreToolUse hook reads it. */
export const CONNECTORS_FILE = "connectors.json";

/** The folder in the ticket's own directory that a planning run writes its plan's files in, for the board to attach. */
export const PLAN_DIR = "plan";

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
  const quoted = (ticket.description.trim() || "(no description)").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  return `
## The parent ticket

${ticket.key}: ${ticket.title}

${ticket.url}

Your ticket is one part of ${ticket.key}, and its description covers every part. Do only your ticket's part, and follow each decision of the parent's that applies to it.

${quoted}

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

/** What a worker is told about a plan a planning run wrote, which no person agreed: nothing when a person's plan, or none, is all it has. */
function plannedText(planned: boolean): string {
  if (!planned) return "";
  return "Your plan was written by an unattended planning run, not agreed with a person. Put each decision it says it made without a person in your pull request body, under the heading \"Decisions made without a person\", so the reviewer checks each one against the code.\n\n";
}

/**
 * The planning run's brief, as markdown: plan the ticket with this machine's planner, change no code, and leave the plan's files in `planDir`
 * for the board to attach. `run` is the host file's `tickets.planner.run`, with the ticket and the folder filled in.
 */
export function planBriefText({ ticket, ticketDir, planDir, attachments, parent = null, clones, run, notes, connectors = [] }: {
  ticket: Ticket; ticketDir: string; planDir: string; attachments: readonly string[]; parent?: ParentTicket | null;
  clones: Readonly<Record<string, string>>; run: string; notes?: string; connectors?: readonly string[];
}): string {
  const repos = Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");
  const instruction = run.replaceAll("{key}", ticket.key).replaceAll("{dir}", planDir);
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

The plan's files go in \`${planDir}\`, and nowhere else. The board attaches each one to the ticket under its file name. Write only markdown files there, each 1 MB or less: anything else stops the board attaching any of them.
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

/**
 * The brief, as markdown. `worktreeCommand` is the full command line that makes a worktree, short of the repository's name. `notes` is the host
 * file's `tickets.brief`, how workers behave on this machine, and `connectors` its `tickets.connectors`. `blockers` are the tickets this one
 * waited on.
 */
export function briefText({ ticket, folder, ticketDir, attachments, parent = null, blockers = [], clones, worktreeCommand, notes, connectors = [], planned = false }: {
  ticket: Ticket; folder: string; ticketDir: string; attachments: readonly string[]; parent?: ParentTicket | null; blockers?: readonly Blocker[];
  clones: Readonly<Record<string, string>>; worktreeCommand: string; notes?: string; connectors?: readonly string[]; planned?: boolean;
}): string {
  const repos = Object.entries(clones).map(([name, path]) => `- \`${name}\` at \`${path}\``).join("\n");
  return `# ${ticket.key}: ${ticket.title}

You are an unattended worker. Nobody will answer a question, so decide, do the work, and end by writing the outcome file below.

## The ticket

${ticket.url}

${ticket.description.trim() || "(no description)"}

## Files from the ticket

${filesText(attachments)}
${parentText(parent)}${blockersText(blockers)}
## Where the work lands: you decide

You are in this ticket's own folder, \`${folder}\`. These are the repositories on this machine, checked out by the person you work for. Read them, but never commit or change branches in them:

${repos}

1. From the ticket, decide which repository the fix belongs in. A ticket may name a repository that has since been retired or moved into another one: check where the code lives now, and use that. If the fix belongs in none of these (a backend service, a plugin, another team's code), change nothing and write a \`wrong-repo\` outcome naming where it belongs.
2. Make your worktree there with \`${worktreeCommand} <repo>\`. It creates \`${folder}/<repo>\` on the ticket's branch \`${ticket.branch}\`, from the repository's default branch, and on a retry it gives you back the one an earlier run made: continue from its commits rather than starting again. Run it once per repository you change; most tickets need one.
3. Work, commit and push only inside those worktrees. Read each repository's \`CLAUDE.md\` and \`AGENTS.md\` before you change anything, and use the install, test and typecheck commands they give, scoped to the package you change.

## What to do

${plannedText(planned)}1. Find the cause in the code. Fix it, with a test that fails without the fix.
2. Run the repository's checks on what you changed. Then start a subagent that has not seen your reasoning, give it your diff and its base, and ask it to find, read only, every behaviour your diff changes that you meant to keep. Fix each real finding with a test that fails without the fix. Then run the clean-code-review skill on your diff and fix what it finds.
3. Check your diff against what was asked. List each acceptance criterion in the ticket. Add each decision in its files, its parent's description and its parent's files that applies to this ticket. Find where your diff meets each one, and finish any it misses. If you leave one unmet on purpose, say which and why in the pull request body.
4. Check what your pull request body will claim. For each behaviour it says you fixed, kept or changed, name the test assertion that checks exactly that behaviour, not a neighbouring value. Run it on the base: a fix must fail there, and a kept behaviour must pass there too. Claim nothing you have no such assertion for, or say it is unchecked.
5. Commit with a conventional commit message.
6. Push the branch and open ONE DRAFT pull request per repository you changed: \`gh pr create --draft\`, titled \`<type>(<scope>): <what changed>\`. The body links ${ticket.url}, says what changed and how you verified it, and, when the change is visible, shows it: take screenshots with what this machine provides (see "On this machine" when there is such a section), or else end the body with "Screenshot pending". A pull request that needs another repository's unmerged one says so in its body.
7. If a design gate asks for a design check, decline it with "unattended worker, no design tool access" and say so in the pull request body.

Never mark a pull request ready, request a review, merge, force-push, run a workflow, or post to Slack. Those are the person's.
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "draft-pr", "prs": [{ "repo": "<repo>", "url": "<pull request url>" }] }
{ "kind": "wrong-repo", "where": "<the repository or service the fix belongs in, and why>" }
{ "kind": "needs-human", "reason": "<what a person must decide or provide>" }
\`\`\`

A person may answer you here after a \`needs-human\` or \`wrong-repo\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
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

/** The flags after the first prompt. `--disallowedTools` is last, so a list never swallows a flag after it (`wake.ts`'s seat flags say why). */
export function workerFlags({ name, model, effort, addDirs }: { name: string; model: string; effort: string; addDirs: readonly string[] }): string[] {
  return ["--model", model, "--effort", effort, "--name", name, ...addDirs.flatMap((dir) => ["--add-dir", dir]),
    "--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"];
}

/** The first prompt: a pointer to the brief, short enough that no quoting or argument limit can cut it. */
export function firstPrompt(ticketDir: string): string {
  return `Read ${ticketDir}/${BRIEF_FILE} and follow it.`;
}
