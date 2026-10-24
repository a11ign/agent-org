// no-token: gh -- no real `gh` is reached: the report issue's comments, the close sweep and the trunk sweep run against the fake code host's world (A11-160, step 9)
//
// agent-org#1577: THE OUTSIDE HOME OF THE NIGHTLY ORG JOBS, AND ITS FLAG. Three things are pinned: the flag (absent, false, unusable, true), the posting the `watch` job gained here (it does not say a finding
// twice), and the property the epic asks of every clock function, that THE SECOND ACTOR FINDS THE WORK DONE AND DOES NOTHING. That last is driven against each of the three sweeps with the project's job as the
// first actor and the home as the second: POSITIVE CONTROL, NAMED (an emptiness assertion points at where its population is): each case first shows the first actor DID act, so "the second did nothing" is
// not the world having nothing to do.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { alreadyReported, findingKey, JOBS, OUTSIDE_NIGHTLY_FLAG, outsideNightlyOn, RECENT_MINUTES, runJobs, type Deps } from "./outside-nightly.ts";
import { closeOnePr } from "./close-rows-sweep.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import type { CommentRead } from "./plugins/contracts/code-host-rows.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { sweepTrunk } from "./trunk-sweep.ts";
import type { VerifyEffects } from "./verify-row.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const made: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `outside-nightly-${name}-`));
  made.push(dir);
  return dir;
};
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => forgetActivation());

/** A project directory whose `.agent-org/decisions.json` is `text` (absent when `undefined`). */
function project(text: string | undefined) {
  const dir = scratch("project");
  if (text !== undefined) {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(join(dir, ".agent-org", "decisions.json"), text);
  }
  return dir;
}
const diagnostics = () => {
  const lines: string[] = [];
  return { lines, diagnostic: (line: string) => { lines.push(line); }, state: {} as never };
};

test("1. the flag: absent file, absent key and `false` are OFF; `true` is ON; an unusable file is OFF and says which file", () => {
  assert.equal(OUTSIDE_NIGHTLY_FLAG, "outside.nightly");
  assert.equal(outsideNightlyOn(project(undefined), diagnostics()), false, "no decisions.json at all");
  assert.equal(outsideNightlyOn(project('{ "model-routing": true }'), diagnostics()), false, "the file's other keys do not turn it on");
  assert.equal(outsideNightlyOn(project('{ "outside.nightly": false }'), diagnostics()), false);
  const bad = diagnostics();
  assert.equal(outsideNightlyOn(project('{ "outside.nightly": "yes" }'), bad), false, "a value that is not a boolean turns everything off");
  assert.equal(bad.lines.length, 1, "and says so once");
  assert.equal(outsideNightlyOn(project('{ "model-routing": true, "outside.nightly": true }'), diagnostics()), true, "POSITIVE CONTROL: the reader does return true");
});

test("2. a finding is the same finding an hour later, and a different finding is not", () => {
  const first = "MAIN IS RED for 3h since 2026-10-16T08:00:00Z -- test x failed";
  assert.equal(findingKey("MAIN IS RED for at least 4h since at least 2026-10-16T08:00:00Z"), "MAIN IS RED for Nh since at least 2026-10-16T08:00:00Z");
  assert.equal(alreadyReported(first, ["MAIN IS RED for 4h since 2026-10-16T08:00:00Z -- test x failed\n"]), true, "the hour moved, the red main did not");
  assert.equal(alreadyReported(first, ["MAIN IS RED for 4h since 2026-10-16T09:00:00Z -- test x failed"]), false, "a different red since is a different finding");
  assert.equal(alreadyReported(first, []), false, "POSITIVE CONTROL: nothing said yet is not said");
});

const REPORT_ISSUE = 928;
/** The `gh` a caller hands the code host: the fake acts on its own state and never runs it, so anything that does fails the case. */
const noGh: Deps["gh"] = (args) => { throw new Error(`no gh expected, got ${args.join(" ")}`); };
type Reads = { couldNotAsk: true } | { malformed: unknown[] } | { ghPrints: () => string };
/**
 * A report issue as a list of comments with the time each was written, in the fake code host's world (`issue` puts one on another row of the repository). `postFails` is a code host that refuses the post. `reads`
 * replaces how the comments are read: a code host that `couldNotAsk` (`null`, which is never "no comment"), one that answers records that are `malformed`, or one that asks the `gh` the caller hands it (as
 * the plugin's read does) and gets what `ghPrints` prints or throws; the caller's own policy on that runner is what such a case is about.
 */
