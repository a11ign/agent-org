// no-token: gh -- pure builders
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCALATION_RULE } from "./escalation.ts";
import { MOVE_RULE } from "./after-merge-move.ts";
import { outcomeExamples } from "./outcome.ts";
import type { WriterForm, WriterMode } from "./queue/queue-entries-and-outcomes.ts";
import { CONFLICT_LINE, batchPlanBriefText, briefText, conflictLine, conflictsIn, firstPrompt, planBriefText, publishBriefText, reviewBriefText, reviewPrompt, workerFlags, workerSettings, writerBriefText, writerPrompt } from "./worker-files.ts";
import type { Blocker, Ticket } from "./source.ts";
import { ticketReadOf } from "./ticket-read.ts";
import { diffText } from "./brief-ticket-text.ts";
import { FAKE_TRACKER_WRITING } from "../plugins/fakes/tracker.ts";

const ticket = { key: "NBF-1270", title: "Refresh Data gives no feedback", description: "Clicking does nothing visible.", url: "https://linear.app/x/issue/NBF-1270",
  branch: "nbf-1270-refresh", status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 3, parent: "NBF-1200" } as Ticket;
const clones = { "nbl-ui-netbox": "/work/nbl-ui-netbox", "nbl-ui-platform-libs": "/work/nbl-ui-platform-libs" };

test("the brief carries the ticket, every repository to choose from, the worktree command, the draft rule and the outcome file's path", () => {
  const brief = briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: ["/state/tickets/NBF-1270/attachment-1.png"],
    clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  for (const part of [ticket.url, ticket.description, "`nbl-ui-netbox` at `/work/nbl-ui-netbox`", "`nbl-ui-platform-libs` at `/work/nbl-ui-platform-libs`",
    "/node /tool/src/bin.ts ticket:worktree <repo>", "/work/.tickets/NBF-1270/<repo>", "nbf-1270-refresh", "never commit or change branches in them",
    "/node /tool/src/bin.ts pr:open create --draft", "/state/tickets/NBF-1270/outcome.json", "attachment-1.png", "wrong-repo", "needs-human", "CLAUDE.md"]) {
    assert.ok(brief.includes(part), `the brief names ${part}`);
  }
});

test("a parent's description is quoted under its own heading, with its files, and a ticket without one has no such section", () => {
  const parentTicket = { ...ticket, key: "NBF-1200", title: "Feedback across the app", url: "https://linear.app/x/issue/NBF-1200",
    description: "Every button gives feedback.\n\n## Acceptance criteria\n\n- [ ] every app", parent: null } as Ticket;
  const brief = (parent?: { ticket: Ticket; attachments: string[] }) =>
    briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], parent, clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const withParent = brief({ ticket: parentTicket, attachments: ["/d/parent/attachment-1-NBF-1200-0001-plan.md"] });
  for (const part of ["## The parent ticket\n\nNBF-1200: Feedback across the app", "https://linear.app/x/issue/NBF-1200", "Do only your ticket's part",
    "> Every button gives feedback.\n>\n> ## Acceptance criteria\n>\n> - [ ] every app", "### Files from NBF-1200", "`/d/parent/attachment-1-NBF-1200-0001-plan.md`"]) {
    assert.ok(withParent.includes(part), `the brief carries ${part}`);
  }
  assert.equal(withParent.match(/^## Acceptance criteria/m), null, "the parent's criteria never read as the worker's own");
  assert.equal(brief().includes("## The parent ticket"), false);
});

test("the ticket's files come with the order to read them first, and a ticket with none says so", () => {
  const brief = (attachments: string[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments, clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief(["/d/attachment-1-NBF-1270-0001-plan.md"]).includes(
    "## Files from the ticket\n\nRead every file here before you start. A plan among them is the agreed approach, so follow it.\n\n- `/d/attachment-1-NBF-1270-0001-plan.md`"));
  assert.ok(brief([]).includes("## Files from the ticket\n\nNone.\n"));
});

test("before it commits, a fresh subagent reviews the diff for changed behaviour, and every claim in the body has an assertion run on the base", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const commit = brief.indexOf("Commit with a conventional commit message");
  const review = brief.indexOf("start a subagent that has not seen your reasoning");
  const claims = brief.indexOf("Check what your pull request body will claim.");
  assert.ok(review > 0 && review < commit, "the review comes before the commit");
  assert.ok(review < brief.indexOf("run the clean-code-review skill"), "behaviour first, then structure");
  assert.ok(claims > 0 && claims < commit);
  for (const part of ["read only", "give it your diff and its base", "a test that fails without the fix", "not a neighbouring value", "Run it on the base", "a fix must fail there", "a kept behaviour must pass there too", "say it is unchecked"]) {
    assert.ok(brief.includes(part), `the brief says ${part}`);
  }
  assert.match(brief, /\n5\. Commit with a conventional commit message\.\n6\. Push the branch/, "the steps stay numbered in order");
});

test("the worker checks its diff against every criterion and binding decision before it commits", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const check = brief.indexOf("Check your diff against what was asked.");
  assert.ok(check > 0, "the brief has the check");
  assert.ok(check < brief.indexOf("Commit with a conventional commit message"), "it comes before the commit, so what it finds is fixed in it");
  for (const part of ["each acceptance criterion in the ticket", "its parent's description and its parent's files", "say which and why in the pull request body"]) {
    assert.ok(brief.includes(part), `the check names ${part}`);
  }
});

test("the connectors a machine allows are named in the brief, and a machine that allows none adds no section", () => {
  const brief = (connectors?: string[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", connectors });
  assert.match(brief(["^mcp__claude_ai_Linear__(get|list)_"]), /## Connectors\n\nThis machine lets you call the connector tools whose names match `\^mcp__claude_ai_Linear__\(get\|list\)_`\. .*the tickets that block it/);
  assert.equal(brief().includes("## Connectors"), false);
  assert.equal(brief([]).includes("## Connectors"), false);
});

test("a ticket that waited names each blocker, its status and its pull requests, and one that waited on none has no such section", () => {
  const brief = (blockers?: { key: string; state: string; status: string; pulls: Record<string, "open" | "merged" | "closed"> }[]) =>
    briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers });
  const text = brief([{ key: "NBF-1944", state: "started", status: "In Review", pulls: { "https://github.com/o/libs/pull/8": "merged" } }, { key: "NBF-1", state: "completed", status: "Done", pulls: {} }]);
  assert.match(text, /- NBF-1944, In Review: https:\/\/github\.com\/o\/libs\/pull\/8 \(merged\)\n- NBF-1, Done: no pull request linked/);
  assert.match(text, /`gh release list --repo <owner>\/<repo>`/);
  assert.equal(brief().includes("## Tickets that blocked this one"), false);
  assert.equal(brief([]).includes("## Tickets that blocked this one"), false);
});

test("the machine's notes join the brief under their own heading, and a machine with none adds no heading", () => {
  const brief = (notes?: string) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", notes });
  assert.ok(brief("Start apps with `npm run dev:atomic`.\n").includes("## On this machine\n\nStart apps with `npm run dev:atomic`.\n\n## The outcome file"));
  assert.equal(brief().includes("## On this machine"), false);
  assert.equal(brief("  \n").includes("## On this machine"), false, "an empty notes file adds nothing");
});

test("a machine's plugins are enabled in the worker's own settings, and none are named when it has none", () => {
  const base = { model: "sonnet", ticketDir: "/d", readDirs: [], hook: { node: "/n", bin: "/b" } };
  assert.deepEqual((workerSettings({ ...base, plugins: ["nbl-ui@applied-ai"] }) as any).enabledPlugins, { "nbl-ui@applied-ai": true });
  assert.equal("enabledPlugins" in workerSettings(base), false);
});

test("the brief asks for screenshots of a visible change, with the machine's own tools or a stated gap", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.match(brief, /when the change is visible, shows it/);
  assert.match(brief, /"Screenshot pending"/);
  assert.equal(brief.includes("no browser"), false, "a worker may have one: the machine says how in its notes");
});

test("the settings file holds the permission mode, the model, the repositories to read and both hooks, by absolute path", () => {
  const settings = workerSettings({ model: "sonnet", ticketDir: "/state/tickets/NBF-1270", readDirs: Object.values(clones), hook: { node: "/usr/bin/node", bin: "/tool/src/bin.ts" } }) as any;
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.model, "sonnet", "a resumed session, which loses its flags, keeps its model");
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.deepEqual(settings.permissions.additionalDirectories, ["/state/tickets/NBF-1270", "/work/nbl-ui-netbox", "/work/nbl-ui-platform-libs"]);
  assert.deepEqual(settings.hooks.Stop[0].hooks[0], { type: "command", command: "/usr/bin/node", args: ["/tool/src/bin.ts", "ticket:hook", "stop", "/state/tickets/NBF-1270"], timeout: 30 });
  assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].args.slice(1, 3), ["ticket:hook", "pre-tool-use"]);
});

test("the flags end with --disallowedTools, so its list swallows no flag after it", () => {
  const flags = workerFlags({ name: "NBF-1270", model: "opus", effort: "high", addDirs: ["/a"] });
  assert.deepEqual(flags.slice(-2), ["--disallowedTools", "AskUserQuestion"]);
  assert.deepEqual(flags.slice(0, 6), ["--model", "opus", "--effort", "high", "--name", "NBF-1270"]);
  assert.equal(firstPrompt("/state/tickets/NBF-1270"), "Read /state/tickets/NBF-1270/brief.md and follow it.");
});

test("the brief tells the worker that a person may answer it after it hands the ticket back, and that it then writes a new outcome", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.match(brief, /A person may answer you here after a `needs-human` or `wrong-repo` outcome\. If one does, carry on with what they said, and write the outcome file again/);
});

test("a planning run is refused git's writes, a pull request and a worktree, and keeps git's reads", async () => {
  const { PLANNING_DENY } = await import("./worker-files.ts");
  const refused = (command: string) => PLANNING_DENY.some(({ pattern }) => new RegExp(pattern).test(command));
  for (const command of ["git commit -m x", "git -C /repos/a push origin b", "git --no-pager add .", "git -c core.x=y stash", "git checkout develop", "git rebase main",
    "gh pr create --draft", "gh pr edit 3", "node /tool/src/bin.ts ticket:worktree nbl-ui-netbox"]) assert.equal(refused(command), true, command);
  for (const command of ["git grep -n add", "git log --grep commit", "git show HEAD:src/a.ts", "git -C /repos/a fetch origin", "git diff origin/develop", "git branch -a", "gh pr view 12"]) {
    assert.equal(refused(command), false, command);
  }
});

