// no-token: gh -- the sweep runs as a subprocess with a fake `gh` first on PATH, which answers from a file; nothing reaches the real `gh` or the network
// a11ign/agent-org#1175 (class `main-red`; a11ign/a11ign run 38246775013): close-rows-sweep read the merged-PR list ONCE, so a GitHub 502 on that read exited
// `CANNOT ASK` (2) and `trunk`'s `closeRows` job went red, and `readTrunkRed` counted a red `main` where `main` was fine. The read is retried on a transient 5xx,
// behind `sweep.retryTransient`, shipped OFF. This file pins the three done-when clauses: the retry (1), the attempt cap and the 4xx (2), and the switch OFF (3).
//
// NO NETWORK: `gh` is a fake on PATH whose answer for each merged-list read is a sequence this file writes, and every call is recorded in a file. The unit tests drive
// `readWithRetry` with a counting read and a no-op pause, so the suite does not wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { MERGED_READ_ATTEMPTS, readWithRetry, retryTransientOn } from "./close-rows-sweep.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

// ---- done-when 2 and the 4xx clause, unit: the retry itself ------------------------------------------------------------------------------------

/** A read that answers `answers` in order (an Error throws, anything else returns); the last answer repeats. Counts its calls. */
function sequenced(answers: (unknown | Error)[]) {
  let calls = 0;
  const read = () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, calls: () => calls };
}

test("done-when 1, unit: a 502 on the first read and a list on the second returns the list, after one wait", () => {
  const { read, calls } = sequenced([new Error("Command failed: gh api graphql\ngh: HTTP 502"), ["PR 5214"]]);
  const pauses: number[] = [];
  assert.deepEqual(readWithRetry(read, (ms) => pauses.push(ms)), ["PR 5214"]);
  assert.equal(calls(), 2, "read again once");
  assert.deepEqual(pauses, [1000], "one wait, before the second attempt");
});

test("done-when 2, unit: a read that answers 502 on every attempt is tried MERGED_READ_ATTEMPTS times and no more, and the throw names the attempts", () => {
  assert.equal(MERGED_READ_ATTEMPTS, 3, "the cap the row names");
  const { read, calls } = sequenced([new Error("gh: HTTP 502")]);
  const pauses: number[] = [];
  assert.throws(() => readWithRetry(read, (ms) => pauses.push(ms)), (error: Error) => {
    assert.match(error.message, /^all 3 attempts failed, the last with: gh: HTTP 502$/);
    return true;
  });
  assert.equal(calls(), 3, "three attempts in all");
  assert.deepEqual(pauses, [1000, 2000], "a wait before the second and the third attempt, none after the last");
});

test("the 4xx clause, unit: a 404 is thrown on its first attempt, unchanged, and is not asked again", () => {
  const refusal = new Error("Command failed: gh api graphql\ngh: HTTP 404 (Not Found)");
  const { read, calls } = sequenced([refusal, ["never reached"]]);
  const pauses: number[] = [];
  assert.throws(() => readWithRetry(read, (ms) => pauses.push(ms)), (error: unknown) => error === refusal);
  assert.equal(calls(), 1, "one attempt");
  assert.deepEqual(pauses, [], "no wait");
});

test("a failure that carries no HTTP status is not a transient 5xx and is not retried", () => {
  const { read, calls } = sequenced([new Error("getaddrinfo ENOTFOUND api.github.com")]);
  assert.throws(() => readWithRetry(read, () => {}), /ENOTFOUND/);
  assert.equal(calls(), 1);
});

// ---- done-when 3: the switch, shipped OFF ---------------------------------------------------------------------------------------------------

test("done-when 3, the switch: `sweep.retryTransient` is OFF unless the CI environment says `1`", () => {
  assert.equal(retryTransientOn({}), false, "unset is OFF");
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "0" }), false);
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "true" }), false, "only `1` is on");
  assert.equal(retryTransientOn({ SWEEP_RETRY_TRANSIENT: "1" }), true);
});

