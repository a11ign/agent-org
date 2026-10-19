// no-token: gh -- every `gh` here is an injected seam (`gh`, `read`, `classify`); nothing imported reaches the real one
/**
 * agent-org#1217 (follow-up to #1180): THE TICK RERUNS A REQUIRED CHECK RED ON A GITHUB 5xx, once, through the ticket port, and writes one `checks rerun on 5xx` ledger line.
 *
 * `ci-rerun-on-5xx.test.ts` holds the decider. This file reaches it from its real caller (`withCiFailureClass`) and holds the two port functions it uses (`redRunOfHead`,
 * `rerunFailedJobsOf`). The flag ships OFF, so each ON case has its OFF twin: OFF is today's tick, the same `gh` reads and the same order, with no write.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CiFailure } from "./ci-failure-class.ts";

// A RECORDED PROJECT AND A HOST THAT DECLARES NO PROVIDER, set BEFORE `wake.ts` is imported (`wake-ci-class-review-depth.test.ts`'s prelude): it resolves the declaration at import.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-ci-rerun-5xx-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
mkdirSync(join(PROJECT, "node_modules", "left-pad"), { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { withCiFailureClass } = await import("./wake/ci-class-and-spares.ts");
const { readCiFailure } = await import("./ci-failure-class.ts");
const { CI_RERUN_LEDGER_FILE } = await import("./ci-rerun-on-5xx.ts");
const { redRunOfHead, rerunFailedJobsOf } = await import("./ticket-port/ci-reads.ts");

const REPO = "a11ign/a11ign";
const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ORDER = { session: "worker-4", cause: "pr-checks-failing", causeKey: "worker-4/pr-checks-failing/pr-77/abcdef12", prompt: "PR 77 has FAILING checks." };
const LOG_5XX = "ok 1 - setup\n##[error]gh: Server Error (HTTP 502)\n";
const LOG_5XX_THEN_TEST = "gh: Server Error (HTTP 502)\nnot ok 2 - the real test\n  AssertionError: expected 1 to equal 2\n";
const RERUN_CALL = `run rerun 555 --failed -R ${REPO}`;

type Check = { name: string; conclusion: string; details_url: string };
const check = (name: string, run: number, job: number, conclusion = "failure"): Check => ({ name, conclusion, details_url: `https://github.com/${REPO}/actions/runs/${run}/job/${job}` });

/** A fake `gh`: answers by the first key its arguments contain, records every call, and throws what `refuse` says for a call it contains. */
function host({ log = LOG_5XX, attempt = 1, checks = [check("ts", 555, 666)], refuse }: { log?: string; attempt?: number; checks?: Check[]; refuse?: string } = {}) {
  const asked: string[] = [];
  const answers: Record<string, unknown> = {
    [`repos/${REPO}/pulls/77`]: { head: { sha: SHA, ref: "agent/x-77" } },
    [`commits/${SHA}/check-runs`]: { check_runs: checks },
    "actions/runs/555": { name: "CI", run_attempt: attempt },
    "actions/jobs/666/logs": log,
    "actions/runs?": { workflow_runs: [] },
    "run rerun": "",
  };
  const gh = (args: string[]) => {
    const line = args.join(" ");
    asked.push(line);
    if (refuse !== undefined && line.includes(refuse)) throw new Error("HTTP 403: Resource not accessible by integration");
    const key = Object.keys(answers).find((k) => line.includes(k));
    if (key === undefined) throw new Error(`unexpected gh ${line}`);
    const answer = answers[key];
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
  return { gh, asked };
}

const ledgerIn = (dir: string) => join(dir, "ledger");
const freshDir = (name: string) => {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const rerunFileIn = (dir: string) => join(dir, CI_RERUN_LEDGER_FILE);
/** A classifier that must not be reached (a rerun asks no provider) or, with `reached`, one that says so and answers the rule's own class. */
const classifier = (reached: string[] = []) => (failure: CiFailure) => {
  reached.push("classify");
  return Promise.resolve({ klass: "own-defect", route: "owner", via: "none", fellBack: false } as never);
};
const tick = (world: ReturnType<typeof host>, dir: string, enabled: boolean, reached: string[] = []) =>
  withCiFailureClass([ORDER], { host: {}, ledgerPath: ledgerIn(dir), gh: world.gh, now: NOW, classify: classifier(reached) as never, rerunFlags: { enabled } });

test("ON: a red whose last error is a GitHub 5xx is rerun once through the port, recorded on one ledger line, and the order says change nothing", async () => {
  const dir = freshDir("on");
  const world = host();
  const reached: string[] = [];
  const [order] = await tick(world, dir, true, reached);
  assert.equal(world.asked.filter((line) => line === RERUN_CALL).length, 1, `one rerun, as the port writes it: ${world.asked.join(" | ")}`);
  const lines = readFileSync(rerunFileIn(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "one ledger line per rerun");
  assert.match(lines[0], new RegExp(`^${NOW}\\tchecks rerun on 5xx: ${REPO} run 555 head abcdef12: the last error is a GitHub 5xx: .*HTTP 502`));
  assert.ok(order.prompt.startsWith(ORDER.prompt) && /rerun this check's failed jobs once/.test(order.prompt) && /Change nothing/.test(order.prompt));
  assert.deepEqual(reached, [], "a rerun needs no classification: the provider is not asked");
});

test("OFF (shipped): the tick is today's route byte for byte -- the same reads, no rerun, no ledger line, the gate's order", async () => {
  const dir = freshDir("off");
  const world = host();
  const [order] = await tick(world, dir, false);
  const today = host();
  readCiFailure({ repo: REPO, number: 77, head8: "abcdef12" }, today.gh, NOW);
  assert.deepEqual(world.asked, today.asked, "the calls are exactly `readCiFailure`'s and nothing else");
  assert.ok(!world.asked.some((line) => line.startsWith("run rerun")));
  assert.equal(order.prompt, ORDER.prompt);
  assert.equal(existsSync(rerunFileIn(dir)), false);
});

test("the shipped flag is what the tick reads when none is injected: ON, so a 5xx red is rerun once (agent-org#1180, a11ign#5230)", async () => {
  const dir = freshDir("shipped");
  const world = host();
  const [order] = await withCiFailureClass([ORDER], { host: {}, ledgerPath: ledgerIn(dir), gh: world.gh, now: NOW, classify: classifier() as never });
  assert.equal(world.asked.filter((line) => line === RERUN_CALL).length, 1, `one rerun, with no flag passed: ${world.asked.join(" | ")}`);
  assert.match(order.prompt, /rerun this check's failed jobs once/);
});

test("ON, negative controls: a 5xx earlier in the log and a test failure after it, a head already rerun, and a timed-out job are each the owner's, with no write", async () => {
  for (const [name, world] of [
    ["5xx-then-test", host({ log: LOG_5XX_THEN_TEST })],
    ["already-rerun", host({ attempt: 2 })],
    ["timed-out", host({ checks: [check("ts", 555, 666, "timed_out")] })],
  ] as const) {
    const dir = freshDir(`neg-${name}`);
    const reached: string[] = [];
    const [order] = await tick(world, dir, true, reached);
    assert.equal(world.asked.some((line) => line.startsWith("run rerun")), false, name);
    assert.equal(existsSync(rerunFileIn(dir)), false, name);
    assert.equal(order.prompt, ORDER.prompt, name);
    assert.deepEqual(reached, ["classify"], `${name}: the route is today's`);
  }
});

test("ON: a rerun GitHub refuses is `owner` with the reason on the order, is still classified, and writes no ledger line", async () => {
  const dir = freshDir("refused");
  const world = host({ refuse: "run rerun" });
  const reached: string[] = [];
  const [order] = await tick(world, dir, true, reached);
  assert.match(order.prompt, /GitHub refused: HTTP 403: Resource not accessible by integration\. The failure is yours\./);
  assert.deepEqual(reached, ["classify"]);
  assert.equal(existsSync(rerunFileIn(dir)), false, "a rerun that did not happen is not counted");
});

test("ON: the run rerun is the run of the check `readCiFailure` classified, not the roll-up `gate`'s", async () => {
  const dir = freshDir("rollup");
  const world = host({ checks: [check("gate", 111, 222), check("ts", 555, 666)] });
  await tick(world, dir, true);
  assert.ok(world.asked.includes(RERUN_CALL));
  assert.ok(world.asked.some((line) => line.includes("actions/jobs/666/logs")) && !world.asked.some((line) => line.includes("111")), "the log read and the run rerun are the same check's");
  assert.deepEqual(redRunOfHead(REPO, 77, "abcdef12", world.gh), { runId: 555, conclusion: "failure" });
});

test("the port: `redRunOfHead` is `null` for a head that moved, no red, or a red that is no Actions job; `rerunFailedJobsOf` writes exactly the row's command and throws on a refusal", () => {
  assert.equal(redRunOfHead(REPO, 77, "99999999", host().gh), null);
  assert.equal(redRunOfHead(REPO, 77, "abcdef12", host({ checks: [check("ts", 555, 666, "success")] }).gh), null);
  assert.equal(redRunOfHead(REPO, 77, "abcdef12", host({ checks: [{ name: "vercel", conclusion: "failure", details_url: "https://vercel.com/x" }] }).gh), null);
  const world = host();
  rerunFailedJobsOf(REPO, 555, world.gh);
  assert.deepEqual(world.asked, [RERUN_CALL]);
  assert.throws(() => rerunFailedJobsOf(REPO, 555, host({ refuse: "run rerun" }).gh), /HTTP 403/);
});