test("both briefs tell a worker to stop for a person when a skill they name is missing, not to follow a copy of it", () => {
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  for (const brief of [work, plan, batch]) {
    assert.match(brief, /If a skill this brief names is not available in this session, write a `needs-human` outcome naming it, rather than following a copy of its files\./);
  }
});

test("A11-275: both planner briefs tell the planner to move a Before-merge line that needs a release, a person's machine or anything unreachable to After merge, and the worker's brief does not", () => {
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes(MOVE_RULE), "the rule, whole");
    assert.match(brief, /needs a published release, a person's own machine, or anything else a worker cannot reach cannot be met before merge/);
    assert.match(brief, /`## Moved to After merge`, one bullet per line/);
  }
  assert.ok(!work.includes(MOVE_RULE), "a worker is briefed with the ticket the board already rewrote");
});

test("A11-174, A11-209: every unattended brief says to guard variable paths with ${VAR:?}, and that its subagents inherit the rule", () => {
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  const review = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [], resumed: true });
  const publish = publishBriefText({ dir: "/d", prs: [], run: "r" });
  const writer = writerBriefText({ run: "write {request}", request: "a ticket", mode: "quick", placement: "auto", form: {}, clones: { a: "/a" }, dir: "/d", pickTeam: null, writing: FAKE_TRACKER_WRITING });
  const rule = "Claude Code still asks a person before some commands even with permissions bypassed, for example an `rm` on a path built from a variable that could be empty. Nobody answers on an unattended run. Always guard variable paths: `rm -rf \"${DIR:?}/x\"`, never `rm -rf $DIR/x`."
    + " The subagents you start inherit these rules, so tell them. Every delete names an explicit path guarded with `${VAR:?}`, never a bare `*` after `cd`.";
  for (const [name, brief] of Object.entries({ work, plan, batch, review, publish, writer })) assert.ok(brief.includes(`## Commands that stall an unattended run\n\n${rule}`), `${name} carries the rule, with no host notes passed`);
});

test("A11-171: a batch's brief tells its planner that a person may answer in the terminal, and to swap an answered ticket's QUESTION.md for its plan files", () => {
  const brief = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  assert.ok(brief.includes("A person may answer you here after a `needs-human` outcome, and after a `planned` one that leaves a `QUESTION.md`: the board keeps this terminal open for them."));
  assert.ok(brief.includes("once a person answers a ticket's question, replace that ticket's `QUESTION.md` with its plan files, and write the outcome file again as the last thing you do."));
});

test("A11-77: a batch's brief teaches the wait field: stacking for code that builds on the blocker's diff, merged for work that needs its change live", () => {
  const brief = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  for (const part of ["\"wait\": \"stacked\" or \"merged\"", "With no `wait`, or `\"stacked\"`, the ticket is stacked", "Choose this when the code builds on the blocker's diff.",
    "`\"wait\": \"merged\"` keeps the ticket Blocked until every ticket in its `after` has merged, then starts it on the default branch.",
    "Choose this when the work needs the blocker's change live rather than in a diff: fleet state, a deployed or released package, a published artifact",
    "When a plan says \"wait until X merges\", set `\"wait\": \"merged\"`, or the board contradicts the plan.",
    "and its worker starts only once they are done, or, where it stacks on one, on that one's branch."]) {
    assert.ok(brief.includes(part), part);
  }
});

test("a single planning run's brief fills {keys} with its one ticket, so a batch planner's instruction plans a ticket alone as before", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "unattended: plan {keys} into {dir}" });
  assert.ok(plan.includes("unattended: plan NBF-1270 into /d/plan"));
});

test("a batch's brief lists every ticket with its files and parent, fills {keys} and {dir}, and states the folder-per-ticket and order.json contract", () => {
  const other = { ...ticket, key: "NBF-1271", title: "Toast on refresh", description: "## Acceptance\nA toast shows.", url: "https://linear.app/x/issue/NBF-1271", parent: null } as Ticket;
  const parent = { ticket: { ...ticket, key: "NBF-1200", title: "Refresh epic", description: "Every refresh tells the person.", url: "https://linear.app/x/issue/NBF-1200" } as Ticket,
    attachments: ["/state/tickets/NBF-1270/parent/attachment-1-NBF-1200-0001-plan-epic.md"] };
  const brief = batchPlanBriefText({
    tickets: [{ ticket, attachments: ["/state/tickets/NBF-1270/attachment-1.png"], parent }, { ticket: other, attachments: [], parent: null }],
    runDir: "/state/tickets/batches/b1-0", planDir: "/state/tickets/batches/b1-0/plan", clones, run: "Run the planner: unattended: plan {keys} into {dir}",
    notes: "Use dev:atomic.", connectors: ["^mcp__claude_ai_Linear__get_"],
  });
  assert.match(brief, /^# Plan 2 tickets together: NBF-1270, NBF-1271\n/);
  assert.ok(brief.includes("Run the planner: unattended: plan NBF-1270, NBF-1271 into /state/tickets/batches/b1-0/plan"), "the keys comma-and-space separated, and the run's one folder");
  for (const part of ["## NBF-1270: Refresh Data gives no feedback\n\nhttps://linear.app/x/issue/NBF-1270\n\n> Clicking does nothing visible.",
    "- `/state/tickets/NBF-1270/attachment-1.png`", "### NBF-1270 is part of NBF-1200: Refresh epic", "> Every refresh tells the person.",
    "- `/state/tickets/NBF-1270/parent/attachment-1-NBF-1200-0001-plan-epic.md`", "## NBF-1271: Toast on refresh", "> ## Acceptance\n> A toast shows.",
    "### Files from NBF-1271\n\nNone.", "- `nbl-ui-netbox` at `/work/nbl-ui-netbox`", "## On this machine\n\nUse dev:atomic.", "## Connectors"]) {
    assert.ok(brief.includes(part), part);
  }
  assert.equal(brief.includes("NBF-1271 is part of"), false, "a ticket with no parent has no parent section");
  for (const part of ["`/state/tickets/batches/b1-0/plan/<KEY>/`", "a `QUESTION.md`", "`/state/tickets/batches/b1-0/plan/order.json`",
    "{ \"<KEY>\": { \"repo\": \"<repository>\", \"after\": [\"<KEY>\", ...], \"wait\": \"stacked\" or \"merged\" } }", "or `null` for a ticket with a question", "never the ticket itself, and make no cycle",
    "A question about one ticket does not stop the others", "Write `/state/tickets/batches/b1-0/outcome.json` as the last thing you do, after every plan, question and `order.json`",
    "{ \"kind\": \"planned\" }", "change no code"]) {
    assert.ok(brief.includes(part), part);
  }
});

test("a run stacked on its blockers is told to branch from one, link its pull request onto it, and say which, and they leave the waited-on list", () => {
  const draft = "https://github.com/o/nbl-ui-netbox/pull/12";
  const blockers: Blocker[] = [{ key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" as const } },
    { key: "NBF-5", state: "completed", status: "Done", pulls: {} }];
  const text = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }] });
  for (const part of ["## Stack on the work you wait for", "Each has its branch pushed to `nbl-ui-netbox`", `- NBF-1: ${draft}, on branch \`nbf-1-fit\``,
    "`node bin.ts ticket:worktree nbl-ui-netbox --from <branch>`", "`gh pr view <its pull request url> --json headRefName`", "or on the last one listed when the plan does not say",
    "`gh stack link <its pull request url> <your pull request url>`", "Run no other `gh stack` command", "which branch, and which pull request if there is one, yours is stacked on"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /This ticket waited until each of these was done:\n\n- NBF-5, Done: no pull request linked\n/, "only the blockers it waited for");
  assert.equal(briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" }).includes("## Stack on"), false);
});

test("A11-106: the stack section says pull request, not draft pull request, and tells a stacked worker to expect a stale base", () => {
  const draft = "https://github.com/o/nbl-ui-netbox/pull/12";
  const blockers: Blocker[] = [{ key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" as const } }];
  const text = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }] });
  assert.ok(text.includes("2. Open your pull request in place of the pull request step below, with its base set to that branch: `gh pr create --draft --base <branch>`."), "the step names the base, as a draft on a machine that keeps drafts");
  const ready = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }], drafts: false });
  assert.ok(ready.includes("with its base set to that branch: `gh pr create --base <branch>`, ready."), "and ready on one that does not");
  assert.equal(text.includes("draft pull request"), false, "no draft in the stack section");
  assert.ok(text.includes("6. Once the pull request yours is stacked on has merged, agent-org retargets yours to the default branch itself."), "the worker is told agent-org moves a stale base");
  assert.ok(text.includes("That is expected, not a failure: do not retarget, rebase, push or merge to fix it."), "and that a stale base is not a failure");
});

test("A11-248: a stacked worker is told agent-org merges the default branch into its pull request after the one below merged, and what a conflict round asks of it", () => {
  const draft = "https://github.com/o/nbl-ui-netbox/pull/12";
  const blockers: Blocker[] = [{ key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" as const } }];
  const text = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }] });
  assert.ok(text.includes("It then merges the default branch into yours. If that conflicts, you get a conflict round that names the pull request that merged: merge the default branch in, keep both changes, re-run the checks and push."));
});

test("A11-238: a stacked worker is told a stacked step needs no person to merge, that the arm bot merges it up to its own pull request, and never to unstack", () => {
  const draft = "https://github.com/o/nbl-ui-netbox/pull/12";
  const blockers: Blocker[] = [{ key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" as const } }];
  const options = { ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head: null }] };
  const text = briefText(options);
  assert.ok(text.includes("7. A stacked step needs no person to merge: once your pull request is approved, its required checks are green and the ones below it have merged, the arm bot merges it with GitHub's stack merge, up to yours and no further, and the board hands it back to the arm bot when needed."),
    "no person merges a stacked step, and the stack merge stops at the worker's own pull request");
  assert.ok(text.includes("Never unstack a stack, since another ticket builds on it: `gh stack unstack` is the person's, and the hook refuses it."), "a worker never unstacks");
  assert.ok(text.includes("Run no other `gh stack` command."), "item 3's rule stays");
  assert.equal(briefText({ ...options, stackedOn: undefined }).includes("A stacked step needs no person to merge"), false, "a worker with nothing stacked under it is told nothing of the stack merge");
});

