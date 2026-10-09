// no-token: gh -- `gh` and `agent-org` are fake executables on a PATH this file builds; the real script runs under bash against them and nothing reaches GitHub or the host
/**
 * a11ign/a11ign#3627: the weekly token-efficiency post (`host/trace-weekly-post.sh`, `trace-weekly.{service,timer}.in`).
 *
 * The script is run for real, under bash, with a fake `gh` that records every comment it is asked to post and a fake `agent-org` that prints a
 * fixture report. The report lines that matter (`WEEK ...`, the GitHub footer) are COPIED from a real `trace -- --aggregate` run of 2026-10-05, so
 * the parser is tied to the format the tool prints and not to one this file made up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";

// Resolved by path and NOT imported from `host-units.ts`: that import would charge this file `History: full` (work-gate.test.ts, #2174). The tool-form test is in host-units.test.ts for that reason.
const SHIPPED_DIR = fileURLToPath(new URL("../../host/", import.meta.url));
const SCRIPT = join(SHIPPED_DIR, "trace-weekly-post.sh");
const COMMENT_LIMIT = 65_536; // GitHub's limit on a comment, in characters
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLOCK = (name: string) => readFileSync(join(SHIPPED_DIR, name), "utf8");

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

const WEEK_BEFORE = "WEEK 2026-09-21 .. 2026-09-28  complete";
const WEEK_COMPLETE = "WEEK 2026-09-28 .. 2026-10-05  complete";
const WEEK_PARTIAL = "WEEK 2026-09-28 .. 2026-10-05  PARTIAL, not compared: GitHub's events are not yet read for 335 of its merged rows (a second run continues; the claims, reviews, queue entries and CI runs of those rows are missing)";
const WEEK_CURRENT = "WEEK 2026-10-05 .. 2026-10-12  PARTIAL, not compared: the week is not over; GitHub's events are not yet read for 22 of its merged rows";
const footer = (unread: number) => `GitHub: 150 REST calls (gh api, budget 150); 1214 events read, 1214 new to the store; rows whose GitHub events are not yet read: ${unread}`;

/** A report whose reported week (the one before the last) is `reported`, ending in the footer `unread` names. */
const report = ({ reported, unread, filler = [] }: { reported: string; unread: number; filler?: string[] }) =>
  ["TRACE --AGGREGATE (a reading at a moment: re-run it, do not quote it)", "", "DEFINITIONS", ...filler, "", WEEK_BEFORE, "", reported, "", WEEK_CURRENT, "", footer(unread), ""].join("\n");

const DECLARED = { tracker: [{ repo: "acme/widgets" }], units: { traceWeeklyIssue: 4242 } };

type Run = { status: number | null; stderr: string; stdout: string; comments: string[]; trace: string[]; gh: string[] };
type Setup = {
  declaration?: unknown; reports: string[]; remaining?: string[]; ghFails?: boolean; traceFails?: boolean; env?: Record<string, string>; resource?: string;
};

