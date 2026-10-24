// no-token: gh -- the closer runs as a subprocess with a stub `gh` first on PATH, which answers from its arguments; nothing reaches GitHub
/**
 * #2995, DONE-WHEN 3, AS A REAL PROCESS: THE ROW CLOSER SETTLES A ROW OF THE TRACKER THAT A PULL REQUEST OF ANOTHER REPOSITORY NAMED IN THE FULL FORM (`Closes owner/repo#N`).
 *
 * Moved from `src/close-rows-full-form.test.ts` (A11-160, step 9). The closer's decisions are core's; what a process shows is that the real program reaches `gh` THROUGH THE GITHUB PLUGIN: it reads the pull
 * request's closing references with the one GraphQL lookup the plugin builds, closes the row in the TRACKER (not the pull request's repository), strips its claim labels there, and aims nothing at the other
 * repository's own row. It is the plugin's end-to-end test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../../../src/lib/git-env.ts";
import { tmpDir } from "../../../src/lib/tmp-fixture.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
const PROJECT = process.env.A11IGN_CHECKOUT ?? "/home/agent/repos/a11y-witness";
// The project is found through the host file, never by counting directories up from `src`. Default it only when the file is there: a CI runner has no primary checkout.
const PROJECT_HOST = join(PROJECT, ".agent-org/host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(PROJECT_HOST)) {
  process.env.AGENT_ORG_HOST = PROJECT_HOST;
}

const TRACKER = "a11ign/a11ign";
const LAYER = "a11ign/agent-org";

/** A `gh` that answers the closer's one pull-request read and records every other call. */
function runCloser({ rowState }: { rowState: any }) {
  const dir = tmpDir("close-rows-full-form-");
  const calls = join(dir, "calls.log");
  const pr = { merged: true, baseRefName: "main", mergedAt: "2026-10-02T14:00:00Z", headRefName: "agent/x-2995", body: "Closes a11ign/a11ign#2995",
    mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [
      { number: 2995, state: rowState, repository: { nameWithOwner: TRACKER }, labels: { nodes: [{ name: "in-progress" }, { name: "session:worker-2995" }] }, timelineItems: { nodes: [] } },
      { number: 4, state: "OPEN", repository: { nameWithOwner: LAYER }, labels: { nodes: [{ name: "in-progress" }] }, timelineItems: { nodes: [] } }] } };
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/gh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const query = args.find((a) => a.startsWith("query=")) ?? "";
if (query.includes("pullRequest(number:")) { console.log(${JSON.stringify(JSON.stringify(pr))}); process.exit(0); }
if (query.includes("rateLimit")) { console.log("HTTP/2 200\\nx-ratelimit-used: 1\\n\\n{}"); process.exit(0); }
if (args[0] === "issue") process.exit(0);
console.error("NOT_FOUND (a11ign.projectV2): Could not resolve to a ProjectV2 with the number 1"); process.exit(1);
`);
  chmodSync(join(dir, "bin/gh"), 0o755);
  spawnSync("git", ["init", "-q", dir], { env: sandboxGitEnv() });
  const run = spawnSync(process.execPath, [join(SRC, "close-rows-for-merged-pr.ts"), "17"], { cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_REPOSITORY: LAYER } });
  const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { run, issueCalls: log.filter((args) => args[0] === "issue") };
}

test("done-when 3, POSITIVE CONTROL: a row still open is closed by the closer, in the TRACKER, naming the other repository's pull request", () => {
  const { run, issueCalls } = runCloser({ rowState: "OPEN" });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const close = issueCalls.find((args) => args[1] === "close");
  assert.deepEqual([close?.[2], close?.[close.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.match(close?.[close.indexOf("--comment") + 1] ?? "", /PR a11ign\/agent-org#17 merged as `abc1234` and declared `Closes a11ign\/a11ign#2995`/);
  const strip = issueCalls.find((args) => args[1] === "edit");
  assert.deepEqual([strip?.[2], strip?.[strip.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.ok(issueCalls.every((args) => args[args.indexOf("--repo") + 1] === TRACKER && args[2] !== "4"), "nothing was aimed at the layer's own #4, which this merge never named");
});

test("done-when 3: a row GitHub already closed natively is not closed again -- only its labels and Status are settled", () => {
  const { run, issueCalls } = runCloser({ rowState: "CLOSED" });
  assert.match(run.stdout, /#2995 ALREADY CLOSED -- left alone/);
  assert.equal(issueCalls.some((args) => args[1] === "close"), false);
  const strip = issueCalls.find((args) => args[1] === "edit");
  assert.deepEqual([strip?.[2], strip?.[strip.indexOf("--repo") + 1]], ["2995", TRACKER]);
  assert.deepEqual(strip?.filter((a: any, i: any) => strip[i - 1] === "--remove-label").sort(), ["in-progress", "session:worker-2995"]);
  assert.match(run.stdout + run.stderr, /DEGRADED|Status/, "and the Status move was ASKED for (the shim's board is unreadable, which the closer reports rather than hides)");
});