test("A11-116: a stacked run whose blocker has no pull request yet is told its branch is pushed, branches from it, and never rebases it", () => {
  const head = "c".repeat(40);
  const blockers: Blocker[] = [{ key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1-fit", head, pulls: {} }];
  const text = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", blockers,
    stackedOn: [{ key: "NBF-1", url: null, repo: "nbl-ui-netbox", branch: "nbf-1-fit", head }] });
  assert.ok(text.includes("- NBF-1: its branch `nbf-1-fit` is pushed in `nbl-ui-netbox`; there is no pull request yet"), "the base is named by its pushed branch");
  assert.ok(text.includes("`node bin.ts ticket:worktree nbl-ui-netbox --from <branch>`"), "the worktree is made from the branch");
  assert.ok(text.includes("`git ls-remote origin <branch>`"), "the branch is checked on the remote when there is no pull request");
  assert.ok(text.includes("`gh pr create --draft --base <branch>`"), "the pull request is based on the branch");
  const named = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "p", repo: "agent-org" });
  assert.ok(named.includes("The ticket's project names `agent-org`, so its work lands there unless it belongs in another of these repositories"), "the project's repository is the default the worker is told");
  assert.equal(briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "p" }).includes("project names"), false, "no project repository, no line");
  assert.equal(text.includes("has an open pull request"), false, "it never says the base has an open pull request");
  assert.equal(text.includes("gh stack link <its pull request url>"), true, "the link is named for when both pull requests exist");
  assert.ok(text.includes("Never rebase it, merge it in, or force-push"), "the worker never rebases the branch it builds on");
  assert.ok(text.includes("agent-org merges that branch into yours for you after you stop"), "agent-org does the merge");
  assert.ok(text.includes("that round merges the branch in by hand"), "a conflict is the worker's to merge by hand");
});

const reviewed = [{ repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/806" }];
const review = (feedback?: string) => reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true,
  ...(feedback === undefined ? {} : { feedback }) });

test("a review round waits for checks in the foreground, each call under 10 minutes, and never ends its turn or a background task to wait", () => {
  for (const brief of [review(), review("New review feedback on https://github.com/x/nbl-ui-netbox/pull/806, the newest from alice.")]) {
    assert.ok(brief.includes("`gh pr checks <url> --watch --interval 30`"), "a blocking command that returns when the checks finish");
    assert.match(brief, /Keep each Bash call under 10 minutes, and run it again until what you wait for has finished or 30 minutes have passed\./);
    assert.match(brief, /Never end your turn to wait, and never wait with `run_in_background` or a background task/);
    assert.match(brief, /The one background wait the brief allows is a Monitor on a process you started detached \(with `nohup`, `&`, `setsid` or a unit\)/, "a detached process is waited on by a Monitor, the one background wait the brief allows");
  }
});

test("a round the board started on new feedback names it, marks nothing ready, and writes reviewed only with the last commit's checks passing", () => {
  const feedback = "New review feedback on https://github.com/x/nbl-ui-netbox/pull/806, the newest from alice.";
  const brief = review(feedback);
  assert.match(brief, /^# NBF-1270: feedback round for Refresh Data gives no feedback\n/);
  assert.ok(brief.includes(`> ${feedback}`), "what started the round, quoted");
  assert.match(brief, /do not run `gh pr ready`/);
  assert.equal(/1\. Mark each pull request ready/.test(brief), false);
  assert.match(brief, /Write `reviewed` only when every finding is answered and every check passed on the last commit you pushed\./);
  assert.match(review(), /1\. Mark each pull request ready with `gh pr ready <url>`\./, "POSITIVE CONTROL: a person's approval still marks them ready");
  assert.equal(reviewPrompt("/d", "feedback"), "New feedback reached this ticket's pull requests. Read /d/brief.md and follow it.");
  assert.equal(reviewPrompt("/d", "asked"), "A person asked you to answer the feedback on this ticket's pull requests. Read /d/brief.md and follow it.");
  assert.equal(reviewPrompt("/d"), "A person reviewed this ticket's pull requests and approved them. Read /d/brief.md and follow it.");
});

test("a publish run's brief fills in the pull requests one per line and its folder, and names the links file and the outcome it ends on", () => {
  const prs = [reviewed[0], { repo: "nbl-ui-platform", url: "https://github.com/x/nbl-ui-platform/pull/9" }];
  const brief = publishBriefText({ dir: "/state/tickets/publish/p1", prs, run: "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json" });
  assert.ok(brief.includes(`all in one go: ${prs[0].url}\n${prs[1].url}. Then write /state/tickets/publish/p1/published.json`));
  assert.ok(brief.includes('{ "links": ["<message url>"] }'));
  assert.ok(brief.includes("`/state/tickets/publish/p1/outcome.json`"));
  assert.ok(brief.includes('{ "kind": "published" }'));
});

test("a round a person asked for with Respond to review says so, answers the current feedback, and marks nothing ready", () => {
  const brief = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true });
  assert.match(brief, /^# NBF-1270: feedback round for /);
  assert.match(brief, /A person asked you to answer the current feedback on your pull requests: their reviews, comments and failing checks\. You wrote these/);
  assert.match(brief, /do not run `gh pr ready`/);
  assert.equal(brief.includes("the board started this round"), false);
});

// A11-125: the planner writes its paths once, in `## Paths`, which both the overlap wait and `pr:open` read, so no Region section is asked for.
test("A11-125: both planner briefs ask for the ## Paths section alone, and name the repositories its prefix may be", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a", b: "/b" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a", b: "/b" }, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.equal(brief.includes("## Region"), false, "no Region section is asked for: the Paths section is the one");
    assert.ok(brief.includes("`<repo>` is one of the repository names above"), "each path is prefixed with one of the repositories named above");
  }
});

test("a drafts-on brief opens a draft: step 6 runs pr:open with --draft, names the ticket's keys, and its outcome example is draft-pr", () => {
  const brief = briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes(`6. Push the branch and open ONE DRAFT pull request per repository you changed: write its body to a file, then run \`/node /tool/src/bin.ts pr:open create --draft --title "<type>(<scope>): <what changed>" --body-file <file>\`. The body links ${ticket.url}, and names the ticket \`Closes NBF-1270\` when this pull request completes it (its done-when is fully met), so the tracker closes the ticket when it merges.`), "A11-92: the closing keyword is asked for a completing pull request");
  assert.ok(brief.includes("`Outside-Region: <path> — <reason>`"), "a path outside the plan's Region is declared in the body");
  assert.equal(brief.includes("gh pr create"), false, "the brief no longer tells a worker to open its pull request with gh");
  assert.equal(brief, briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", drafts: true }), "an absent flag is the same as true");
  assert.ok(brief.includes(outcomeExamples(["draft-pr"])), "the outcome example is a concrete draft-pr");
  assert.equal(brief.includes("<pull request url>"), false, "no placeholder is left in the outcome example");
  assert.equal(brief.includes("ready-pr"), false);
});

test("A11-92: a brief asks for the tracker's closing keyword on a completing pull request, and the non-closing one with a Partial line only for a partial one", () => {
  const brief = briefWith();
  assert.ok(brief.includes("names the ticket `Closes NBF-1270` when this pull request completes it"), "a completing pull request is written with the closing keyword");
  assert.ok(brief.includes("When the pull request is partial and leaves part of the ticket to do, it names the ticket `Refs NBF-1270` instead, with a `Partial: <what remains>` line, and the ticket stays open"),
    "a partial pull request is written with the non-closing keyword and a Partial line");
  assert.ok(brief.includes("a pull request that completes the ticket is never written with `Refs`"), "the non-closing keyword is not for a completing pull request");
  assert.ok(brief.includes(outcomeExamples(["draft-pr"])), "the outcome example is the draft-pr one, concrete");
  assert.ok(brief.includes(`A partial pull request adds \`"partial": "<what remains>"\` to its \`draft-pr\` line`), "a partial pull request declares it in the outcome file");
});

test("A11-178: a brief tells a worker the tracker reads closing words anywhere in a body, so a partial body never quotes one next to its ticket's key, and names the words", () => {
  const brief = briefWith();
  assert.ok(brief.includes("The tracker also completes the ticket on merge when it reads any of `closes`, `close`, `closed`"), "the closing words are named, starting with the closing keyword");
  assert.ok(brief.includes("followed by a ticket key ANYWHERE in the body, code spans and quoted examples included, whatever else the body says: a partial body never writes one next to the ticket's key, even to quote it, "
    + "and describes the example in words instead (\"the closing keyword followed by the key\")."));
  const custom = briefWith({ keywords: { closing: "Resolves", nonClosing: "Relates" } });
  assert.ok(custom.includes("reads any of `resolves` followed by a ticket key ANYWHERE"), "a tracker that names no other closing word is briefed with its closing keyword alone");
});

test("A11-92: a source with its own keywords is briefed with them, and not with Closes and Refs", () => {
  const brief = briefWith({ keywords: { closing: "Resolves", nonClosing: "Relates" } });
  assert.ok(brief.includes("names the ticket `Resolves NBF-1270` when this pull request completes it"), "the source's closing word");
  assert.ok(brief.includes("it names the ticket `Relates NBF-1270` instead, with a `Partial: <what remains>` line"), "the source's non-closing word");
  assert.equal(brief.includes("Closes"), false, "not the default closing word");
  assert.equal(brief.includes("Refs"), false, "not the default non-closing word");
  assert.equal(briefWith().includes("Resolves"), false, "and the default brief names neither");
});

test("a drafts-off brief opens a ready pull request: its command has no --draft, and its outcome example is ready-pr", () => {
  const brief = briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", drafts: false });
  assert.ok(brief.includes("6. Push the branch and open ONE READY pull request per repository you changed: write its body to a file, then run `/node /tool/src/bin.ts pr:open create --title \"<type>(<scope>): <what changed>\" --body-file <file>`."));
  assert.equal(brief.includes("--draft"), false, "no draft anywhere in the brief");
  assert.ok(brief.includes(outcomeExamples(["ready-pr"])), "the outcome example is a concrete ready-pr");
  assert.equal(brief.includes("draft-pr"), false);
});