function issue928(comments: { at: number; body: string; issue?: number }[], { postFails = false, reads }: { postFails?: boolean; reads?: Reads } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "o/r";
  let clock = Date.UTC(2026, 9, 16, 11, 52);
  world.now = () => clock;
  const rowOf = (number: number) => world.rows.get(number) ?? world.rows.set(number, fakeRow(world, number)).get(number)!;
  rowOf(REPORT_ISSUE);
  for (const { at, body, issue = REPORT_ISSUE } of comments) rowOf(issue).comments.push({ id: world.nextCommentId++, body, createdAt: new Date(at).toISOString() });
  const before = rowOf(REPORT_ISSUE).comments.length;
  if (postFails) world.failures.set("commentOnIssue", new Error("HTTP 403"));
  const read: Partial<NonNullable<typeof host.rows>> = reads === undefined ? {}
    : "couldNotAsk" in reads ? { commentsSince: () => null }
      : "malformed" in reads ? { commentsSince: () => reads.malformed as CommentRead[] }
        : { commentsSince: ({ run }) => run(["fake-comments-since"]) as CommentRead[] | null };
  substituteCodeHost({ ...host, rows: { ...host.rows!, ...read } });
  const said: string[] = [];
  const advance = (minutes: number) => { clock += minutes * 60_000; };
  const gh: Deps["gh"] = reads !== undefined && "ghPrints" in reads ? reads.ghPrints : noGh;
  const deps = (code: number, output: string): Deps => ({ run: () => ({ code, output }), gh, now: () => clock, print: (line) => { said.push(line); } });
  return { get posted(): string[] { return rowOf(REPORT_ISSUE).comments.slice(before).map((comment) => comment.body); }, said, advance, deps };
}
const RED = "MAIN IS RED for 3h since 2026-10-16T08:52:00Z -- a test failed\n";
const AS_WATCH = { repo: "o/r", reportIssue: 928 };

test("3. watch: a quiet org-watch posts nothing; a finding is posted once, and the pair does not post it twice", () => {
  const quiet = issue928([]);
  assert.equal(runJobs(["watch"], AS_WATCH, quiet.deps(0, "")), 0);
  assert.deepEqual(quiet.posted, [], "exit 0 is silence");

  const world = issue928([]);
  assert.equal(runJobs(["watch"], AS_WATCH, world.deps(1, RED)), 0);
  assert.deepEqual(world.posted, [RED], "POSITIVE CONTROL: the first actor posted the finding");
  world.advance(15);
  assert.equal(runJobs(["watch"], AS_WATCH, world.deps(1, RED.replace("3h", "4h"))), 0);
  assert.equal(world.posted.length, 1, "the second actor, fifteen minutes later with the hour turned over, found it said and posted nothing");
  assert.match(world.said.join("\n"), /already carries this finding/);
});

test("4. watch: the project's job being the first actor is the same as the home being: a comment the home did not write counts, and one older than the window does not", () => {
  const theirs = issue928([{ at: Date.UTC(2026, 9, 16, 11, 37), body: RED }]);
  runJobs(["watch"], AS_WATCH, theirs.deps(1, RED));
  assert.deepEqual(theirs.posted, [], "the :37 comment is the first actor's");

  const stale = issue928([{ at: Date.UTC(2026, 9, 16, 11, 52) - (RECENT_MINUTES + 10) * 60_000, body: RED }]);
  runJobs(["watch"], AS_WATCH, stale.deps(1, RED));
  assert.deepEqual(stale.posted, [RED], "an hour-old comment is not 'already said': the first actor did not come this hour");

  const elsewhere = issue928([{ at: Date.UTC(2026, 9, 16, 11, 37), body: RED, issue: 7 }]);
  runJobs(["watch"], AS_WATCH, elsewhere.deps(1, RED));
  assert.deepEqual(elsewhere.posted, [RED], "the same words on another issue are not the report issue's");
});

