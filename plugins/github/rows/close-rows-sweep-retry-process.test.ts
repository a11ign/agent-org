// no-token: gh -- the sweep runs as a subprocess with a fake `gh` first on PATH, which answers from a file; nothing reaches the real `gh` or the network
/**
 * a11ign/agent-org#1175 (class `main-red`; a11ign/a11ign run 38246775013), AS A REAL PROCESS: the sweep's own exit code when the merged-PR read answers a transient 5xx, with the switch `sweep.retryTransient` ON or OFF.
 *
 * Moved from `src/close-rows-sweep-retry.test.ts` (A11-160, step 9). The retry itself (`readWithRetry`, the attempt cap, the 4xx clause, the switch) is core's and its unit tests stay there; what a process shows is
 * that the real program reaches `gh` THROUGH THE GITHUB PLUGIN, that the plugin's refusal carries the `HTTP 502` the retry reads, and that the exit code and the attempt count come out as the row names. `gh` is a fake
 * on PATH whose answer for each merged-list read is a sequence this file writes, and every call is recorded in a file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../../../src/lib/tmp-fixture.ts";

const SWEEP = fileURLToPath(new URL("../../../src/close-rows-sweep.ts", import.meta.url));

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
  const run = spawnSync(process.execPath, [SWEEP], { cwd: dir, encoding: "utf8", env: env as NodeJS.ProcessEnv });
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