/** Runs the real script against fake `gh` and `agent-org`. `reports[n]` is what pass n+1 prints (the last one repeats). */
function run({ declaration = DECLARED, reports, remaining = ["4000"], ghFails = false, traceFails = false, env = {}, resource = "core" }: Setup): Run {
  const dir = tmpDir("trace-weekly-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The script calls a bare `node`, and the PATH below names only system directories: a runner whose node is in a toolcache directory (CI's is) would
  // find none (`node: command not found`, 9 of these tests failed on agent-org#234). The node running this file is the one the script gets.
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(dir, "comments"));
  reports.forEach((text, index) => writeFileSync(join(dir, `report-${index + 1}`), text));
  writeFileSync(join(dir, "report-last"), reports[reports.length - 1]);
  writeFileSync(join(dir, "remaining"), `${remaining.join("\n")}\n`);
  if (ghFails) writeFileSync(join(dir, "gh-fails"), "");
  if (traceFails) writeFileSync(join(dir, "trace-fails"), "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
case "$1" in
  api)
    case "$2" in
      user) echo fake-account ;;
      repos/*)
        r=$(head -n 1 "${dir}/remaining")
        if [ "$(wc -l < "${dir}/remaining")" -gt 1 ]; then tail -n +2 "${dir}/remaining" > "${dir}/remaining.next"; mv "${dir}/remaining.next" "${dir}/remaining"; fi
        printf 'HTTP/2.0 200 OK\\r\\nX-Ratelimit-Limit: 5000\\r\\nX-Ratelimit-Remaining: %s\\r\\nX-Ratelimit-Resource: ${resource}\\r\\n\\r\\n{}\\n' "$r" ;;
    esac ;;
  issue)
    [ -f "${dir}/gh-fails" ] && { echo "HTTP 502" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && file="$2"; shift; done
    n=$(ls "${dir}/comments" | wc -l)
    cp "$file" "${dir}/comments/$(printf '%03d' "$n").md" ;;
esac
`);
  writeFileSync(join(bin, "agent-org"), `#!/bin/sh
echo "$@" >> "${dir}/trace.log"
[ -f "${dir}/trace-fails" ] && { echo "trace blew up" >&2; exit 1; }
n=$(( $(cat "${dir}/counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "${dir}/counter"
f="${dir}/report-$n"
[ -f "$f" ] || f="${dir}/report-last"
cat "$f"
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "agent-org"), 0o755);
  const declarationPath = join(dir, "project.json");
  if (declaration !== null) writeFileSync(declarationPath, JSON.stringify(declaration));
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8", cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, AGENT_ORG_PROJECT: declarationPath, ...env },
  });
  const lines = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : []);
  const comments = readdirSync(join(dir, "comments")).sort().map((name) => readFileSync(join(dir, "comments", name), "utf8"));
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, comments, trace: lines("trace.log"), gh: lines("gh.log") };
}

/** The text between a comment's fences: what was posted of the report. */
const fenced = (comment: string) => comment.split("````\n")[1];

// --- the post -------------------------------------------------------------------------------------------------------------------------