test("a worker may end on checked when nothing needs to change, and is told needs-human is only for an item on the escalation list", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes(outcomeExamples(["checked"])), "checked is one of the outcomes, with an example");
  assert.match(brief, /Write `checked` when you looked at what the ticket asks and nothing needs to change, but the ticket is \*\*not finished\*\*/);
  assert.match(brief, /the ticket is only a parent whose work is all in its child tickets \(name them, so the person queues them\)/);
  assert.match(brief, /Write `needs-human` only for an item on the escalation list, with its id in `escalation`/);
});

test("A11-91: the worker's brief says when to write done and when checked, lists done with its evidence, and lets it propose an edit to the ticket's text", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes(outcomeExamples(["done"])), "done is one of the outcomes, with its evidence in the example");
  assert.match(brief, /Write `done` only when no code and no pull request is needed and \*\*every Done-when item of the ticket is verified\*\*/, "done: every Done-when verified");
  assert.match(brief, /The `evidence` list has one line per Done-when item: what you ran or read, and what it showed/, "done: the evidence says what was seen");
  assert.match(brief, /A prediction is not evidence/, "done: a prediction never fills evidence");
  assert.match(brief, /Never write `done` for a ticket with open sub-issues, which complete it, and never after you opened a pull request/, "done: never for a parent, nor after a pull request");
  for (const [pattern, why] of [
    [/Write `checked` when you looked at what the ticket asks and nothing needs to change, but the ticket is \*\*not finished\*\*/, "checked: the ticket is not finished"],
    [/a Done-when item is not verifiable by you, or the ticket is only a parent whose work is all in its child tickets/, "checked: why it is not finished"],
    [/"edit": \{ "title": "<the title it should have>", "description": "<the whole description it should have>", "why": "<what is wrong, and what shows it>" \}/, "the edit field"],
    [/A ticket's own title or description may be what is wrong/, "when to propose an edit"],
  ] as const) assert.match(brief, pattern, why);
  assert.match(brief, /Propose an edit only to correct the text, never to narrow what the ticket asks/);
});

test("A11-91: the planning and review briefs neither list done nor propose an edit", () => {
  const planning = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  for (const brief of [planning, review()]) {
    assert.doesNotMatch(brief, /"kind": "done"/);
    assert.doesNotMatch(brief, /"edit"/);
  }
});

test("both planning briefs say a ticket that is only a parent gets a plan saying so, which suggests queueing its children instead", () => {
  const single = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/r", planDir: "/r/plan", clones, run: "plan {keys} into {dir}" });
  for (const brief of [single, batch]) {
    assert.ok(brief.includes("A ticket that is only a parent, an epic whose work is all in the tickets under it, gets no plan for a run of its own."));
    assert.ok(brief.includes("names the child tickets that hold its work, and suggests the person queues those children instead of a run on it."));
  }
});

test("A11-70: a batch's brief names the host file's clones keys as the only repositories order.json may name, or null", () => {
  const brief = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan",
    clones: { a11ign: "/repos/a11y-witness", "agent-org": "/repos/agent-org" }, run: "plan {keys} into {dir}" });
  for (const part of ["It must be exactly one of these names, which are the host file's `clones` keys: `a11ign`, `agent-org`.", "or `null` for a ticket with a question",
    "A name is not the folder its checkout sits in", "the board refuses any other name"]) {
    assert.ok(brief.includes(part), part);
  }
});

test("A11-80: a worker may end a turn on working only while its own background work runs and will wake it, and never to park a question", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes(outcomeExamples(["working"])), "working is one of the outcomes, with an example");
  for (const pattern of [
    /Otherwise, write `working` only while your own background work \(a background shell or a Monitor\) is genuinely still running and will wake you when it finishes/,
    /Never write `working` to park a question or to wait on a person: that is `needs-human`/,
    /write the outcome file again with how the run ended, or with `working` again if more of it is still running/,
  ]) assert.match(brief, pattern);
});

test("A11-236: the brief tells a worker to write the job and the time before a long wait, and says what the board does with them", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes("Before a long wait, write `{ \"kind\": \"working\", \"reason\": \"...\", \"waitingOn\": \"<what>\", \"until\": \"<ISO time>\" }`"), "the shape, as the ticket words it");
  assert.match(brief, /the board shows the run as waiting on background work until `until`, which is a time still ahead when you write it \(3 hours after you wrote the file when there is no `until`\), and prompts you once when `until` passes, then marks it stalled if you stay idle and write nothing newer, naming what it waited on/);
});

test("A11-245: the brief tells a worker to declare a wait on a fleet job, a CI run, a pull request or a ticket, end its turn, and write no wait loop", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes("\"waitingOn\": [ { \"fleetJob\": \"<id>\" } | { \"ciRun\": \"<owner/repo>#<runId>\" } | { \"pullRequest\": \"<url>\", \"until\": \"merged|reviewed\" } | { \"ticket\": \"<KEY>\", \"until\": \"done\" } ], \"until\": \"<ISO time>\" }` and END YOUR TURN"), "the shape, then end the turn");
  assert.match(brief, /The board reads each event itself and prompts you once, when all of them have finished or any has failed, saying what happened \(a job's state and results path, a run's conclusion\), and once more if `until` passes with some still pending/);
  assert.match(brief, /Never write a loop, a `sleep`, an `until` or `while` poll or a `pgrep -f` to wait for any of these/);
});

test("A11-85: the brief says how to wait on a process started detached: a Monitor on its PID or its log, never a bare claim of working", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.match(brief, /A process you started detached is not background work of yours until a Monitor holds it: it wakes nothing when it ends, so arm a Monitor on its PID or its log \(`until ! kill -0 <pid>; do sleep 5; done`\) before you write `working`/);
  assert.match(brief, /A `working` with no declared events and no shell or Monitor running is refused: nothing will wake you\./);
});

// A11-82: a pull request that conflicts with its base is merged first, and a planner says where its work lands and what paths it touches.
const conflicted = `New feedback reached your pull requests after your last round, so the board started this round to answer it.`;
const conflictFeedback = `${conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", "main")}`;

test("A11-82: a round whose feedback names a conflict merges the base in first, never rebases or force-pushes, keeps both changes, and numbers the feedback steps after it", () => {
  assert.equal(conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", "main"), "https://github.com/x/nbl-ui-netbox/pull/806 conflicts with its base branch main.");
  assert.equal(conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", null), "https://github.com/x/nbl-ui-netbox/pull/806 conflicts with its base branch unknown.");
  assert.equal(CONFLICT_LINE.test(conflictFeedback), true);
  const brief = review(conflictFeedback);
  assert.match(brief, /^1\. The text above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin\/<base>`/m);
  assert.match(brief, /Never rebase, and never force-push\. Resolve each conflict keeping both changes' intent, run the repository's own tests, typecheck and lint, and push\./);
  assert.match(brief, /Say in your reply on that pull request which files conflicted and how each was resolved\./);
  assert.match(brief, /^2\. Read that feedback/m);
  assert.match(brief, /^6\. Wait at most 30 minutes/m, "the wait step is last, after the merge");
  assert.ok(brief.includes(conflicted), "the round says what started it");
});

test("A11-82: a conflict-free feedback round has no merge step, and a Respond to review round keeps the brief it had", () => {
  // A11-89: every round says how to merge a CONFLICTING base in, in its "When no check has started" section; what this test pins is the numbered
  // merge step the feedback names, which only a conflict in the feedback adds.
  const plain = review("New review feedback on https://github.com/x/nbl-ui-netbox/pull/806, the newest from alice.");
  assert.equal(/^1\. The text above says a pull request conflicts/m.test(plain), false, "nothing conflicts, so no merge step leads the feedback steps");
  assert.match(plain, /^1\. Read that feedback/m);
  const asked = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true });
  assert.equal(/^1\. The text above says a pull request conflicts/m.test(asked), false, "a Respond to review round keeps the brief it had: no merge step is named unless the feedback names a conflict");
  assert.match(asked, /^1\. Read that feedback/m);
});

// A11-125: a Respond to review round on a run the board handed back at its cap for a conflict merges the base in first, as a feedback round does.
const MERGE_STEP = "1. The text above says a pull request conflicts with its base branch. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin/<base>` in the worktree of each such pull request. Never rebase, and never force-push. Resolve each conflict keeping both changes' intent, run the repository's own tests, typecheck and lint, and push. Say in your reply on that pull request which files conflicted and how each was resolved.";
test("A11-125: a Respond to review round on a run handed back for a conflict names the conflict it answers, and merges the base in first", () => {
  const handedBack = `The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped. Respond to review starts another. The latest: ${conflictFeedback}`;
  const conflict = conflictsIn(handedBack);
  assert.equal(conflict, conflictFeedback, "the conflict line is found in the handed-back text");
  const brief = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true, conflict: conflict ?? undefined });
  assert.ok(brief.includes(`The board handed this run back because:\n\n> ${conflictFeedback}`), "the round says why it was handed back, and quotes the conflict");
  assert.ok(brief.includes(MERGE_STEP), "the round merges the base in first, as a feedback round does");
  assert.match(brief, /^2\. Read that feedback/m);
});

test("A11-125: conflictsIn finds each conflict line a text names, keeps a base with dots, and is null for a text that names none", () => {
  const first = conflictLine("https://github.com/x/a/pull/1", "release/1.2");
  const second = conflictLine("https://github.com/x/b/pull/2", "main");
  assert.equal(conflictsIn(`The latest: ${first}\n${second}`), `https://github.com/x/a/pull/1 conflicts with its base branch release/1.2.\nhttps://github.com/x/b/pull/2 conflicts with its base branch main.`);
  assert.equal(conflictsIn("The latest: New review feedback on https://github.com/x/nbl-ui-netbox/pull/806, the newest from alice."), null);
});

test("A11-125: a Respond to review round on a pull request that does not conflict keeps the brief it has today", () => {
  const today = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true });
  const unnamed = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true, conflict: undefined });
  assert.equal(unnamed, today, "no conflict is the same brief as none given");
  assert.equal(today.includes("The board handed this run back because:"), false, "nothing is quoted");
  assert.equal(/^1\. The text above says a pull request conflicts/m.test(today), false, "no merge step leads the round");
});

