// no-token: gh
// agent-org#1574: nothing here reaches GitHub. The reads run on the fake code host's rows (A11-160, step 8: they took an injected `run` answering `gh` argument lists), and the CLI tests put a fake `gh` first on PATH and hold no token.
/**
 * agent-org#1574: THE OUTSIDE HOME OF THE BOARD REPORT, SHIPPED OFF, AND ITS SECOND ACTOR DOES NOTHING.
 *
 * Three halves, each with the control that shows it can fail:
 *   - the FLAG (`outside.board` in the project's `decisions.json`): off for an absent file, an absent key, a false, a malformed file; on only for `true`.
 *   - the SECOND ACTOR, through the real commands with a fake `gh`: on a scheduled run with the flag on and the day's work done, each command writes nothing; with the work NOT done, or on a
 *     dispatch, or with the flag off, the same command goes on to write. The `postAbsence` marker is the summary check's own guard.
 *   - the WORKFLOW'S SHAPE (`.github/workflows/board-outside.yml`): the mint only after the flag is read on, no fallback to `GITHUB_TOKEN`, the tool at a release tag and never a branch.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parse as parseYaml } from "yaml";
import { HOME_CHECKOUT } from "../project-config.ts";
import { editionUrlIfPublished, outsideBoardOn, scheduledRunFindsWorkDone, OUTSIDE_BOARD_FLAG, editionTitle } from "../board-discussion.ts";
import { editionPosted } from "../board-report.ts";
import { postAbsence } from "../board-summary-check.ts";
import { REPO } from "../board-data.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

/** The fake code host serving the project's tracker, holding row #20 (the board report's issue) with the comments given, and the calls made to its rows. */
function tracker(comments: { body: string; createdAt: string }[] = []) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  host.rowsWorld.rows.set(20, fakeRow(host.rowsWorld, 20, { title: "The board report", labels: ["meta"], comments: comments.map((comment, id) => ({ id: id + 1, ...comment })) }));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { world: host.rowsWorld, calls: watched.calls, bodies: () => host.rowsWorld.rows.get(20)!.comments.map((comment) => comment.body) };
}

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DAY = "2026-10-16";
const scratch = () => tmpDir("board-outside-");

// ---------------------------------------------------------------- the flag

function flagWith(contents: string | null): { on: boolean; said: string[] } {
  const dir = scratch();
  const path = join(dir, "decisions.json");
  if (contents !== null) writeFileSync(path, contents);
  const said: string[] = [];
  const on = outsideBoardOn({ path, diagnostic: (line) => said.push(line) });
  return { on, said };
}

test("#1574: the flag is on only for `true`, and off for every other state of the file, quietly except a file that cannot be used", () => {
  assert.equal(OUTSIDE_BOARD_FLAG, "outside.board");
  assert.equal(flagWith('{ "outside.board": true }').on, true, "the positive control: the flag set reads on");
  assert.equal(flagWith(null).on, false, "no file");
  assert.equal(flagWith("{}").on, false, "no key");
  assert.equal(flagWith('{ "outside.board": false }').on, false, "false");
  assert.equal(flagWith('{ "model-routing": true }').on, false, "another key on is not this one");
  const malformed = flagWith("{ not json");
  assert.equal(malformed.on, false, "a malformed file turns every key off");
  assert.equal(malformed.said.length, 1, "and says which file, once");
  assert.equal(flagWith('{ "outside.board": "true" }').on, false, "a string is not a boolean, and the reader refuses the file");
});

test("#1574: only a SCHEDULED run with the flag on is a second actor", () => {
  assert.equal(scheduledRunFindsWorkDone({ on: true, env: { GITHUB_EVENT_NAME: "schedule" } }), true, "the positive control");
  assert.equal(scheduledRunFindsWorkDone({ on: true, env: { GITHUB_EVENT_NAME: "workflow_dispatch" } }), false, "a dispatch is a person asking, as the republish path is");
  assert.equal(scheduledRunFindsWorkDone({ on: true, env: {} }), false, "a run outside Actions has no event");
  assert.equal(scheduledRunFindsWorkDone({ on: false, env: { GITHUB_EVENT_NAME: "schedule" } }), false, "flag off: every actor behaves as it did");
});

// ---------------------------------------------------------------- the reads that say "done"

