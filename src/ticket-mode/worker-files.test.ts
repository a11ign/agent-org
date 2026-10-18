// no-token: gh -- pure builders
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFLICT_LINE, batchPlanBriefText, briefText, conflictLine, firstPrompt, planBriefText, publishBriefText, reviewBriefText, reviewPrompt, workerFlags, workerSettings } from "./worker-files.ts";
import type { Blocker, Ticket } from "./source.ts";

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
    stackedOn: [{ key: "NBF-1", url: draft, repo: "nbl-ui-netbox", branch: "nbf-1-fit" }] });
  for (const part of ["## Stack on the work you wait for", "open pull request in `nbl-ui-netbox`", `- NBF-1: ${draft}, on branch \`nbf-1-fit\``,
    "`node bin.ts ticket:worktree nbl-ui-netbox --from <branch>`", "`gh pr view <its pull request url> --json headRefName`", "or on the last one listed when the plan does not say",
    "`gh stack link <its pull request url> <your pull request url>`", "Run no other `gh stack` command", "which pull request yours is stacked on"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /This ticket waited until each of these was done:\n\n- NBF-5, Done: no pull request linked\n/, "only the blockers it waited for");
  assert.equal(briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" }).includes("## Stack on"), false);
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

test("both planner briefs ask for a Region section that lists the paths the work will change, prefixed by repository when there is more than one", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a", b: "/b" }, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a", b: "/b" }, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes("End each plan with a `## Region` section listing every path the work will change, one per line, inside a fenced code block."), "the Region section is asked for, fenced");
    assert.ok(brief.includes("prefix each path with `<repo>:`"), "a multi-repository plan prefixes each path");
    assert.ok(brief.includes("(`a`, `b`)"), "the repositories a prefix may name are the host file's clones");
  }
});

test("a drafts-on brief opens a draft: step 6 runs pr:open with --draft, names the ticket's keys, and its outcome example is draft-pr", () => {
  const brief = briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes(`6. Push the branch and open ONE DRAFT pull request per repository you changed: write its body to a file, then run \`/node /tool/src/bin.ts pr:open create --draft --title "<type>(<scope>): <what changed>" --body-file <file>\`. The body links ${ticket.url}, and names the ticket \`Closes NBF-1270\` when this pull request completes it (its done-when is fully met), so the tracker closes the ticket when it merges.`), "A11-92: the closing keyword is asked for a completing pull request");
  assert.ok(brief.includes("`Outside-Region: <path> — <reason>`"), "a path outside the plan's Region is declared in the body");
  assert.equal(brief.includes("gh pr create"), false, "the brief no longer tells a worker to open its pull request with gh");
  assert.equal(brief, briefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", attachments: [], clones, worktreeCommand: "/node /tool/src/bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", drafts: true }), "an absent flag is the same as true");
  assert.ok(brief.includes(`{ "kind": "draft-pr", "prs": [{ "repo": "<repo>", "url": "<pull request url>" }] }`));
  assert.equal(brief.includes("ready-pr"), false);
});

test("A11-92: a brief asks for the tracker's closing keyword on a completing pull request, and the non-closing one with a Partial line only for a partial one", () => {
  const brief = briefWith();
  assert.ok(brief.includes("names the ticket `Closes NBF-1270` when this pull request completes it"), "a completing pull request is written with the closing keyword");
  assert.ok(brief.includes("When the pull request is partial and leaves part of the ticket to do, it names the ticket `Refs NBF-1270` instead, with a `Partial: <what remains>` line, and the ticket stays open"),
    "a partial pull request is written with the non-closing keyword and a Partial line");
  assert.ok(brief.includes("a pull request that completes the ticket is never written with `Refs`"), "the non-closing keyword is not for a completing pull request");
  assert.ok(brief.includes(`{ "kind": "draft-pr", "prs": [{ "repo": "<repo>", "url": "<pull request url>" }] }`), "the outcome example is unchanged");
  assert.ok(brief.includes(`A partial pull request adds \`"partial": "<what remains>"\` to its \`draft-pr\` line`), "a partial pull request declares it in the outcome file");
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
  assert.ok(brief.includes(`{ "kind": "ready-pr", "prs": [{ "repo": "<repo>", "url": "<pull request url>" }] }`));
  assert.equal(brief.includes("draft-pr"), false);
});

test("a worker may end on checked when nothing needs to change, and is told needs-human is only for what the person alone can decide", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes('{ "kind": "checked", "reason": "<what you checked, what you found, and why the ticket is not finished>" }'), "checked is one of the outcomes");
  assert.match(brief, /Write `checked` when you looked at what the ticket asks and nothing needs to change, but the ticket is \*\*not finished\*\*/);
  assert.match(brief, /the ticket is only a parent whose work is all in its child tickets \(name them, so the person queues them\)/);
  assert.match(brief, /Write `needs-human` only for a real question or decision that only the person can make/);
});

