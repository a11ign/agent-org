// no-token: gh -- no real `gh` is reached: the comment reads and posts are injected, the sweep's `gh` is a fake, and the trunk sweep runs against a stub `gh` first on PATH
//
// agent-org#1577: THE OUTSIDE HOME OF THE NIGHTLY ORG JOBS, AND ITS FLAG. Three things are pinned: the flag (absent, false, unusable, true), the posting the `watch` job gained here (it does not say a finding
// twice), and the property the epic asks of every clock function, that THE SECOND ACTOR FINDS THE WORK DONE AND DOES NOTHING. That last is driven against each of the three sweeps with the project's job as the
// first actor and the home as the second: POSITIVE CONTROL, NAMED (an emptiness assertion points at where its population is): each case first shows the first actor DID act, so "the second did nothing" is
// not the world having nothing to do.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { alreadyReported, findingKey, JOBS, OUTSIDE_NIGHTLY_FLAG, outsideNightlyOn, RECENT_MINUTES, runJobs, type Deps } from "./outside-nightly.ts";
import { closeOnePr } from "./close-rows-sweep.ts";
import type { VerifyEffects } from "./verify-row.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const made: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `outside-nightly-${name}-`));
  made.push(dir);
  return dir;
};
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

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

/** A report issue as a list of comments with the time each was written; `gh` answers the two calls `postReport` makes. */
function issue928(comments: { at: number; body: string; issue?: number }[], { readFails = false, postFails = false } = {}) {
  const posted: string[] = [];
  let clock = Date.UTC(2026, 9, 16, 11, 52);
  const issueUrl = (n: number) => `https://api.github.com/repos/o/r/issues/${n}`;
  const gh: Deps["gh"] = (args) => {
    if (args[0] === "api") {
      if (readFails) throw new Error("HTTP 502");
      const since = Date.parse(/since=([^&]+)/.exec(args.join(" "))?.[1] ?? "");
      // `--paginate --slurp`: one array per page.
      const page = comments.map((c) => ({ body: c.body, created_at: new Date(c.at).toISOString(), issue_url: issueUrl(c.issue ?? 928) }));
      return JSON.stringify([page.filter((c) => Date.parse(c.created_at) >= since)]);
    }
    if (args[0] === "issue" && args[1] === "comment") {
      if (postFails) throw new Error("HTTP 403");
      posted.push(args[args.indexOf("--body") + 1]);
      comments.push({ at: clock, body: args[args.indexOf("--body") + 1] });
      return "";
    }
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`);
  };
  const said: string[] = [];
  const advance = (minutes: number) => { clock += minutes * 60_000; };
  const deps = (code: number, output: string): Deps => ({ run: () => ({ code, output }), gh, now: () => clock, print: (line) => { said.push(line); } });
  return { posted, said, advance, deps, comments };
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
  const blind = issue928([{ at: Date.UTC(2026, 9, 16, 11, 40), body: RED }], { readFails: true });
  assert.equal(runJobs(["watch"], AS_WATCH, blind.deps(1, RED)), 0);
  assert.equal(blind.posted.length, 1, "not knowing is not 'already said'");
  assert.match(blind.said.join("\n"), /could not read #928's recent comments/);

  const refused = issue928([], { postFails: true });
  assert.equal(runJobs(["watch"], AS_WATCH, refused.deps(1, RED)), 1, "a finding nobody was told of is not a pass");
});

test("6. every selected job runs even when an earlier one failed, the first non-zero is the exit, and each runs its own command against the repository named", () => {
  const ran: string[] = [];
  const envs: Record<string, string>[] = [];
  const deps: Deps = { run: (argv, env) => { ran.push(argv.join(" ")); envs.push(env); return { code: argv[0] === "trunk-sweep" ? 2 : 0, output: "" }; }, gh: () => "", now: () => 0, print: () => {} };
  assert.equal(runJobs(["ready-audit", "gateSweep", "closeRowsSweep"], AS_WATCH, deps), 2);
  assert.deepEqual(ran, ["ready:audit", "trunk-sweep", "close-rows-sweep --window=120"]);
  assert.ok(envs.every((env) => env.GITHUB_REPOSITORY === "o/r"), "the tool serves the project's repository, not the workflow's own");
  assert.deepEqual(Object.keys(JOBS), ["ready-audit", "gateSweep", "closeRowsSweep", "watch"], "the four jobs of the project's nightly.yml, by its names");
});

// ---- the second actor against each sweep -------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("7. gateSweep: the first actor dispatches the gate for a tip with no check runs; the second reads check runs and dispatches nothing", () => {
  const dir = scratch("stub");
  const state = join(dir, "state");
  const calls = join(dir, "calls");
  writeFileSync(state, "0");
  writeFileSync(calls, "");
  // A stub `gh`: the tip's check-run count is the state file; a `workflow run` records itself and gives the tip its check run, which is what the dispatch does within seconds.
  writeFileSync(join(dir, "gh"), [
    "#!/bin/sh",
    'case "$*" in',
    '  "api repos/o/r/commits/main --jq .sha") echo abc1234 ;;',
    `  *check-runs*) cat "${state}" ;;`,
    `  "workflow run trunk.yml --repo o/r") echo run >> "${calls}"; echo 1 > "${state}" ;;`,
    '  *) echo "stub gh does not know: $*" >&2; exit 9 ;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(dir, "gh"), 0o755);
  const sweep = () => spawnSync(process.execPath, [join(SRC, "trunk-sweep.ts")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r" }, encoding: "utf8" });
  const first = sweep();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(calls, "utf8"), "run\n", "POSITIVE CONTROL: the first actor dispatched");
  const second = sweep();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(calls, "utf8"), "run\n", "the second actor dispatched nothing");
  assert.match(second.stdout, /already carries 1 check run/);
});

test("8. closeRowsSweep: the first actor closes the row and files its verify row; the second finds it ALREADY CLOSED and closes and files nothing", () => {
  const body = "## Region\n\nsrc/foo.ts\n\n## Done-when\n\n1. The tests pass.\n2. One record per use is quoted on #4627.\n";
  let open = true;
  const closes: number[] = [];
  const filed: number[] = [];
  const gh_ = (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ mergedAt: "2026-10-10T18:00:00Z", mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [{
        number: 4630, state: open ? "OPEN" : "CLOSED", title: "Row 4630", body, milestone: { title: "Out of release" }, parent: { number: 3900 },
        labels: { nodes: [{ name: "lane:any" }, { name: "priority" }] }, timelineItems: { nodes: [] } }] } });
    }
    if (args[0] === "issue" && args[1] === "close") { open = false; closes.push(Number(args[2])); return ""; }
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`);
  };
  const verify: VerifyEffects = {
    findExisting: (build) => (build.number === 4630 && filed.length > 0 ? 9001 : null),
    create: () => { filed.push(9001); return 9001; },
    blockBy: () => {}, addSubIssue: () => {}, board: () => null,
  };
  const sweep = () => {
    const log = console.log;
    console.log = () => {};
    try { return closeOnePr(900, "o/r", { gh_, strip: () => {}, settle: () => ({ settled: true, refused: [] }), verify }); } finally { console.log = log; }
  };
  assert.deepEqual(sweep(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual([closes, filed], [[4630], [9001]], "POSITIVE CONTROL: the first actor closed the row and filed its verify row");
  assert.deepEqual(sweep(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual([closes, filed], [[4630], [9001]], "the second actor closed nothing and filed nothing");
});