// ---- done-when 1-3 end to end: the sweep's own exit code, with a fake `gh` ------------------------------------------------------------------

/**
 * Runs the sweep with a `gh` whose merged-list reads answer `seq` in order (`ok` is an empty list; anything else is `gh: HTTP <it>`), and `SWEEP_RETRY_TRANSIENT`
 * set to `on` (or unset when `on` is false). Returns the exit, what it printed, and how many merged-list reads the fake was asked.
 */
function runSweep({ seq, on }: { seq: string[]; on: boolean; }) {
  const dir = tmpDir("close-rows-sweep-retry-");
  const calls = join(dir, "calls.log");
  const binDir = join(dir, "bin");
  const fakeGh = join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(fakeGh, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const query = args.find((a) => a.startsWith("query=")) ?? "";
if (query.includes("pullRequests(")) {
  const answered = existsSync(${JSON.stringify(calls)}) ? readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n").filter((l) => l === "list").length : 0;
  appendFileSync(${JSON.stringify(calls)}, "list\\n");
  const answer = ${JSON.stringify(seq)}[Math.min(answered, ${seq.length - 1})];
  if (answer === "ok") {
    console.log(JSON.stringify({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    process.exit(0);
  }
  console.error(\`gh: HTTP \${answer}\`);
  process.exit(1);
}
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const env: Record<string, string | undefined> = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GITHUB_REPOSITORY: "a11ign/agent-org" };
  if (on) env.SWEEP_RETRY_TRANSIENT = "1";
  else delete env.SWEEP_RETRY_TRANSIENT;
  const run = spawnSync(process.execPath, [join(SRC, "close-rows-sweep.ts")], { cwd: dir, encoding: "utf8", env: env as NodeJS.ProcessEnv });
  const listed = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l === "list").length : 0;
  return { run, listed };
}

test("done-when 1, end to end: a 502 then a list runs the sweep to DONE (exit 0) with the switch ON, and says it retried", () => {
  const { run, listed } = runSweep({ seq: ["502", "ok"], on: true });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(listed, 2, "read twice");
  assert.match(run.stdout, /SWEEP: the merged-PR read answered a transient 5xx on attempt 1 of 3 -- reading again\./);
  assert.match(run.stdout, /SWEEP: no PRs merged into main in the last 45m\./);
});

test("done-when 1, the control: the same 502 then list with the switch OFF is today's single read and exits CANNOT ASK (2)", () => {
  const { run, listed } = runSweep({ seq: ["502", "ok"], on: false });
  assert.equal(run.status, 2, run.stderr + run.stdout);
  assert.equal(listed, 1, "one read, as before");
});

test("done-when 1, the control's CANNOT ASK names the failed read and says nothing about a retry", () => {
  const { run } = runSweep({ seq: ["502", "ok"], on: false });
  assert.match(run.stderr, /^CANNOT ASK: listing merged PRs failed -- Command failed: gh api graphql /m);
  assert.doesNotMatch(run.stderr + run.stdout, /attempts|reading again/, "the OFF path says nothing about a retry");
});

test("done-when 2, end to end: every read answers 502 and the sweep exits CANNOT ASK after exactly 3 attempts, naming them", () => {
  const { run, listed } = runSweep({ seq: ["502"], on: true });
  assert.equal(run.status, 2, run.stderr + run.stdout);
  assert.equal(listed, 3, "three attempts and no fourth");
  assert.match(run.stderr, /^CANNOT ASK: listing merged PRs failed -- all 3 attempts failed, the last with: Command failed: gh api graphql /m);
});

test("the 4xx clause, end to end: a 404 exits CANNOT ASK after one read, switch ON, and is not retried", () => {
  const { run, listed } = runSweep({ seq: ["404"], on: true });
  assert.equal(run.status, 2, run.stderr + run.stdout);
  assert.equal(listed, 1, "one read");
});

test("the 4xx clause, end to end: a 404 is reported without any attempt count", () => {
  const { run } = runSweep({ seq: ["404"], on: true });
  assert.doesNotMatch(run.stderr, /attempts/);
});