test("#1574: the report is posted when a comment of today's title is on the issue, and a failed read is not 'posted'", () => {
  const now = new Date("2026-10-16T07:10:00Z");
  const title = `# ${editionTitle(DAY)}`;
  const t = tracker([{ body: `# ${editionTitle("2026-10-15")}\nyesterday's edition`, createdAt: "2026-10-15T07:10:00Z" }, { body: "a comment of someone's", createdAt: "2026-10-16T06:00:00Z" }]);
  assert.equal(editionPosted({ day: DAY, issue: "20", now }), false, "no comment of today's title on the issue");
  t.world.rows.get(20)!.comments.push({ id: 90, body: `${title}\nthe edition`, createdAt: "2026-10-12T07:10:00Z" });
  assert.equal(editionPosted({ day: DAY, issue: "20", now }), false, "a comment of today's title from before the window is not today's");
  t.world.rows.get(20)!.comments.push({ id: 91, body: `${title}\nthe edition`, createdAt: "2026-10-16T07:05:00Z" });
  assert.equal(editionPosted({ day: DAY, issue: "20", now }), true, "one inside it");
  const asked = t.calls.filter((call) => call.op === "editionCommentCountOf").map((call) => call.request);
  assert.ok(asked.every((request) => request.since === "2026-10-14T07:10:00.000Z"), "only the last 48 hours are read: one comment per day for months is not paged through");
  assert.ok(asked.every((request) => request.title === title && request.issue === "20"), "the title is the one `render` writes");
  t.world.failures.set("editionCommentCountOf", new Error("HTTP 502"));
  assert.equal(editionPosted({ day: DAY, issue: "20", now }), false, "a skip on a failed read would post nothing and call it done");
});

/** The fake code host holding the project's Discussions: a board-editions category and `editions` in it. */
function discussions(editions: { title: string; url: string }[]) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  host.rowsWorld.reports.board.discussions.set(REPO, { repositoryId: "R", categories: [{ id: "C", slug: "board-editions" }], editions: editions.map((e, i) => ({ id: `D${i}`, body: "", ...e })) });
  substituteCodeHost(host);
  return host;
}

test("#1574: the edition is published when a Discussion of today's title exists; absent, and a failed read, are null", () => {
  const url = "https://github.com/x/y/discussions/9";
  discussions([{ title: editionTitle(DAY), url }]);
  assert.equal(editionUrlIfPublished({ day: DAY }), url);
  discussions([{ title: editionTitle("2026-10-15"), url }]);
  assert.equal(editionUrlIfPublished({ day: DAY }), null, "yesterday's is not today's");
  discussions([{ title: editionTitle(DAY), url }]).rowsWorld.failures.set("discussionCategoriesOf", new Error("HTTP 502"));
  assert.equal(editionUrlIfPublished({ day: DAY }), null);
});

test("#1574: the summary check posts once however many actors run it, in either order", () => {
  const t = tracker();
  assert.equal(postAbsence({ day: DAY, issue: "20", reminder: true }), true, "the first actor writes");
  assert.equal(postAbsence({ day: DAY, issue: "20", reminder: false }), false, "the second, in the other mode, finds the marker");
  assert.equal(postAbsence({ day: "2026-10-17", issue: "20", reminder: true }), true, "positive control: another day is not 'done'");
  assert.equal(t.bodies().length, 2);
  assert.match(t.bodies()[0], /no summary for 2026-10-16/);
  assert.match(t.bodies()[0], /Posted automatically at 07:15 London/);
  assert.match(t.bodies()[1], /no summary for 2026-10-17/);
});

// ---------------------------------------------------------------- the commands, run for real against a fake gh