test("A11-150: a Respond to review round whose merge of the blocker's branch conflicted says so and merges first; an approval round keeps its ready step", () => {
  const lines = "https://github.com/x/nbl-ui-netbox/pull/806 conflicts with its base branch nbf-1-fit.\nMerging NBF-1's branch `nbf-1-fit` conflicted in ticket.txt.";
  const asked = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true, feedback: lines });
  assert.match(asked, /The merge of the blocker's branch into yours conflicted:/);
  assert.match(asked, /^1\. The text above says a pull request conflicts with its base branch/m, "the merge step leads the round");
  assert.equal(asked.includes("The board handed this run back because:"), false, "it is not a cap hand-back");
  const approved = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true });
  assert.match(approved, /Mark each pull request ready with `gh pr ready <url>`/, "an approval round still marks the drafts ready");
  assert.equal(/^1\. The text above says a pull request conflicts/m.test(approved), false, "an approval round is not given the conflict lines");
});

test("A11-89: every review round tells the worker, when no check has started, to read the merge state first and to merge a conflicting base in", () => {
  const approved = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true });
  const asked = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true });
  for (const [why, brief] of [["approved", approved], ["feedback", review(conflictFeedback)], ["asked", asked]] as const) {
    assert.match(brief, /^## When no check has started$/m, why);
    assert.match(brief, /When no check has started on your head commit, run `gh pr view <url> --json mergeable,mergeStateStatus` for each pull request first, before you wait longer or do anything else\./, why);
    assert.match(brief, /GitHub runs no `pull_request` workflow on a pull request that conflicts with its base, so if it says CONFLICTING or DIRTY, merge the base branch in: `git fetch`, then `git merge origin\/<base>`/, why);
    assert.match(brief, /Never rebase, and never force-push\. Resolve each conflict keeping both changes' intent/, `${why}: never a rebase, and both changes kept`);
    assert.match(brief, /Never write `needs-human`, and never ask a person to re-run CI, for checks that did not start while the pull request is CONFLICTING or DIRTY\./, why);
    assert.match(brief, /Write `needs-human` for checks that did not start only when the pull request is mergeable and they still have not started after the wait\./, why);
  }
  assert.match(approved, /If a check or the review has not finished by then, write a `needs-human` outcome that names what you waited for\./, "the approved round's wait keeps its words");
});

test("A11-89: the first-run brief has no such section, since it never waits for checks", () => {
  const brief = briefWith();
  assert.equal(brief.includes("When no check has started"), false);
  assert.equal(brief.includes("mergeStateStatus"), false);
});

test("A11-82: the approved round tells the worker to merge a conflicting base in before it marks anything ready", () => {
  const brief = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true });
  assert.match(brief, /^If a pull request conflicts with its base branch \(`gh pr view <its url> --json mergeable,mergeStateStatus` says CONFLICTING or DIRTY\), merge the base into your branch first/m);
  assert.ok(brief.indexOf("merge the base into your branch first") < brief.indexOf("1. Mark each pull request ready"), "before step 1");
});

const PR_REVIEW = "a11ign:clean-code-review";
const briefWith = (over: Partial<Parameters<typeof briefText>[0]> = {}) => briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270",
  attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", drafts: true, ...over });

test("A11-86: with tickets.prReview named, the brief runs that skill on the whole diff after the last commit and before any push or pull request, and the body records it", () => {
  const brief = briefWith({ prReview: PR_REVIEW });
  const commit = brief.indexOf("5. Commit with a conventional commit message. Then, BEFORE you push or open a pull request, review your whole diff");
  assert.ok(commit > 0, "step 5 carries the review");
  assert.ok(brief.includes(`call the Skill tool with \`${PR_REVIEW}\` on \`git diff <the repository's default branch>...HEAD\` and anything uncommitted.`), "the skill, on the whole diff");
  assert.ok(brief.includes("Fix every finding, re-run the repository's tests, typecheck and lint, and commit the fixes."), "the tests, typecheck and lint are re-run after a fix");
  assert.ok(brief.includes("The hook refuses a push or a pull request until the skill has run since your last commit, so after you commit fixes run it again."), "the gate is named");
  assert.ok(brief.indexOf("6. Push the branch and open ONE DRAFT") > commit, "the pull request comes after the review");
  assert.ok(brief.includes(`carries the line \`Pre-PR review: ${PR_REVIEW} ran on the whole diff; it changed: <what, or nothing>\`, and, when the change is visible`), "the body records that the review ran");
  assert.equal(brief.includes("Then run the clean-code-review skill on your diff"), false, "step 2 no longer carries the old sentence: step 5 does");
});

test("A11-95: the brief asks for lint beside the install, test and typecheck, and a fix is re-linted before it is pushed (the pre-PR step and a round's push)", () => {
  const brief = briefWith({ prReview: PR_REVIEW });
  assert.ok(brief.includes("use the install, test, typecheck and lint commands they give"), "the install line names lint");
  assert.ok(brief.includes("re-run the repository's tests, typecheck and lint, and commit the fixes."), "step 5 re-runs lint after a fix");
  const round = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, prReview: PR_REVIEW });
  assert.ok(round.includes("fix every finding, re-run the repository's tests, typecheck and lint, and commit the fixes."), "a round re-runs lint after a fix");
  assert.equal(briefWith({ prReview: null }).includes("re-run the repository's tests, typecheck and lint"), false, "the step 5 sentence is the review's; with no review named, step 5 is the bare commit");
});

test("A11-86: with no pre-PR review named, the brief is today's, byte for byte, whether the argument is null or not passed", () => {
  const today = briefWith();
  assert.equal(briefWith({ prReview: null }), today);
  assert.equal(briefWith({ prReview: undefined }), today);
  assert.ok(today.includes("Then run the clean-code-review skill on your diff and fix what it finds."), "POSITIVE CONTROL: today's step 2 sentence stays");
  assert.ok(today.includes("\n5. Commit with a conventional commit message.\n6. Push the branch"), "today's step 5 stays");
  assert.equal(today.includes("Pre-PR review:"), false);
});

test("A11-86: every review round runs the skill on the whole diff before its push when named, and none when absent", () => {
  const rounds: [string, Partial<Parameters<typeof reviewBriefText>[0]>][] = [
    ["approved", {}],
    ["feedback", { feedback: "New review feedback on https://github.com/x/nbl-ui-netbox/pull/806, the newest from alice." }],
    ["asked", { asked: true }],
  ];
  for (const [name, over] of rounds) {
    const roundWith = (prReview?: string | null) => reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed,
      resumed: true, ...over, ...(prReview === undefined ? {} : { prReview }) });
    const named = roundWith(PR_REVIEW);
    assert.ok(named.includes(`BEFORE you push, review the whole diff of each pull request, base to head: call the Skill tool with \`${PR_REVIEW}\``), `${name} round: the review`);
    assert.ok(named.includes("The hook refuses a push until the skill has run since your last commit, so after you commit fixes run it again."), `${name} round: the gate`);
    assert.equal(named.includes("Commit with a conventional commit message, and push. Never force-push."), false, `${name} round: the push step is the review's`);
    const absent = roundWith();
    assert.equal(absent.includes("Skill tool"), false, `${name} round: no review when none is named`);
    assert.ok(absent.includes("Commit with a conventional commit message, and push. Never force-push."), `${name} round: today's push step`);
    assert.equal(roundWith(null), absent, `${name} round: null is absent`);
  }
});

test("A11-117: both planner briefs tell the planner not to list the scaffolding, which the board ignores and a pull request needs whatever the plan says", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes("Do not list `.acceptance/` or `.changeset/`: the board ignores them, and a pull request needs them whatever the plan says."));
  }
});

test("A11-82: both planner briefs tell the planner the ## Paths section, and a batch's brief also tells it to order a ticket after another only when it needs that ticket's code or both change one file (A11-212)", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes("Each plan file ends with a `## Paths` section listing every file or directory its work will change"), "the section");
    assert.ok(brief.includes("`- \`<repo>:<path>\``"), "its bullet form");
    assert.ok(brief.includes("That one section is what the board's overlap wait and `pr:open` both read"));
  }
  assert.match(batch, /Order a ticket after another only when it needs that ticket's code, or both must change the same file\. Tickets whose paths do not overlap get no `after` and run side by side/);
  assert.equal(plan.includes("order.json"), false, "a ticket planned alone writes no order");
});

/*
 * A new-ticket run's brief (A11-94, A11-135): the instruction, the request quoted, the choices as requirements and where each lands, the team, the
 * read-only tracker and the two tools a run files with, and what the run writes last. Both modes run the create-ticket skill in full (A11-135).
 */

const WRITER = { run: "Run the a11ign:create-ticket skill for this request: {request}.", clones: { "nbl-ui-netbox": "/r/netbox" } };
/** The brief a run of `mode` is given, for the request "x" with nothing else chosen and the team `A11` on the Pick view. */
const briefIn = (mode: WriterMode, pickTeam: string | null = "A11") => writerBriefText({ writing: FAKE_TRACKER_WRITING, ...WRITER, request: "x", mode, placement: "auto", form: {}, dir: "/d", pickTeam });
/** Each pattern is in the text: a brief is checked as one list of what it must say. */
const says = (text: string, patterns: readonly RegExp[]): void => {
  for (const pattern of patterns) assert.match(text, pattern);
};