test("A11-91: the worker's brief says when to write done and when checked, lists done with its evidence, and lets it propose an edit to the ticket's text", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.ok(brief.includes('{ "kind": "done", "reason": "<what the ticket asks, and that every Done-when item holds>", "evidence": ["<one line per Done-when item: what you ran or read, and what it showed>"] }'), "done is one of the outcomes, with its evidence");
  assert.match(brief, /Write `done` only when no code and no pull request is needed and \*\*every Done-when item of the ticket is verified\*\*/, "done: every Done-when verified");
  assert.match(brief, /The `evidence` list has one line per Done-when item: what you ran or read, and what it showed/, "done: the evidence says what was seen");
  assert.match(brief, /A prediction is not evidence/, "done: a prediction never fills evidence");
  assert.match(brief, /Never write `done` for a ticket with open sub-issues, which complete it, and never after you opened a pull request/, "done: never for a parent, nor after a pull request");
  assert.match(brief, /Write `checked` when you looked at what the ticket asks and nothing needs to change, but the ticket is \*\*not finished\*\*/, "checked: the ticket is not finished");
  assert.match(brief, /a Done-when item is not verifiable by you, or the ticket is only a parent whose work is all in its child tickets/, "checked: why it is not finished");
  assert.match(brief, /"edit": \{ "title": "<the title it should have>", "description": "<the whole description it should have>", "why": "<what is wrong, and what shows it>" \}/, "the edit field");
  assert.match(brief, /A ticket's own title or description may be what is wrong/, "when to propose an edit");
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
  assert.ok(brief.includes('{ "kind": "working", "reason": "<what of yours is still running in the background, and what you do when it wakes you>" }'), "working is one of the outcomes");
  assert.match(brief, /Write `working` only while your own background work \(a background shell or a Monitor\) is genuinely still running and will wake you when it finishes/);
  assert.match(brief, /Never write `working` to park a question or to wait on a person: that is `needs-human`/);
  assert.match(brief, /write the outcome file again with how the run ended, or with `working` again if more of it is still running/);
});

test("A11-85: the brief says how to wait on a process started detached: a Monitor on its PID or its log, never a bare claim of working", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
  assert.match(brief, /A process you started detached is not background work of yours until a Monitor holds it: it wakes nothing when it ends, so arm a Monitor on its PID or its log \(`until ! kill -0 <pid>; do sleep 5; done`\) before you write `working`/);
  assert.match(brief, /A `working` with no shell or Monitor running is refused: nothing will wake you\./);
});

// A11-82: a pull request that conflicts with its base is merged first, and a planner says where its work lands and what paths it touches.
const conflicted = `New feedback reached your pull requests after your last round, so the board started this round to answer it.`;
const conflictFeedback = `${conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", "main")}`;

test("A11-82: a round whose feedback names a conflict merges the base in first, never rebases or force-pushes, keeps both changes, and numbers the feedback steps after it", () => {
  assert.equal(conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", "main"), "https://github.com/x/nbl-ui-netbox/pull/806 conflicts with its base branch main.");
  assert.equal(conflictLine("https://github.com/x/nbl-ui-netbox/pull/806", null), "https://github.com/x/nbl-ui-netbox/pull/806 conflicts with its base branch unknown.");
  assert.equal(CONFLICT_LINE.test(conflictFeedback), true);
  const brief = review(conflictFeedback);
  assert.match(brief, /^1\. The feedback above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin\/<base>`/m);
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
  assert.equal(/^1\. The feedback above says a pull request conflicts/m.test(plain), false, "nothing conflicts, so no merge step leads the feedback steps");
  assert.match(plain, /^1\. Read that feedback/m);
  const asked = reviewBriefText({ ticket, folder: "/work/.tickets/NBF-1270", ticketDir: "/state/tickets/NBF-1270", prs: reviewed, resumed: true, asked: true });
  assert.equal(/^1\. The feedback above says a pull request conflicts/m.test(asked), false, "a Respond to review round keeps the brief it had: no merge step is named unless the feedback names a conflict");
  assert.match(asked, /^1\. Read that feedback/m);
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

test("A11-82: both planner briefs tell the planner the ## Paths section, and a batch's brief also tells it to order tickets that touch one area in order.json", () => {
  const plan = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  for (const brief of [plan, batch]) {
    assert.ok(brief.includes("Each plan file ends with a `## Paths` section listing every file or directory its work will change"), "the section");
    assert.ok(brief.includes("`- \`<repo>:<path>\``"), "its bullet form");
    assert.ok(brief.includes("The board holds back another ticket whose work touches the same paths"));
  }
  assert.match(batch, /Tickets of one repository whose work touches the same area, directly or through a shared module, must be ordered in `order\.json` with `after`/);
  assert.equal(plan.includes("order.json"), false, "a ticket planned alone writes no order");
});