/** A project the tool serves: a directory holding the real project's declaration and the switches under test, with a fake `gh` first on PATH that logs every call. */
function runCommand(program: string, args: string[], { flag, event, posted, edition }: { flag: boolean; event: string | undefined; posted: boolean; edition: boolean; }) {
  const project = scratch();
  mkdirSync(join(project, ".agent-org"));
  // Everything the declaration names (roles, plugins) is the real project's, linked; only the switches are the test's own.
  for (const name of readdirSync(join(HOME_CHECKOUT, ".agent-org"))) if (name !== "decisions.json") symlinkSync(join(HOME_CHECKOUT, ".agent-org", name), join(project, ".agent-org", name));
  writeFileSync(join(project, ".agent-org", "decisions.json"), JSON.stringify({ "outside.board": flag }));
  // The tool serves the project the HOST file names, in whichever layout it runs (the monorepo's `beside` would otherwise answer first): a host file of one project, this one.
  const bin = scratch();
  const host = join(scratch(), "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: project, binDir: bin, gh: { workers: bin, leads: bin, leadsHeader: [], leadsWorkspaces: [] }, primary: "test", projects: [{ id: "test", checkout: project }] }));
  const log = join(bin, "calls.log");
  const answers = {
    comments: posted ? "1\n" : "0\n",
    editions: JSON.stringify({ data: { repository: { discussions: { nodes: edition ? [{ id: "D", title: editionTitle(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date())), url: "https://github.com/x/y/discussions/9" }] : [] } } } }),
    categories: JSON.stringify({ data: { repository: { id: "R", discussionCategories: { nodes: [{ id: "C", slug: "board-editions" }] } } } }),
  };
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ").slice(0, 200) + "\\n");
const answers = ${JSON.stringify(answers)};
const joined = args.join(" ");
if (/issues\\/\\d+\\/comments/.test(joined)) process.stdout.write(answers.comments);
else if (joined.includes("discussionCategories")) process.stdout.write(answers.categories);
else if (joined.includes("discussions(")) process.stdout.write(answers.editions);
else { process.stderr.write("fake gh: unrouted " + joined.slice(0, 80) + "\\n"); process.exit(1); }
`);
  chmodSync(join(bin, "gh"), 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "none", AGENT_ORG_HOST: host };
  if (event === undefined) delete env.GITHUB_EVENT_NAME; else env.GITHUB_EVENT_NAME = event;
  const done = spawnSync(process.execPath, [join(SRC, program), ...args], { cwd: project, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: done.status, out: done.stdout, err: done.stderr, calls };
}

const writes = (calls: string[]) => calls.filter((c) => /issue comment|createDiscussion|updateDiscussion/.test(c));

test("#1574: board:report --post on a scheduled run with the flag on and the edition posted collects nothing and posts nothing", () => {
  const done = runCommand("board-report.ts", ["--post", "--issue=20"], { flag: true, event: "schedule", posted: true, edition: false });
  assert.equal(done.status, 0, done.err);
  assert.match(done.out, /already on issue 20; nothing posted/);
  assert.equal(done.calls.length, 1, "the only call is the one comments read");
  assert.match(done.calls[0], /issues\/20\/comments/);
  assert.deepEqual(writes(done.calls), []);
});

test("#1574: the same command goes on when it should: the edition is not posted, the run is a dispatch, the flag is off, or there is no event", () => {
  const goesOn = (done: ReturnType<typeof runCommand>) => !/nothing posted/.test(done.out) && done.calls.some((c) => !/issues\/\d+\/comments/.test(c));
  assert.ok(goesOn(runCommand("board-report.ts", ["--post", "--issue=20"], { flag: true, event: "schedule", posted: false, edition: false })), "not posted yet");
  assert.ok(goesOn(runCommand("board-report.ts", ["--post", "--issue=20"], { flag: true, event: "workflow_dispatch", posted: true, edition: false })), "a dispatch");
  assert.ok(goesOn(runCommand("board-report.ts", ["--post", "--issue=20"], { flag: false, event: "schedule", posted: true, edition: false })), "flag off");
  assert.ok(goesOn(runCommand("board-report.ts", ["--post", "--issue=20"], { flag: true, event: undefined, posted: true, edition: false })), "no event");
});

test("#1574: board:document --discussion on a scheduled run with the flag on and the edition published writes nothing; every other case goes on to look for the summary", () => {
  const skipped = runCommand("board-document.ts", ["--discussion"], { flag: true, event: "schedule", posted: false, edition: true });
  assert.equal(skipped.status, 0, skipped.err);
  assert.match(skipped.out, /already published; nothing written/);
  assert.deepEqual(writes(skipped.calls), []);
  for (const [name, run] of Object.entries({
    "no edition yet": { flag: true, event: "schedule", posted: false, edition: false },
    "a dispatch": { flag: true, event: "workflow_dispatch", posted: false, edition: true },
    "flag off": { flag: false, event: "schedule", posted: false, edition: true },
  })) {
    const done = runCommand("board-document.ts", ["--discussion"], run);
    assert.doesNotMatch(done.out, /nothing written/, name);
    assert.notEqual(done.status, 0, `${name}: with no committed summary for today the command refuses rather than skipping (${done.err.slice(0, 120)})`);
  }
});

test("#1574: board-discussion --outside-on answers by its exit code, and a flag it does not know is the refusal the workflow reads as off", () => {
  assert.equal(runCommand("board-discussion.ts", ["--outside-on"], { flag: true, event: undefined, posted: false, edition: false }).status, 0);
  assert.equal(runCommand("board-discussion.ts", ["--outside-on"], { flag: false, event: undefined, posted: false, edition: false }).status, 1);
  assert.equal(runCommand("board-discussion.ts", ["--no-such-flag"], { flag: true, event: undefined, posted: false, edition: false }).status, 2, "an older tag's answer");
});

// ---------------------------------------------------------------- the workflow's shape

type Step = { id?: string; name?: string; if?: string; uses?: string; env?: Record<string, string>; run?: string; with?: Record<string, string> };
type Workflow = { on: { schedule: { cron: string }[]; workflow_dispatch: unknown }; permissions: Record<string, string>; jobs: { act: { permissions: Record<string, string>; steps: Step[] } } };
const WORKFLOW_PATH = ".github/workflows/board-outside.yml";
const workflowText = readFileSync(`${ROOT}${WORKFLOW_PATH}`, "utf8");
const workflow = parseYaml(workflowText) as Workflow;
const steps = workflow.jobs.act.steps;
const step = (fragment: string): Step => {
  const found = steps.filter((s) => (s.name ?? "").includes(fragment));
  assert.equal(found.length, 1, `exactly one step is named like "${fragment}"`);
  return found[0];
};
const withoutComments = (text: string) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("#1574: the workflow mints only after the flag is read on, never falls back to GITHUB_TOKEN, and writes only with the minted token", () => {
  const index = (s: Step) => steps.indexOf(s);
  const flag = step("Is outside.board on");
  const mint = step("Mint the project token");
  assert.equal(mint.uses?.split("@")[0], "octo-sts/action");
  assert.equal(mint.with?.identity, "outside-board");
  assert.match(String(mint.with?.scope), /PROJECT_REPOSITORY/, "scoped to the project, which is a11ign/a11ign");
  assert.match(workflowText, /PROJECT_REPOSITORY: a11ign\/a11ign/);
  assert.equal(mint.if, "steps.flag.outputs.on == 'true'", "a switched-off run mints nothing");
  assert.ok(index(flag) < index(mint), "the flag is read before the mint");
  const writers = steps.filter((s) => s.env?.GH_TOKEN !== undefined);
  assert.ok(writers.length >= 4, "the republish check, the edition and the two summary checks");
  for (const s of writers) {
    assert.equal(s.env?.GH_TOKEN, "${{ steps.octo-sts.outputs.token }}", `${s.name}: the minted token`);
    assert.ok(index(mint) < index(s), `${s.name}: after the mint`);
    assert.match(String(s.if), /steps\.flag\.outputs\.on == 'true'/, `${s.name}: only with the flag on`);
  }
  assert.doesNotMatch(withoutComments(workflowText), /github\.token|secrets\.GITHUB_TOKEN/, "no fallback to the token that cannot write the project");
  assert.deepEqual(workflow.jobs.act.permissions, { contents: "read", "id-token": "write" });
});

test("#1574: the tool is the newest STABLE release tag, refuses when there is none, and the project is checked out whole", () => {
  const tag = step("The tool at the newest stable release tag");
  assert.match(String(tag.run), /tag --list 'v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*' --sort=-v:refname/);
  assert.match(String(tag.run), /exit 1/, "no tag is a refusal, not a branch");
  assert.doesNotMatch(String(tag.run), /origin\/main|checkout --detach main/, "never the branch");
  const project = steps.find((s) => s.with?.path === "project")!;
  assert.equal(project.with?.repository, "a11ign/a11ign");
  assert.equal(project.with?.["fetch-depth"], 0, "the merge count reads the whole history");
  const toolCheckout = steps.find((s) => s.with?.path === "tool")!;
  assert.equal(toolCheckout.with?.["fetch-depth"], 0, "the tags");
  for (const s of steps.filter((s) => (s.run ?? "").includes("agent-org board"))) assert.equal((s as { "working-directory"?: string })["working-directory"], "project", `${s.name}: the tool serves the project it is run in`);
});

test("#1574: the schedule is the pair of crons for each of the three runs, and a dispatch republishes or does nothing", () => {
  const crons = workflow.on.schedule.map((s) => s.cron).sort();
  assert.deepEqual(crons, ["17 6 * * *", "17 7 * * *", "47 6 * * *", "47 7 * * *", "8 7 * * *", "8 8 * * *"].sort());
  const mode = String(step("Which run is this in London").run);
  assert.match(mode, /08:\*\) MODE=report/);
  assert.match(mode, /07:1\*\) MODE=reminder/);
  assert.match(mode, /07:4\*\) MODE=refuse/);
  assert.match(mode, /MODE=republish; else MODE=none/);
  assert.equal(step("Republish is permitted").run?.includes("board-discussion --exists"), true);
});
