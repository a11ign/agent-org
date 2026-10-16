// no-token: gh -- pure builders
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchPlanBriefText, briefText, firstPrompt, planBriefText, workerFlags, workerSettings } from "./worker-files.ts";
import type { Ticket } from "./source.ts";

const ticket = { key: "NBF-1270", title: "Refresh Data gives no feedback", description: "Clicking does nothing visible.", url: "https://linear.app/x/issue/NBF-1270",
  branch: "nbf-1270-refresh", status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 3, parent: "NBF-1200" } as Ticket;
const clones = { "nbl-ui-netbox": "/work/nbl-ui-netbox", "nbl-ui-platform-libs": "/work/nbl-ui-platform-libs" };

test("the brief carries the ticket, every repository to choose from, the worktree command, the draft rule and the outcome file's path", () => {
  const brief = briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: ["/state/tickets/NBF-1270/attachment-1.png"],
    clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree" });
  for (const part of [ticket.url, ticket.description, "`nbl-ui-netbox` at `/work/nbl-ui-netbox`", "`nbl-ui-platform-libs` at `/work/nbl-ui-platform-libs`",
    "/node /tool/src/bin.ts ticket:worktree <repo>", "/work/.tickets/NBF-1270/<repo>", "nbf-1270-refresh", "never commit or change branches in them",
    "gh pr create --draft", "/state/tickets/NBF-1270/outcome.json", "attachment-1.png", "wrong-repo", "needs-human", "CLAUDE.md"]) {
    assert.ok(brief.includes(part), `the brief names ${part}`);
  }
});

test("a parent's description is quoted under its own heading, with its files, and a ticket without one has no such section", () => {
  const parentTicket = { ...ticket, key: "NBF-1200", title: "Feedback across the app", url: "https://linear.app/x/issue/NBF-1200",
    description: "Every button gives feedback.\n\n## Acceptance criteria\n\n- [ ] every app", parent: null } as Ticket;
  const brief = (parent?: { ticket: Ticket; attachments: string[] }) =>
    briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], parent, clones, worktreeCommand: "w" });
  const withParent = brief({ ticket: parentTicket, attachments: ["/d/parent/attachment-1-NBF-1200-0001-plan.md"] });
  for (const part of ["## The parent ticket\n\nNBF-1200: Feedback across the app", "https://linear.app/x/issue/NBF-1200", "Do only your ticket's part",
    "> Every button gives feedback.\n>\n> ## Acceptance criteria\n>\n> - [ ] every app", "### Files from NBF-1200", "`/d/parent/attachment-1-NBF-1200-0001-plan.md`"]) {
    assert.ok(withParent.includes(part), `the brief carries ${part}`);
  }
  assert.equal(withParent.match(/^## Acceptance criteria/m), null, "the parent's criteria never read as the worker's own");
  assert.equal(brief().includes("## The parent ticket"), false);
});

test("the ticket's files come with the order to read them first, and a ticket with none says so", () => {
  const brief = (attachments: string[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments, clones, worktreeCommand: "w" });
  assert.ok(brief(["/d/attachment-1-NBF-1270-0001-plan.md"]).includes(
    "## Files from the ticket\n\nRead every file here before you start. A plan among them is the agreed approach, so follow it.\n\n- `/d/attachment-1-NBF-1270-0001-plan.md`"));
  assert.ok(brief([]).includes("## Files from the ticket\n\nNone.\n"));
});

test("before it commits, a fresh subagent reviews the diff for changed behaviour, and every claim in the body has an assertion run on the base", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w" });
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
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w" });
  const check = brief.indexOf("Check your diff against what was asked.");
  assert.ok(check > 0, "the brief has the check");
  assert.ok(check < brief.indexOf("Commit with a conventional commit message"), "it comes before the commit, so what it finds is fixed in it");
  for (const part of ["each acceptance criterion in the ticket", "its parent's description and its parent's files", "say which and why in the pull request body"]) {
    assert.ok(brief.includes(part), `the check names ${part}`);
  }
});

test("the connectors a machine allows are named in the brief, and a machine that allows none adds no section", () => {
  const brief = (connectors?: string[]) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", connectors });
  assert.match(brief(["^mcp__claude_ai_Linear__(get|list)_"]), /## Connectors\n\nThis machine lets you call the connector tools whose names match `\^mcp__claude_ai_Linear__\(get\|list\)_`\. .*the tickets that block it/);
  assert.equal(brief().includes("## Connectors"), false);
  assert.equal(brief([]).includes("## Connectors"), false);
});

test("a ticket that waited names each blocker, its status and its pull requests, and one that waited on none has no such section", () => {
  const brief = (blockers?: { key: string; state: string; status: string; pulls: Record<string, "open" | "merged" | "closed"> }[]) =>
    briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", blockers });
  const text = brief([{ key: "NBF-1944", state: "started", status: "In Review", pulls: { "https://github.com/o/libs/pull/8": "merged" } }, { key: "NBF-1", state: "completed", status: "Done", pulls: {} }]);
  assert.match(text, /- NBF-1944, In Review: https:\/\/github\.com\/o\/libs\/pull\/8 \(merged\)\n- NBF-1, Done: no pull request linked/);
  assert.match(text, /`gh release list --repo <owner>\/<repo>`/);
  assert.equal(brief().includes("## Tickets that blocked this one"), false);
  assert.equal(brief([]).includes("## Tickets that blocked this one"), false);
});

test("the machine's notes join the brief under their own heading, and a machine with none adds no heading", () => {
  const brief = (notes?: string) => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", notes });
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
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w" });
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
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w" });
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
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt" });
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  for (const brief of [work, plan, batch]) {
    assert.match(brief, /If a skill this brief names is not available in this session, write a `needs-human` outcome naming it, rather than following a copy of its files\./);
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
    "{ \"<KEY>\": { \"repo\": \"<repository>\", \"after\": [\"<KEY>\", ...] } }", "or `null` for a ticket with a question", "never the ticket itself, and make no cycle",
    "A question about one ticket does not stop the others", "Write `/state/tickets/batches/b1-0/outcome.json` as the last thing you do, after every plan, question and `order.json`",
    "{ \"kind\": \"planned\" }", "change no code"]) {
    assert.ok(brief.includes(part), part);
  }
});
