// no-token: gh -- `gh` and `agent-org` are fake executables on a PATH this file builds; the real script runs under bash against them and nothing reaches GitHub or the host
/**
 * agent-org#912: the daily manager-spend reading (`plugins/github/host/manager-spend-post.sh`, `host/manager-spend-post.{service,timer}.in`).
 *
 * The script is run for real, under bash, with a fake `gh` that records every comment it is asked to post and a fake `agent-org` that prints a
 * fixture reading and records the arguments it was given. The store is a fixture file under the fake HOME, one JSON event per line with `at` in
 * milliseconds, which is the shape the trace store keeps. The day is yesterday in UTC, as the script computes it (TZ is pinned to UTC for both).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./lib/tmp-fixture.ts";

const SHIPPED_DIR = fileURLToPath(new URL("../host/", import.meta.url));
// The script runs `gh`, so it is the GitHub plugin's (A11-160, step 9); the clock and the service stay in `host/`.
const PLUGIN_HOST_DIR = fileURLToPath(new URL("../plugins/github/host/", import.meta.url));
const SCRIPT = join(PLUGIN_HOST_DIR, "manager-spend-post.sh");
const CLOCK = (name: string) => readFileSync(join(SHIPPED_DIR, name), "utf8");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

/** Yesterday in UTC, which is the day the script reports, and the instant that day ends. */
const YESTERDAY = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const DAY_END = Date.parse(`${YESTERDAY}T00:00:00Z`) + DAY_MS;

const event = (at: number) => JSON.stringify({ id: `e${at}`, at, kind: "manager-wake" });
/** A store fed through the day's end: one wake in the day, and one after it. A quiet day with events after it is a valid reading. */
const FED = `${[event(DAY_END - 2 * HOUR_MS), event(DAY_END + HOUR_MS)].join("\n")}\n`;
const READING = `### Manager spend, ${YESTERDAY} (UTC)\n\n**2 manager wakes** (fixture)\n`;
const DECLARED = { tracker: [{ repo: "acme/widgets" }], units: { traceWeeklyIssue: 4242 } };

type Setup = {
  declaration?: unknown; // null: no file at all
  store?: string | null; // null: no store file at all
  reading?: string;
  ghFails?: boolean;
  traceFails?: boolean;
};
type Run = {
  dir: string; status: number | null; stderr: string; stdout: string;
  comments: string[]; trace: string[]; gh: string[]; marker: boolean;
};

/** Builds the fake world for one case: the declaration, the store, the reading, and the two fake executables. */
function fixture({ declaration = DECLARED, store = FED, reading = READING, ghFails = false, traceFails = false }: Setup): string {
  const dir = tmpDir("manager-spend-post-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The script calls a bare `node`, and the PATH names only system directories: the node running this file is the one the script gets.
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(dir, "comments"));
  writeFileSync(join(dir, "reading"), reading);
  if (ghFails) writeFileSync(join(dir, "gh-fails"), "");
  if (traceFails) writeFileSync(join(dir, "trace-fails"), "");
  if (store !== null) {
    mkdirSync(join(dir, ".cache", "a11ign", "trace"), { recursive: true });
    writeFileSync(join(dir, ".cache", "a11ign", "trace", "events.ndjson"), store);
  }
  if (declaration !== null) writeFileSync(join(dir, "project.json"), JSON.stringify(declaration));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
[ -f "${dir}/gh-fails" ] && { echo "HTTP 502" >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && file="$2"; shift; done
n=$(ls "${dir}/comments" | wc -l)
cp "$file" "${dir}/comments/$(printf '%03d' "$n").md"
`);
  writeFileSync(join(bin, "agent-org"), `#!/bin/sh
echo "$@" >> "${dir}/trace.log"
[ -f "${dir}/trace-fails" ] && { echo "trace blew up" >&2; exit 1; }
cat "${dir}/reading"
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "agent-org"), 0o755);
  return dir;
}

/** Runs the real script in `dir`, as the timer would. Comments and trace calls accumulate across runs in one `dir`, as they do on a host. */
function execute(dir: string): Run {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8", cwd: dir,
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, TZ: "UTC", AGENT_ORG_PROJECT: join(dir, "project.json") },
  });
  const lines = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : []);
  const comments = readdirSync(join(dir, "comments")).sort().map((name) => readFileSync(join(dir, "comments", name), "utf8"));
  const marker = existsSync(join(dir, ".cache", "a11ign", "manager-spend-post", YESTERDAY));
  return { dir, status: result.status, stderr: result.stderr, stdout: result.stdout, comments, trace: lines("trace.log"), gh: lines("gh.log"), marker };
}

const run = (setup: Setup): Run => execute(fixture(setup));

// --- the post -------------------------------------------------------------------------------------------------------------------------

test("agent-org#912: POSITIVE CONTROL -- yesterday's reading is posted once, on the DECLARED repository and issue, and the day's marker is written after the post", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.comments.length, 1, "one post, for this declaration, this store and this reading");
  assert.equal(result.comments[0], READING, "the reading is posted as `trace` printed it, not reshaped");
  assert.match(result.comments[0].split("\n")[0], new RegExp(`^### Manager spend, ${YESTERDAY} \\(UTC\\)$`), "the comment names the day it reports");
  assert.ok(result.gh.some((line) => /^issue comment 4242 --repo acme\/widgets --body-file \S+$/.test(line)), `the comment goes to acme/widgets#4242: ${JSON.stringify(result.gh)}`);
  assert.deepEqual(result.trace, [`trace -- manager-spend --day ${YESTERDAY} --store ${join(result.dir, ".cache", "a11ign", "trace", "events.ndjson")}`], "the reading is of the day named, from the store the script checked");
  assert.ok(result.marker, "the marker is written only after the post succeeds");
});