test("A11-135: the brief tells a run to run the create-ticket skill in full, in both modes, and forbids no step of it", () => {
  // The README's example instruction is the one a host file starts from, so it is held to the same rule as the built-in one.
  const readme = "Run the a11ign:create-ticket skill, {mode}, for this request: {request}. Make the ticket and attach its plan.";
  for (const mode of ["quick", "grill"] as const) {
    for (const run of [WRITER.run, readme]) {
      const brief = writerBriefText({ writing: FAKE_TRACKER_WRITING, run, request: "x", mode, placement: "auto", form: {}, clones: {}, dir: "/d", pickTeam: "A11" });
      says(brief, [/Run the `a11ign:create-ticket` skill in full/, /call the tracker's create-or-update tool with an `id`/]);
      for (const banned of [/drafts only/i, /\bskip/i, /do not run the grill/i, /no plan/i, /create no ticket/i]) {
        assert.doesNotMatch(brief, banned, `${mode}: no instruction to skip a step (${banned})`);
      }
    }
  }
});

test("A11-135: the brief states that the run files its own ticket, with the tracker's tools, and that it makes no draft", () => {
  const brief = briefIn("quick");
  says(brief, [
    /You file the ticket yourself, through the tracker's tools/,
    /`mcp__fake__create_ticket`, with no `id`/,
    /`mcp__fake__prepare_upload` and `mcp__fake__attach_upload`, naming only a ticket this run created\. Use the `mcp__fake__` tools\./,
    /Never set `blocks`: it writes a relation on another ticket/,
    /If the instruction above mentions draft files, ignore that: this run writes no draft/,
  ]);
  assert.doesNotMatch(brief, /The draft files|drafts\//, "no draft format is given");
});

test("A11-135: the brief says where each choice of the form lands on the ticket", () => {
  const brief = writerBriefText({ writing: FAKE_TRACKER_WRITING, ...WRITER, request: "Show the requests\nA person made", mode: "quick", placement: "manual", form: { project: "Board", repo: "nbl-ui-netbox", goal: "Speed",
    priority: "high", parent: "A11-12" }, dir: "/state/tickets/writer/w1", pickTeam: "A11" });
  says(brief, [
    /^# New ticket: Show the requests$/m,
    /> Show the requests\n> A person made/,
    /for this request: Show the requests\nA person made\./,
    /- Project: Board \(the project of the ticket, by its name\)/,
    /- Repository: `nbl-ui-netbox` \(the last line of the description: `\*\*Repository:\*\* <repo>`\)/,
    /- Goal: Speed \(a label in the group `Goal`\)/,
    /- Priority: high, number 2 \(the ticket's priority number\)/,
    /- Parent: A11-12 \(the ticket's `parentId`: the ticket is filed as a child of it\)/,
    /These are requirements\. Use them as given: you set each one on the ticket you file\./,
    /`parentId`, `blockedBy` and `relatedTo` are set on the ticket you create/,
  ]);
});

/** The brief of a request placed `placement`, with the choices `form` names, for the request "x". */
const placedBrief = (placement: "auto" | "manual", form: WriterForm) =>
  writerBriefText({ writing: FAKE_TRACKER_WRITING, ...WRITER, request: "x", mode: "quick", placement, form, dir: "/d", pickTeam: "A11" });

test("A11-199: an auto brief leaves all five choices to the writer, and the priority to the request, as one of the tracker's numbers", () => {
  const brief = placedBrief("auto", {});
  says(brief, [
    /## The person's choices\n\nAuto placement: choose the project, repository, goal, priority and parent from the request, as the skill's Steps 7 and 8 say\./,
    /- \*\*Priority:\*\* the number of the form's priority when it names one, else the priority the request warrants, as one of these numbers: urgent 1, high 2, medium 3, low 4, none 0\./,
    /The description ends with `\*\*Repository:\*\* <repo>`: the form's repository or, when it names none, the one of the repositories below that holds the work, if one clearly does\./,
  ]);
  assert.doesNotMatch(brief, /These are requirements|and 0 when the form names none/, "no requirement is given, and the priority no longer defaults to 0");
});

test("A11-199: a manual brief lists each choice the person made as a requirement, and leaves the rest to the writer", () => {
  const brief = placedBrief("manual", { project: "Board", priority: "low" });
  says(brief, [
    /Manual placement:\n- Project: Board \(the project of the ticket, by its name\)\n- Priority: low, number 4 \(the ticket's priority number\)\n\nThese are requirements\. Use them as given: you set each one on the ticket you file\. Each of the five not listed here is yours to choose from the request\./,
  ]);
  assert.doesNotMatch(brief, /Auto placement:|- Repository:|- Goal:|- Parent:/, "an unset choice is not a requirement");
  const all = placedBrief("manual", { project: "Board", repo: "nbl-ui-netbox", goal: "Speed", priority: "none", parent: "A11-12" });
  assert.match(all, /- Priority: none, number 0 /, "No priority is a choice, and is the number 0");
  assert.doesNotMatch(all, /Each of the five not listed here/, "with all five named, none is left to choose");
});

test("A11-199: a manual brief with none of the five set says so, and leaves each to the writer", () => {
  says(placedBrief("manual", {}), [/Manual placement, and the person set none of the five\. Each of the five not listed here is yours to choose from the request\./]);
});

test("A11-135: the team is the parent's, else the team the Pick view lists, and with neither the run ends needs-human", () => {
  assert.match(briefIn("quick", "A11"), /the team of the parent ticket the form names, else `A11`, the team the Pick view lists/);
  assert.match(briefIn("quick", null), /else none: when the form names no parent and no team is set here, end needs-human/);
});

test("A11-199: the team bullet says a parent the writer chooses under Auto sets the team too", () => {
  assert.match(briefIn("quick", "A11"), /the team of the parent ticket the form names, else `A11`, the team the Pick view lists\. A parent you choose yourself under Auto placement takes its team in the same way\./);
});

test("A11-135: the brief keeps the duplicate check under Possible duplicates, and reads the tracker with read-only tools", () => {
  says(briefIn("quick"), [
    /read-only Fake tools \(`get`, `list`, `search`, `extract`\)/,
    /Name each one under "Possible duplicates" in the description, with the reason/,
    /Auto placement: choose the project, repository, goal, priority and parent from the request, as the skill's Steps 7 and 8 say\./,
  ]);
});

test("A11-135: the outcome the board reads is created with the keys made, or needs-human with the reason and any key made before it", () => {
  says(briefIn("quick"), [
    /\{ "kind": "created", "created": \["A11-140"\] \}/,
    /\{ "kind": "needs-human", "reason": "<why the run cannot finish, which the board shows as its failure>", "created": \["A11-140"\] \}/,
    /Write `\/d\/outcome\.json` as the last thing you do/,
    /every ticket you made, each by its key/,
  ]);
});

test("A11-135: quick runs the skill's unattended create, and grill runs the skill's grill with the person in the terminal, in each case then filing the same ticket", () => {
  const quick = briefIn("quick");
  says(quick, [/You are unattended\. Nobody will answer a question: the skill's unattended create answers its own grill, and you file the ticket\./]);
  assert.doesNotMatch(quick, /Nobody will answer a question: decide/, "the old quick text is gone");
  const grill = briefIn("grill");
  says(grill, [
    /You are interactive: the person is in this run's terminal\. Run the skill's grill with them: ask your questions one at a time, and wait for each answer before the next\./,
    /Write `created` only once the grill is done, the ticket is filed and its plan is attached\./,
  ]);
  assert.doesNotMatch(grill, /Write no draft/);
  assert.doesNotMatch(grill, /Nobody will answer/);
});

test("A11-135: a grill run asks by ending its turn with the question, and no outcome is written to ask", () => {
  const grill = briefIn("grill");
  assert.match(grill, /To ask a question, end your turn with it: the board shows the question to the person and keeps this run, in its terminal, until they answer\. Do not write an outcome to ask a question\./);
  assert.doesNotMatch(briefIn("quick"), /end your turn with it/, "a quick run asks nothing");
});

test("A11-124: the brief names the board's mode, and says it wins over the instruction, in each mode", () => {
  for (const mode of ["quick", "grill"] as const) {
    const brief = briefIn(mode);
    assert.match(brief, /^## The mode$/m);
    assert.match(brief, new RegExp(`whatever the instruction under "What to do" says: \`${mode}\`\.`));
  }
});

test("A11-124: a {mode} placeholder in the instruction is filled with the board's mode, and the instruction names no mode of its own", () => {
  const brief = writerBriefText({ writing: FAKE_TRACKER_WRITING, run: "Run the a11ign:create-ticket skill, {mode}, for this request: {request}.", request: "x", mode: "grill", placement: "auto", form: {}, clones: {}, dir: "/d", pickTeam: null });
  assert.match(brief, /Run the a11ign:create-ticket skill, grill, for this request: x\./);
});

test("A11-124: the first prompt of a grill run asks its first question; a quick run's is the pointer to its brief alone", () => {
  assert.equal(writerPrompt("/d", "quick"), "Read /d/brief.md and follow it.");
  assert.equal(writerPrompt("/d", "grill"), "Read /d/brief.md and follow it. Your first message to me is your first question.");
});

test("A11-94: the writer's brief names the one repository list it may read, and no other repository", () => {
  says(briefIn("quick"), [/- `nbl-ui-netbox` at `\/r\/netbox`/, /read only; never change them/]);
});

test("A11-135: a writer's settings record each creation as it returns, and no other run's settings do", () => {
  const base = { model: "opus", ticketDir: "/d", readDirs: [], hook: { node: "/usr/bin/node", bin: "/tool/src/bin.ts" } };
  const writer = workerSettings({ ...base, writer: FAKE_TRACKER_WRITING }) as any;
  assert.deepEqual(writer.hooks.PostToolUse, [{ matcher: "mcp__fake__create_ticket", hooks: [{ type: "command", command: "/usr/bin/node",
    args: ["/tool/src/bin.ts", "ticket:hook", "post-tool-use", "/d"], timeout: 30 }] }]);
  assert.equal("PostToolUse" in (workerSettings(base) as any).hooks, false, "a build worker records nothing");
});

test("A11-257: a worker's unplanned choice appears in the pull request, not as a stop", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes("Nobody will answer you in this run. Decide anything that is not on the escalation list yourself, in line with the plan and the ticket's Decisions, and list each such choice under \"Decisions made without a person\" in the pull request body. End with `needs-human` only for an item on the list, naming its id."));
  assert.equal(brief.includes("Settle no product or design decision"), false, "the old stop is gone");
  assert.equal(brief.includes("so decide"), false);
  assert.match(brief, /A choice the plan and the ticket leave open, a product one or a technical one, is made in line with the plan and the ticket's Decisions, and listed in the pull request body under the heading "Decisions made without a person", as `Technical:` or `Product:` with its reason/);
  assert.match(brief, /A product decision is what a person sees or does, what a control is called or does/);
  assert.match(brief, /Write `needs-human` only for an item on the escalation list, with its id in `escalation`[^]*Any other question you decide yourself and list under "Decisions made without a person" in the pull request body: it is not a reason to stop\./);
  assert.ok(brief.includes(ESCALATION_RULE), "the worker reads the one list");
  assert.ok(brief.includes('"escalation": "outward"'), "the needs-human example names its item");
});

test("A11-257: both planners decide everything off the escalation list themselves, take the option they would have recommended, and no longer stop for a behaviour grill", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes(ESCALATION_RULE), "the planner reads the one list");
    for (const said of [/You decide everything that is not on the list yourself, from the boards, the code, the ADRs and the ticket's Decisions/, /Where you would have recommended an option, take it\./,
      /A `QUESTION\.md` is written only for an item on the list, and starts with `\*\*Escalation:\*\* <id>`; the plan check refuses one that does not\./, /a `Product:` bullet is no defect/,
      /the plan carries the line `\*\*Behaviour:\*\* settled by the planner`, followed by each behaviour decision with its reason/]) assert.match(brief, said);
    for (const gone of ["the behaviour grill is needed", "ends that ticket in its `QUESTION.md`, with no plan", "a `Product:` bullet is a defect"]) {
      assert.equal(brief.includes(gone), false, `the old wording is gone: ${gone}`);
    }
  }
  assert.match(batch, /or a `QUESTION\.md` when its plan needs an item of the escalation list/);
  for (const brief of [plan, batch]) assert.match(brief, /A decision of the ticket's that your plan cannot follow is the `contradicts` item: stop with a `QUESTION\.md` that starts `\*\*Escalation:\*\* contradicts`/);
});

test("A11-134: a Grill run's brief grills one ticket, asks its open line and its screen's behaviour, and files nothing: it ends decided", () => {
  const grilled = { ...ticket, description: "## Acceptance\n\n### 4. Decide whether to isolate the failing ticket or keep the stall\n\n**Screen:** yes\n" };
  const brief = writerBriefText({ writing: FAKE_TRACKER_WRITING, ...WRITER, request: "Grill NBF-1270", mode: "grill", placement: "auto", form: {}, dir: "/d", pickTeam: "A11", ticket: grilled });
  assert.match(brief, /^# Grill NBF-1270: Refresh Data gives no feedback\n/);
  assert.ok(brief.includes("`### 4. Decide whether to isolate the failing ticket or keep the stall`"));
  assert.match(brief, /the ticket changes a screen\. Ask the person what they see, what each control does/);
  assert.ok(brief.includes("/d/decisions.md"));
  assert.ok(brief.includes('{ "kind": "decided", "ticket": "NBF-1270" }'));
  assert.match(brief, /File no ticket, attach nothing, and change nothing in the tracker/);
  assert.equal(brief.includes("mcp__fake__create_ticket"), false);
});

test("step 7 has a worker decline a design check by default, and do it on a machine with design tools", () => {
  const brief = (designTools?: boolean) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", ...(designTools === undefined ? {} : { designTools }) });
  for (const text of [brief(), brief(false)]) {
    assert.match(text, /7\. If a design gate asks for a design check, decline it with "unattended worker, no design tool access"/);
    assert.doesNotMatch(text, /do it: read the design's values/);
  }
  const done = brief(true);
  assert.match(done, /7\. If a design gate asks for a design check, do it: read the design's values with the design tool, measure your result in the running app, look at the design node/);
  assert.match(done, /Decline it only when a design tool call is refused, quoting the refusal in the pull request body\./);
  assert.doesNotMatch(done, /no design tool access/);
});

test("step 5a has a worker capture a changed page before step 6 opens the pull request, only on a machine that can capture", () => {
  const brief = (capture?: boolean) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", ...(capture === undefined ? {} : { capture }) });
  for (const text of [brief(), brief(false)]) assert.doesNotMatch(text, /ticket:capture/, "a machine that cannot capture is not told to");
  const capturing = brief(true);
  assert.ok(capturing.indexOf("\n5a. ") > capturing.indexOf("\n5. "), "5a follows the commit step");
  assert.ok(capturing.indexOf("\n5a. ") < capturing.indexOf("\n6. Push the branch"), "5a comes before the step that opens the pull request");
  assert.match(capturing, /^5a\. If your change alters what a page of the board looks like, capture each such page before you open the pull request in step 6: run `agent-org ticket:capture <route> --size 1280x800 --out \/d\/captures\/`/m);
  const expected = [/`\/settings\/models` for the Settings page/, /Commit each PNG as `\.acceptance\/captures\/<name>\.png` on your branch/,
    /\]\(https:\/\/github\.com\/<owner>\/<repo>\/blob\/<head sha>\/\.acceptance\/captures\/<name>\.png\?raw=true\)/, /Do not end `needs-human` to ask a person to look at the page/];
  for (const pattern of expected) assert.match(capturing, pattern);
});

test("A11-168: the brief of a next step lists the merged steps and their pull requests, says which step it does, and a first step's brief has no such section", () => {
  const brief = (steps?: { step: number; of: number; prs: string[] }[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], steps, clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const next = brief([{ step: 1, of: 9, prs: ["https://github.com/a11ign/agent-org/pull/1811"] }, { step: 2, of: 9, prs: ["https://github.com/a11ign/agent-org/pull/1812", "https://github.com/a11ign/control/pull/9"] }]);
  for (const part of ["## Steps already merged", "- step 1 of 9: https://github.com/a11ign/agent-org/pull/1811", "- step 2 of 9: https://github.com/a11ign/agent-org/pull/1812, https://github.com/a11ign/control/pull/9",
    "This run does step 3 of 9, and only that step.", "git fetch origin && git merge origin/<the repository's default branch>", "open a NEW pull request", "Do not push to the merged pull request"]) {
    assert.ok(next.includes(part), `the next step's brief says ${part}`);
  }
  assert.equal(brief().includes("## Steps already merged"), false);
  assert.equal(brief([]).includes("## Steps already merged"), false);
});

test("A11-168: every brief tells the worker to begin a numbered plan's Partial line and partial outcome with step N of M, and the last step's pull request to close the ticket", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes("When the plan has numbered steps, the `Partial:` line begins `step <N> of <M>`, and the last step's pull request names the ticket `Closes NBF-1270` and has no `Partial:` line."));
  assert.ok(brief.includes("When the plan has numbered steps, `partial` begins `step <N> of <M>`: the board queues step N + 1 when that pull request merges."));
});

// A11-167: every brief carries the ticket text as read at start, with its updatedAt.
const READ = ticketReadOf({ description: ticket.description, updatedAt: "2026-10-21T09:30:00.000Z" }, Date.UTC(2026, 9, 21, 12, 0, 0));
const READ_LINE = "Read from the tracker at 2026-10-21T12:00:00.000Z; the ticket was last updated 2026-10-21T09:30:00.000Z.";
const REVIEWED_PR = [{ repo: "nbl-ui-netbox", url: "https://github.com/netboxlabs/nbl-ui-netbox/pull/806" }];

test("the worker brief and the review-round brief carry the ticket text as read at start, with its updatedAt", () => {
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", read: READ });
  assert.ok(work.includes(`## The ticket\n\n${ticket.url}\n\n${READ_LINE}\n\n${ticket.description}`), "the work brief says when the text was read and last updated, above the text");
  const round = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: REVIEWED_PR, resumed: true, read: READ });
  assert.ok(round.includes(`## The ticket\n\n${ticket.url}\n\n${READ_LINE}\n\n> ${ticket.description}`), "the review round carries the description, quoted, and not only the address");
});

test("the planning brief, single and batch, carries the ticket as read at start, with its updatedAt", () => {
  const single = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", read: READ });
  assert.ok(single.includes(`## The ticket\n\n${ticket.url}\n\n${READ_LINE}\n\n${ticket.description}`));
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null, read: READ }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  assert.ok(batch.includes(`${ticket.url}\n\n${READ_LINE}\n\n> ${ticket.description}`));
});

test("a tracker that does not say when the ticket changed is said so, and a brief written with no read has no such line", () => {
  const unknown = ticketReadOf({ description: ticket.description }, Date.UTC(2026, 9, 21, 12, 0, 0));
  const brief = (read?: typeof unknown) => planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", read });
  assert.ok(brief(unknown).includes("the tracker does not say when the ticket was last updated."));
  assert.equal(brief().includes("Read from the tracker"), false);
});

test("the worker brief asks for the pull request body to say which version of the ticket the work was done against, so a reviewer who reads only the pull request can tell", () => {
  const work = (read?: typeof READ) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", read });
  assert.ok(work(READ).includes("`Worked against the ticket as updated 2026-10-21T09:30:00.000Z`"));
  assert.equal(work().includes("Worked against the ticket"), false, "no updatedAt, no line to copy");
  assert.equal(work(ticketReadOf({ description: "x" }, 1)).includes("Worked against the ticket"), false);
});

test("a review round whose ticket changed since the last round says what changed: the lines that differ, and the text the last round read", () => {
  const before = ticketReadOf({ description: "Clicking does nothing visible.\n\nDone-when: a toast shows.", updatedAt: "2026-10-21T08:00:00.000Z" }, Date.UTC(2026, 9, 21, 9, 0, 0));
  const now = ticketReadOf({ description: "Clicking does nothing visible.\n\nDone-when: a toast shows, and the button is disabled.", updatedAt: "2026-10-21T11:00:00.000Z" }, Date.UTC(2026, 9, 21, 12, 0, 0));
  const round = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: REVIEWED_PR, resumed: true, read: now, previous: before });
  for (const part of ["### The ticket changed since your last round", "last updated 2026-10-21T11:00:00.000Z", "last updated 2026-10-21T08:00:00.000Z", "- Done-when: a toast shows.", "+ Done-when: a toast shows, and the button is disabled.",
    "The description your last round read:", "> Done-when: a toast shows."]) {
    assert.ok(round.includes(part), `the round names ${part}`);
  }
  const unchanged = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: REVIEWED_PR, resumed: true, read: now, previous: { ...now, readAt: 1 } });
  assert.equal(unchanged.includes("The ticket changed since your last round"), false, "an unchanged description has no such section");
  assert.equal(reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: REVIEWED_PR, resumed: true, read: now }).includes("The ticket changed since your last round"), false, "a round with no earlier read has none");
});