test("5. watch: a comment read that fails posts anyway and says so; a post that fails is a failed job", () => {
  const unreadable: Reads[] = [{ couldNotAsk: true }, { ghPrints: () => { throw new Error("HTTP 502"); } }, { ghPrints: () => "<html>bad gateway</html>" }, { ghPrints: () => "{}" }];
  for (const reads of unreadable) {
    const blind = issue928([{ at: Date.UTC(2026, 9, 16, 11, 40), body: RED }], { reads });
    assert.equal(runJobs(["watch"], AS_WATCH, blind.deps(1, RED)), 0);
    assert.equal(blind.posted.length, 1, "not knowing is not 'already said'");
    assert.match(blind.said.join("\n"), /could not read #928's recent comments/);
  }
  const readable = issue928([{ at: Date.UTC(2026, 9, 16, 11, 40), body: RED }], { reads: { ghPrints: () => JSON.stringify([{ body: RED, created_at: "2026-10-16T11:40:00Z", issue_url: "https://api.github.com/repos/o/r/issues/928" }]) } });
  runJobs(["watch"], AS_WATCH, readable.deps(1, RED));
  assert.deepEqual(readable.posted, [], "CONTROL: a runner that answers a list of comments is read, and the finding is already said");

  const refused = issue928([], { postFails: true });
  assert.equal(runJobs(["watch"], AS_WATCH, refused.deps(1, RED)), 1, "a finding nobody was told of is not a pass");
});

test("5b. watch: a comment read that answers with records that are not comments is a read that failed: it posts anyway, says so, and does not crash", () => {
  const records: unknown[][] = [[{ body: RED.trim() }], [null], ["MAIN IS RED"], [{ body: 7, issue_url: "https://api.github.com/repos/o/r/issues/928" }]];
  for (const answer of records) {
    const world = issue928([], { reads: { malformed: answer } });
    assert.equal(runJobs(["watch"], AS_WATCH, world.deps(1, RED)), 0, JSON.stringify(answer));
    assert.deepEqual(world.posted, [RED], `not knowing is not 'already said': ${JSON.stringify(answer)}`);
    assert.match(world.said.join("\n"), /could not read #928's recent comments/, JSON.stringify(answer));
  }
  const wellFormed = issue928([], { reads: { malformed: [{ body: RED, created_at: "2026-10-16T11:40:00Z", issue_url: "https://api.github.com/repos/o/r/issues/928" }] } });
  assert.equal(runJobs(["watch"], AS_WATCH, wellFormed.deps(1, RED)), 0);
  assert.deepEqual(wellFormed.posted, [], "CONTROL: the same words as a well-formed comment ARE already said, so the cases above fail for being malformed");
});

test("6. every selected job runs even when an earlier one failed, the first non-zero is the exit, and each runs its own command against the repository named", () => {
  const ran: string[] = [];
  const envs: Record<string, string>[] = [];
  const deps: Deps = { run: (argv, env) => { ran.push(argv.join(" ")); envs.push(env); return { code: argv[0] === "trunk-sweep" ? 2 : 0, output: "" }; }, gh: noGh, now: () => 0, print: () => {} };
  assert.equal(runJobs(["ready-audit", "gateSweep", "closeRowsSweep"], AS_WATCH, deps), 2);
  assert.deepEqual(ran, ["ready:audit", "trunk-sweep", "close-rows-sweep --window=120"]);
  assert.ok(envs.every((env) => env.GITHUB_REPOSITORY === "o/r"), "the tool serves the project's repository, not the workflow's own");
  assert.deepEqual(Object.keys(JOBS), ["ready-audit", "gateSweep", "closeRowsSweep", "watch"], "the four jobs of the project's nightly.yml, by its names");
});

/** The fake code host, substituted, holding one open row of `o/r` and the merged pull request `pull` that closes it (the close sweep's world). */
function worldWithMergedRow(pull: number, { number, body, labels }: { number: number; body: string; labels: string[] }) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "o/r";
  world.rows.set(number, fakeRow(world, number, { title: `Row ${number}`, body, labels, milestone: { number: 1, title: "Out of release", description: null, dueOn: null } }));
  world.tail.closing.parents.set(number, 3900);
  world.pulls.set(pull, { number: pull, body: "", headRefName: "agent/x", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-10T18:00:00Z", createdAt: "2026-10-10T18:00:00Z", comments: [], closes: [{ number, labels: [] }] });
  world.tail.closing.mergeShas.set(pull, "abc1234");
  substituteCodeHost(host);
  return world;
}

// ---- the second actor against each sweep -------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("7. gateSweep: the first actor dispatches the gate for a tip with no check runs; the second reads check runs and dispatches nothing", () => {
  // The fake code host's world: the tip's check-run count starts at nothing, and a dispatch records itself and gives the tip its check run, which is what the dispatch does within seconds.
  const host = createFakeCodeHost();
  const { queue } = host.rowsWorld.tail;
  queue.mainSha = "abc1234";
  queue.checkRunTotals.set("abc1234", 0);
  queue.onDispatch = () => { queue.checkRunTotals.set("abc1234", 1); };
  substituteCodeHost(host);
  /** One actor's sweep: it must end 0, leave the dispatches at `dispatched`, and say what it found. */
  const actor = (dispatched: string[], found: RegExp, why: string) => {
    const out: string[] = [];
    const err: string[] = [];
    assert.equal(sweepTrunk("o/r", { out: (line) => out.push(line), err: (line) => err.push(line) }), 0, err.join("\n"));
    assert.deepEqual(queue.dispatched, dispatched, why);
    assert.match(out.join("\n"), found);
  };
  actor(["trunk.yml"], /carries ZERO check runs -- triggering trunk\.yml/, "POSITIVE CONTROL: the first actor dispatched");
  actor(["trunk.yml"], /already carries 1 check run/, "the second actor dispatched nothing");
});

test("8. closeRowsSweep: the first actor closes the row and files its verify row; the second finds it ALREADY CLOSED and closes and files nothing", () => {
  const body = "## Region\n\nsrc/foo.ts\n\n## Done-when\n\n1. The tests pass.\n2. One record per use is quoted on #4627.\n";
  const filed: number[] = [];
  const world = worldWithMergedRow(900, { number: 4630, body, labels: ["lane:any", "priority"] });
  const closes = (): number[] => world.calls.filter((call) => call.startsWith("closeCompletedRow #")).map((call) => Number(call.slice("closeCompletedRow #".length)));
  const verify: VerifyEffects = {
    findExisting: (build) => (build.number === 4630 && filed.length > 0 ? 9001 : null),
    create: () => { filed.push(9001); return 9001; },
    blockBy: () => {}, addSubIssue: () => {}, board: () => null,
  };
  const sweep = () => {
    const log = console.log;
    console.log = () => {};
    try { return closeOnePr(900, "o/r", { strip: () => {}, settle: () => ({ settled: true, refused: [] }), verify }); } finally { console.log = log; }
  };
  assert.deepEqual(sweep(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual([closes(), filed], [[4630], [9001]], "POSITIVE CONTROL: the first actor closed the row and filed its verify row");
  assert.deepEqual(sweep(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual([closes(), filed], [[4630], [9001]], "the second actor closed nothing and filed nothing");
});

// The workflow is the one place the flag, the token and the clocks meet, and `workflow-paths.ts` only checks that the paths it names exist. These are the properties a change to it must not lose.
test("9. the workflow: read-only by default, the id-token only on the one job, the token minted and used only when the flag reads true, never the repository's own token, and the clocks after the project's", () => {
  const text = readFileSync(join(SRC, "..", ".github", "workflows", "outside-nightly.yml"), "utf8");
  const workflow = parseYaml(text) as { on: { schedule: { cron: string }[] }; permissions: Record<string, string>; env: Record<string, string>; jobs: Record<string, { permissions: Record<string, string>; steps: { id?: string; if?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }[] }> };
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.schedule.map((entry) => entry.cron), ["47 6 * * *", "52 * * * *"], "after the project's 06:17 and :37, off the hour");
  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].permissions, { contents: "read", "id-token": "write" });
  const { steps } = jobs[0];
  const flag = steps.find((step) => step.id === "flag");
  assert.match(flag?.run ?? "", /outside-nightly --read-flag >> "\$GITHUB_OUTPUT"/);
  const octo = steps.find((step) => step.uses?.startsWith("octo-sts/action@"));
  assert.equal(octo?.if, "steps.flag.outputs.on == 'true'", "no token is minted while the flag is off");
  assert.equal(octo?.with?.scope, "${{ env.PROJECT_REPOSITORY }}");
  assert.equal(octo?.with?.identity, "outside-nightly");
  const runs = steps.filter((step) => /outside-nightly --repo=/.test(step.run ?? ""));
  assert.equal(runs.length, 2, "the nightly job and the hourly jobs");
  for (const step of runs) {
    assert.match(step.if ?? "", /^steps\.flag\.outputs\.on == 'true' && /, "a run is gated on the flag");
    assert.equal(step.env?.GH_TOKEN, "${{ steps.octo.outputs.token }}", "acts with the exchanged token");
  }
  assert.equal(workflow.env.PROJECT_REPOSITORY, "a11ign/a11ign");
  assert.doesNotMatch(JSON.stringify(workflow), /github\.token|secrets\.GITHUB_TOKEN/, "there is no fallback to this repository's own token");
  const project = steps.find((step) => step.with?.path === "project");
  assert.equal(project?.with?.["persist-credentials"], false, "the project checkout keeps no credential");
});