test("#3627: the report is posted on the DECLARED repository and issue, under a one-line header naming the week and COMPLETE", () => {
  const result = run({ reports: [report({ reported: WEEK_COMPLETE, unread: 0 })] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.comments.length, 1, "POSITIVE CONTROL for every refusal below: this declaration, this report, and one comment is posted");
  const comment = result.comments[0];
  assert.match(comment.split("\n")[0], /^\*\*COMPLETE\*\* weekly token-efficiency report, week 2026-09-28 \.\. 2026-10-05 \(UTC\): 1 pass\(es\), GitHub events unread for 0 rows; posted \d{4}-\d{2}-\d{2}T/);
  assert.ok(result.gh.some((line) => /^issue comment 4242 --repo acme\/widgets --body-file \S+$/.test(line)), `the comment goes to acme/widgets#4242, not a default: ${JSON.stringify(result.gh)}`);
  assert.ok(result.gh.some((line) => line.startsWith("api repos/acme/widgets -i")), "the pool is read off a real call's headers, not off `gh api rate_limit`");
  assert.ok(!result.gh.some((line) => line.includes("rate_limit")));
});

test("#3627: a PARTIAL reported week says PARTIAL and why, in the header, and is still posted", () => {
  const result = run({ reports: [report({ reported: WEEK_PARTIAL, unread: 0 })] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.comments[0].split("\n")[0], /^\*\*PARTIAL \(GitHub's events are not yet read for 335 of its merged rows/);
  assert.match(result.comments[0].split("\n")[0], /week 2026-09-28 \.\. 2026-10-05/, "the week reported is the one BEFORE the week in progress, which the report ends with");
});

test("#3627: `trace` is asked for a window it can answer: a Monday (UTC) between 14 and 20 days back, never its four-week default", () => {
  const result = run({ reports: [report({ reported: WEEK_COMPLETE, unread: 0 })] });
  const asked = result.trace[0];
  const since = /--since (\d{4}-\d{2}-\d{2})/.exec(asked)?.[1];
  assert.ok(since, `the trace call carries --since: ${asked}`);
  const sinceMs = Date.parse(since);
  assert.equal(new Date(sinceMs).getUTCDay(), 1, "a Monday");
  const age = (Date.now() - sinceMs) / MS_PER_DAY;
  assert.ok(age >= 14 && age < 21 + 1, `${since} is the Monday two weeks before this week's (${age.toFixed(2)} days back)`);
  assert.match(asked, /^trace -- --aggregate --since \S+ --calls 1500$/, "the first pass spends at most a pass's worth of calls");
});

// --- the declaration is read, never defaulted ------------------------------------------------------------------------------------------

test("#3627: a missing declaration FAILS and posts nothing -- the file, the repository, the issue, and an issue that is not a number", () => {
  const good = [report({ reported: WEEK_COMPLETE, unread: 0 })];
  const cases: Array<[string, unknown, RegExp]> = [
    ["no file at all", null, /ENOENT|does not declare|no such file/i],
    ["no tracker repository", { units: { traceWeeklyIssue: 4242 } }, /does not declare tracker\[0\]\.repo/],
    ["no units.traceWeeklyIssue", { tracker: [{ repo: "acme/widgets" }], units: {} }, /does not declare units\.traceWeeklyIssue/],
    ["an issue that is a string", { tracker: [{ repo: "acme/widgets" }], units: { traceWeeklyIssue: "928" } }, /does not declare units\.traceWeeklyIssue/],
    ["an issue of zero", { tracker: [{ repo: "acme/widgets" }], units: { traceWeeklyIssue: 0 } }, /does not declare units\.traceWeeklyIssue/],
  ];
  for (const [name, declaration, message] of cases) {
    const result = run({ declaration, reports: good });
    assert.notEqual(result.status, 0, `${name}: the unit must FAIL`);
    assert.match(result.stderr, message, name);
    assert.deepEqual([result.comments.length, result.trace.length], [0, 0], `${name}: nothing was run or posted on a guess`);
  }
});

// --- size: split, never truncated -------------------------------------------------------------------------------------------------------

test("#3627: a report over the comment limit is SPLIT across comments, every one under the limit, and the parts are the whole report", () => {
  const filler = Array.from({ length: 2400 }, (_, index) => `- definition ${index}: ${"x".repeat(60)}`); // about 160 KB
  const text = report({ reported: WEEK_COMPLETE, unread: 0, filler });
  assert.ok(Buffer.byteLength(text) > 2 * COMMENT_LIMIT, "the fixture really is over the limit, twice");
  const result = run({ reports: [text] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.comments.length >= 3, `${result.comments.length} comments`);
  for (const comment of result.comments) assert.ok(comment.length < COMMENT_LIMIT, `a comment of ${comment.length} characters is over GitHub's limit`);
  assert.equal(result.comments.map(fenced).join(""), text, "NOT TRUNCATED: the parts, joined, are the report byte for byte");
  assert.match(result.comments[0].split("\n")[0], new RegExp(`\\(part 1 of ${result.comments.length}\\)$`));
  assert.match(result.comments[1].split("\n")[0], new RegExp(`part 2 of ${result.comments.length}$`));
});

// --- a failure is a failed unit ----------------------------------------------------------------------------------------------------------

test("#3627: every way the report or the post can fail leaves a NON-ZERO status, and a failed run posts nothing it cannot stand behind", () => {
  const good = report({ reported: WEEK_COMPLETE, unread: 0 });
  const failures: Array<[string, Setup, RegExp]> = [
    ["the post is refused", { reports: [good], ghFails: true }, /posting part 1 of 1 on acme\/widgets#4242 failed/],
    ["trace exits non-zero", { reports: [good], traceFails: true }, /exited non-zero/],
    ["the footer has no unread count", { reports: [good.replace(/rows whose GitHub events are not yet read: \d+/, "")] }, /its footer changed/],
    ["the report names no finished week", { reports: [[WEEK_CURRENT, footer(0)].join("\n")] }, /fewer than two WEEK lines/],
    ["another pool answers the header read", { reports: [good], resource: "search" }, /cannot read the core pool/],
    ["the pool is too low to list the merged rows at all", { reports: [good], remaining: ["1050"] }, /too few calls to list the merged rows, nothing to post/],
  ];
  for (const [name, setup, message] of failures) {
    const result = run(setup);
    assert.notEqual(result.status, 0, `${name}: the unit must FAIL, not end green with nothing posted`);
    assert.match(result.stderr, message, name);
  }
  assert.equal(run({ reports: [good], traceFails: true }).comments.length, 0, "a trace that failed posts no comment");
});

// --- the passes ------------------------------------------------------------------------------------------------------------------------

test("#3627: it loops until nothing is unread -- two passes when the first leaves rows, and the header says so", () => {
  const result = run({ reports: [report({ reported: WEEK_PARTIAL, unread: 300 }), report({ reported: WEEK_COMPLETE, unread: 0 })] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.trace.length, 2, "the second pass is the one that finished");
  assert.match(result.comments[0].split("\n")[0], /^\*\*COMPLETE\*\*.*2 pass\(es\), GitHub events unread for 0 rows;/, "the post is of the LAST pass's report");
  assert.equal(result.comments.length, 1, "one post, not one per pass");
});

test("#3627: it stops, and says why, when a pass reads no more than the one before, at the pass limit, and when the pool is down -- and still posts PARTIAL", () => {
  const stuck = report({ reported: WEEK_PARTIAL, unread: 300 });
  const noProgress = run({ reports: [stuck, stuck, stuck] });
  assert.equal(noProgress.trace.length, 2, "the second pass read nothing more, so there is no third");
  assert.match(noProgress.comments[0].split("\n")[0], /^\*\*PARTIAL .*stopped because a pass read no more rows;/);

  const falling = [500, 400, 300, 200].map((unread) => report({ reported: WEEK_PARTIAL, unread }));
  const limited = run({ reports: falling, env: { TRACE_WEEKLY_MAX_PASSES: "3" } });
  assert.equal(limited.trace.length, 3);
  assert.match(limited.comments[0].split("\n")[0], /stopped because reached 3 passes;/);

  const poolDown = run({ reports: falling, remaining: ["4000", "1050"] });
  assert.equal(poolDown.trace.length, 1, "the pool fell to the reserve after one pass, so no second");
  assert.match(poolDown.comments[0].split("\n")[0], /stopped because the core pool is down to 1050;/);
  assert.equal(poolDown.status, 0, "a pool that is down AFTER a pass still posts the report it has, as PARTIAL");
});

test("#3627: a pass's budget is the pool's remainder above the reserve, capped at a pass", () => {
  const unread = report({ reported: WEEK_PARTIAL, unread: 300 });
  const result = run({ reports: [unread, report({ reported: WEEK_PARTIAL, unread: 100 }), report({ reported: WEEK_COMPLETE, unread: 0 })], remaining: ["4000", "1400", "5000"] });
  assert.deepEqual(result.trace.map((line) => /--calls (\d+)$/.exec(line)?.[1]), ["1500", "400", "1500"]);
});

// --- the clock and the service -----------------------------------------------------------------------------------------------------------

test("#3627: the timer fires Mondays at 07:30 London, catches up when asleep, and does NOT start its service at install", () => {
  const timer = CLOCK("trace-weekly.timer.in");
  assert.match(timer, /^OnCalendar=Mon \*-\*-\* 07:30:00 Europe\/London$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.doesNotMatch(timer, /^Requires=/m, "a Requires= would post a report at every `host:install`");
});

test("#3627: the service is a oneshot that runs the script as the org's account, and nothing but the timer starts it", () => {
  const service = CLOCK("trace-weekly.service.in");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/trace-weekly-post\.sh$/m);
  assert.match(service, /^Environment=GH_CONFIG_DIR=@@workersDir@@\/gh$/m, "the workers account, never the person's");
  assert.match(service, /^TimeoutStartSec=\d+$/m, "a hung run fails rather than holding next Monday's slot");
  assert.doesNotMatch(service, /^\[Install\]/m, "an [Install] would run it at every boot");
});