const FINDING = { key: "A11-165", number: 3, url: "https://github.com/a11ign/announcement-emulator/pull/3", title: "feat: scripted replay", file: "/state/tickets/A11-166/blockers/A11-165-a11ign-announcement-emulator-3.md" };

const OPEN_PULL = "https://github.com/a11ign/announcement-emulator/pull/4";
const UNREAD_PULL = "https://github.com/a11ign/announcement-emulator/pull/5";
/** A blocker with a merged pull request the board read, an open one the tracker titled, and a merged one it has not read yet, and a blocker with none. */
const BLOCKERS: Blocker[] = [
  { key: "A11-165", state: "completed", status: "Done", pulls: { [FINDING.url]: "merged", [OPEN_PULL]: "open", [UNREAD_PULL]: "merged" }, titles: { [OPEN_PULL]: "feat: second step" } },
  { key: "A11-170", state: "started", status: "In Progress", pulls: {} },
];

test("the planning brief lists every blocker and every pull request of each with its state, title and address, marks the ones the plan needs a line for, and shows the exact line form", () => {
  const single = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", blockers: BLOCKERS, findings: [FINDING] });
  for (const part of [
    "## Its blockers and what they found",
    "- A11-165, Done:",
    `  - merged, "feat: scripted replay", ${FINDING.url}: needs a line. What it found is in \`${FINDING.file}\`.`,
    `  - open, "feat: second step", ${OPEN_PULL}: needs no line.`,
    `  - merged, "title not given by the tracker", ${UNREAD_PULL}: needs no line: the board has not read what it found yet.`,
    "- A11-170, In Progress: no pull request linked: needs no line.",
    "`## What the blockers found` section, before `## Paths`", "Name each by its address", "is refused", "asks you once to add what it misses",
    `\`\`\`markdown\n## What the blockers found\n\n- ${FINDING.url}: <how this pull request's findings apply to this ticket, or why they do not>\n\`\`\``,
  ]) {
    assert.ok(single.includes(part), `the planning brief says ${part}`);
  }
  assert.equal(single.includes(`- ${OPEN_PULL}: <`) || single.includes(`- ${UNREAD_PULL}: <`), false, "the line form holds only the pull requests that need a line");
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null, blockers: BLOCKERS, findings: [FINDING] }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  assert.ok(batch.includes("### Its blockers and what they found") && batch.includes(FINDING.file) && batch.includes("- A11-170, In Progress: no pull request linked: needs no line."), "a batch's brief gives each ticket its own, under the ticket's heading");
  assert.equal(planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" }).includes("Its blockers and what they found"), false, "no blockers and no findings, no section");
});