// --- once a day ------------------------------------------------------------------------------------------------------------------------

test("agent-org#912: NEGATIVE CONTROL -- a second run the same day posts nothing, and does not read the store's reading again", () => {
  const first = run({});
  assert.equal(first.comments.length, 1, "POSITIVE CONTROL first: one post");
  const second = execute(first.dir);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.comments.length, 1, "still one comment: the second run posted nothing");
  assert.equal(second.trace.length, 1, "and did not run `trace` a second time");
  assert.match(second.stdout, new RegExp(`the reading of ${YESTERDAY} is already posted .*: posting nothing`));
});

test("agent-org#912: a refused post writes NO marker, so the next run retries and posts the reading once it is accepted", () => {
  const dir = fixture({ ghFails: true });
  const refused = execute(dir);
  assert.notEqual(refused.status, 0, "a refused post is a failed unit");
  assert.match(refused.stderr, new RegExp(`posting the reading of ${YESTERDAY} on acme/widgets#4242 failed; no marker is written`));
  assert.equal(refused.comments.length, 0);
  assert.equal(refused.marker, false, "no marker: the day is not counted as posted");

  rmSync(join(dir, "gh-fails"));
  const retried = execute(dir);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.comments.length, 1, "the retry posts the reading");
  assert.ok(retried.marker);
});

// --- a stale or empty store posts nothing ----------------------------------------------------------------------------------------------

test("agent-org#912: NEGATIVE CONTROL -- an EMPTY or ABSENT store posts nothing, exits non-zero, and says the store holds no events", () => {
  for (const [name, store] of [["an empty store", ""], ["no store at all", null]] as const) {
    const result = run({ store });
    assert.notEqual(result.status, 0, `${name}: the unit must FAIL`);
    assert.match(result.stderr, /is absent or holds no events: an empty store is no reading/, name);
    assert.deepEqual([result.comments.length, result.trace.length, result.marker], [0, 0, false], `${name}: nothing read, nothing posted, no marker`);
  }
});

test("agent-org#912: NEGATIVE CONTROL -- a STALE store (newest event before the reported day ends) posts nothing, exits non-zero, and says it is stale", () => {
  const stale = run({ store: `${event(DAY_END - 2 * DAY_MS)}\n${event(DAY_END - 1)}\n` });
  assert.notEqual(stale.status, 0, "a store fed only up to the day's last millisecond before its end is stale");
  assert.match(stale.stderr, /is stale: its newest event is at .*, before .* ends, so its reading would be short; nothing posted/);
  assert.deepEqual([stale.comments.length, stale.trace.length, stale.marker], [0, 0, false], "nothing read, nothing posted, no marker");

  const exactlyFed = run({ store: `${event(DAY_END)}\n` });
  assert.equal(exactlyFed.status, 0, `a newest event at the instant the day ends is fed through it: ${exactlyFed.stderr}`);
  assert.equal(exactlyFed.comments.length, 1);
});

// --- the declaration is read, never defaulted ------------------------------------------------------------------------------------------

test("agent-org#912: NEGATIVE CONTROL -- a project with NO traceWeeklyIssue (or no repository, or a malformed issue) posts nothing, and says so", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["no file at all", null, /ENOENT|does not declare|no such file/i],
    ["no units.traceWeeklyIssue", { tracker: [{ repo: "acme/widgets" }], units: {} }, /does not declare units\.traceWeeklyIssue \(the record issue, a positive integer\)/],
    ["no tracker repository", { units: { traceWeeklyIssue: 4242 } }, /does not declare tracker\[0\]\.repo/],
    ["an issue that is a string", { tracker: [{ repo: "acme/widgets" }], units: { traceWeeklyIssue: "4242" } }, /does not declare units\.traceWeeklyIssue/],
  ];
  for (const [name, declaration, message] of cases) {
    const result = run({ declaration });
    assert.notEqual(result.status, 0, `${name}: the unit must FAIL`);
    assert.match(result.stderr, message, name);
    assert.deepEqual([result.comments.length, result.trace.length], [0, 0], `${name}: nothing read or posted on a guess`);
  }
});

// --- a failed reading --------------------------------------------------------------------------------------------------------------------

test("agent-org#912: NEGATIVE CONTROL -- a reading that fails posts nothing, exits non-zero, and writes no marker", () => {
  const result = run({ traceFails: true });
  assert.notEqual(result.status, 0, "a reading that fails is a failed unit");
  assert.match(result.stderr, /agent-org trace -- manager-spend exited non-zero/);
  assert.deepEqual([result.comments.length, result.marker], [0, false]);
});

// --- the clock and the service -----------------------------------------------------------------------------------------------------------

test("agent-org#912: the timer fires daily at 07:45 London, catches up when asleep, and does NOT start its service at install", () => {
  const timer = CLOCK("manager-spend-post.timer.in");
  assert.match(timer, /^OnCalendar=\*-\*-\* 07:45:00 Europe\/London$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.doesNotMatch(timer, /^Requires=/m, "a Requires= would post a reading at every `host:install`");
});

test("agent-org#912: the service is a oneshot that runs the script as the org's account, and nothing but the timer starts it", () => {
  const service = CLOCK("manager-spend-post.service.in");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/bash packages\/agent-org\/plugins\/github\/host\/manager-spend-post\.sh$/m);
  assert.match(service, /^Environment=GH_CONFIG_DIR=@@workersDir@@\/gh$/m, "the workers account, never the person's");
  assert.match(service, /^TimeoutStartSec=\d+$/m, "a hung run fails rather than holding the next day's slot");
  assert.doesNotMatch(service, /^\[Install\]/m, "an [Install] would post a reading at every boot");
});