test("the planning brief of a ticket whose blockers have no pull request on the check's list says no section is required, and lists a blocker with no pull request as needing no line", () => {
  const brief = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", blockers: [BLOCKERS[1], { key: "A11-171", state: "started", status: "In Progress", pulls: { [OPEN_PULL]: "open" } }] });
  for (const part of ["- A11-170, In Progress: no pull request linked: needs no line.", `  - open, "title not given by the tracker", ${OPEN_PULL}: needs no line.`, "No pull request here needs a line, so the plan needs no `## What the blockers found` section."]) {
    assert.ok(brief.includes(part), `the planning brief says ${part}`);
  }
  assert.equal(brief.includes("is refused"), false, "a plan is not held to a section nobody asked for");
  assert.equal(brief.includes("```markdown"), false, "and no line form is shown");
});

test("a pull request the board read that its blocker no longer links is still listed, under its ticket, so the check's list is whole; a title the tracker gave wins over the one the findings read gave", () => {
  const blocker: Blocker = { key: "A11-165", state: "completed", status: "Done", pulls: { [FINDING.url]: "merged" }, titles: { [FINDING.url]: "feat: tracker title" } };
  const brief = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", blockers: [blocker], findings: [FINDING, { ...FINDING, key: "A11-168", url: OPEN_PULL, title: "feat: gone", file: "/state/gone.md" }] });
  assert.ok(brief.includes(`  - merged, "feat: tracker title", ${FINDING.url}: needs a line.`));
  assert.ok(brief.includes(`- A11-168, no longer linked by the tracker:\n  - merged, "feat: gone", ${OPEN_PULL}: needs a line.`));
  assert.ok(brief.includes(`- ${OPEN_PULL}: <`), "the line form holds it too");
});

test("the worker brief names the findings files too, in its section on the tickets that blocked it, for a ticket queued with no planning", () => {
  const blocker: Blocker = { key: "A11-165", state: "completed", status: "Done", pulls: { [FINDING.url]: "merged" } };
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], blockers: [blocker], clones, worktreeCommand: "w", prOpenCommand: "p", findings: [FINDING] });
  assert.ok(brief.includes(`What their merged pull requests found is saved in these files. Read each: it may change how this ticket is worked.\n\n- \`${FINDING.file}\` (A11-165, #3)`));
  assert.equal(briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], blockers: [blocker], clones, worktreeCommand: "w", prOpenCommand: "p" }).includes("What their merged pull requests found"), false);
});

test("a re-plan brief says the earlier plan is detached and copied, shows the lines of the description that changed, and asks for the plan to be written from the new text", () => {
  const replan = { files: ["/d/previous-plan/NBF-1270-0001-plan-x.md"], change: { from: "Clicking does nothing.\n\nDone-when: a toast.", to: "Clicking does nothing.\n\nDone-when: a toast, replayed." }, findings: false };
  const brief = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", replan });
  for (const part of ["## This is a re-plan", "the board has detached it", "- `/d/previous-plan/NBF-1270-0001-plan-x.md`", "```diff", "- Done-when: a toast.", "+ Done-when: a toast, replayed.",
    "Plan from the ticket's text above, which is the latest", "do not write one"]) {
    assert.ok(brief.includes(part), `the re-plan brief says ${part}`);
  }
  assert.equal(brief.includes("see \"What its blockers found\""), false);
  assert.ok(planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", replan: { files: [], findings: true } }).includes("A pull request of a blocker merged after that plan was written"));
  assert.equal(planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" }).includes("This is a re-plan"), false, "a first plan is not a re-plan");
});

test("diffText shows the lines that differ with two lines of what stays around them, and a gap where more stays", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
  const before = lines(12).join("\n");
  const after = lines(12).map((line) => (line === "line 6" ? "line six" : line)).join("\n");
  assert.equal(diffText(before, after), "```diff\n...\n  line 4\n  line 5\n- line 6\n+ line six\n  line 7\n  line 8\n...\n```");
});

test("A11-173: rule 6 and the outcome section say partial is build work a later run does, After-merge lines are not partial, and a run's sibling pull requests say Refs with no partial", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const rule6 = brief.split("\n").find((line) => line.startsWith("6. ")) ?? "";
  assert.ok(rule6.includes("`Partial:` is for build work a later run of this ticket does, a plan step."), "partial is a plan step");
  assert.ok(rule6.includes("An After-merge line of the ticket's Done-when is not partial: the board completes the ticket when the pull requests merge and lists those lines, so a pull request that leaves only After-merge lines names the ticket `Closes NBF-1270`."));
  assert.ok(rule6.includes("When your pull requests finish the ticket together (two repositories, say), each names the ticket `Refs NBF-1270`, because one `Closes` would complete the ticket on the first merge, and each `Partial:` line names the run's other pull requests; your outcome then has no `partial`, and the board completes the ticket once all of them have merged."));
  assert.ok(brief.includes("`partial` is what remains of the ticket once every pull request of this run has merged, and only build work a later run does. It is not what one pull request leaves to its sibling in this run, and not an After-merge line of the Done-when: a run whose pull requests finish the ticket together has no `partial`."), "the outcome section says the same");
});

test("A11-181: the outcome section says partial names what is still owed, never what was done, is absent when the pull request says Closes, and the board follows the pull request's declaration", () => {
  const sentence = (keywords?: { closing: string; nonClosing: string }) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", ...(keywords ? { keywords } : {}) });
  assert.ok(sentence().includes("`partial` names what is still owed, never what was done: when the pull request's body says `Closes NBF-1270`, the outcome has no `partial` at all. The board follows the merged pull request's own `Closes` or `Partial:` declaration when the two disagree, and shows the disagreement on the card."));
  assert.ok(sentence({ closing: "Resolves", nonClosing: "Relates" }).includes("when the pull request's body says `Resolves NBF-1270`, the outcome has no `partial` at all. The board follows the merged pull request's own `Resolves` or `Partial:` declaration"), "a source with its own words is briefed with them");
});

test("A11-173: a counted step's brief says the board counted it and asks for step N of M", () => {
  const brief = (steps: { step: number; of: number; prs: string[]; counted?: true }[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], steps, clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  const counted = brief([{ step: 2, of: 9, prs: ["https://github.com/a11ign/agent-org/pull/1816"], counted: true }]);
  assert.ok(counted.includes("- step 2 of 9: https://github.com/a11ign/agent-org/pull/1816 (counted by the board: the Partial line named no step)"), "the merged step is marked");
  assert.ok(counted.includes("This run does step 3 of 9, and only that step."));
  assert.ok(counted.includes("The Partial line of step 2's pull request named no step, so the board counted it as step 2 of 9. Check the merged pull requests above against the plan before you start, do the first step none of them did, and name it `step <N> of <M>` in your `Partial:` line."));
  const named = brief([{ step: 2, of: 9, prs: ["https://github.com/a11ign/agent-org/pull/1816"] }]);
  assert.equal(named.includes("counted"), false, "a step the declaration named says nothing of counting");
});

// A11-175: a plan delivered in steps gives each step its own section and paths, which the board holds for a run on that step and quotes to a reviewer.
test("A11-175: both planner briefs tell the planner to give each step of a numbered plan a `### Step <N> of <M>` section that ends with that step's own paths, and keep ## Paths complete", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes("A plan delivered in numbered steps, one pull request each, gives each step a `### Step <N> of <M>: <title>` section that ends with that step's own `- \`<repo>:<path>\`` bullets"));
    assert.ok(brief.includes("the board holds only the current step's paths and its open pull requests' files, and gives a reviewer that step's section"));
    assert.ok(brief.includes("`## Paths` still lists every path of every step, because `pr:open` reads it as the Region."));
  }
});

test("A11-219: a plan with numbered steps has its worker write the step it is on in its outcome file, and a run without steps is not told to", () => {
  const brief = (numberedSteps?: boolean) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open", ...(numberedSteps === undefined ? {} : { numberedSteps }) });
  const line = '{ "kind": "working", "reason": "<the step you are on>", "currentStep": <N> }';
  assert.ok(brief(true).includes(line), "the brief shows the progress note");
  assert.match(brief(true), /That is the one `working` that is not about background work: it is only a progress note, and your turn still ends on a real outcome/, "and says it is not the background-work `working`");
  assert.equal(brief(false).includes("currentStep"), false);
  assert.equal(brief().includes("currentStep"), false);
  assert.match(brief(), /nothing will wake you\.\n\nA person may answer you here/, "the paragraphs around the working rule are as they were without steps");
  assert.match(brief(true), /nothing will wake you\.\n\nThe plan has numbered steps[^\n]*\n\nA person may answer you here/, "and with steps the new paragraph stands alone between them");
});
