// no-token: gh -- every `herdr` and `git` call here is an injected seam; the one real process is `node`, run to produce a genuine `execFileSync` failure
/**
 * `packages/agent-org/src/wake.ts`, #3032: A `herdr agent start` THAT HERDR REFUSES IS REFUSED WITH HERDR'S REASON.
 *
 * Measured 2026-10-02: `reviewer-agent-org-18` was retried for an hour and the journal printed, 28 times, the
 * `herdr ... agent start` command line and "the workspace it opened was closed". That text is `firstLine(err)`, and
 * the first line of an `execFileSync` error is Node's own `Command failed: <argv>` echo: herdr's stderr, the part
 * that says WHY, is on `err.stderr` and never reached the journal.
 *
 * THE FAILURE IS A REAL `execFileSync` ONE, not a hand-built `Error`: a plain `new Error("herdr: refused")` has no
 * `stderr` and no argv echo, which is exactly the shape that hid this -- the old tests passed on it. The positive
 * control below pins that the fixture HAS the argv echo first, so the assertions that the refusal does not carry it
 * could not pass on a fixture that never had one.
 */
import { TSX_IMPORT } from "./tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deliver } from "./wake.ts";

const REASON = "unknown model \"gpt-5.6-luna\" for kind codex";
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROSTER: string[] = [];

/** The error `execFileSync` throws when a child exits non-zero having written `stderr`, as `defaultRun` would. */
function failedCommand(stderr: string, argv: string[] = ["--session", "org", "agent", "start"]) {
  try {
    // The reason travels in the ENVIRONMENT, so it is not in the argv Node echoes -- as herdr's is not.
    execFileSync(process.execPath, [...TSX_IMPORT, "-e", "process.stderr.write(process.env.REASON); process.exit(3)", "--", ...argv],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, REASON: stderr } });
  } catch (err) {
    return err as Error & { stderr: string };
  }
  throw new Error("the child was meant to fail");
}

/** A herdr that opens a workspace and then refuses `agent start` with `failure`, recording every call. */
function herdrRefusingStart(failure: unknown) {
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    if (args.includes("agent") && args.includes("start")) throw failure;
    return "{}";
  };
  return { run, calls };
}

const reviewerOrder = {
  session: "reviewer-18", cause: "draft-awaiting-verdict", causeKey: "reviewer-18/draft-awaiting-verdict/pr-18/abc12345",
  prompt: "Draft #18 is green with no verdict at its head.",
};
const engineerOrder = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed.",
};

/** The reviewer path needs a verified checkout; nothing here touches a disk. */
const checkoutSeams = {
  git: (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    if (line.includes("rev-parse --verify")) return `${"d".repeat(40)}\n`;
    if (line.endsWith("rev-parse HEAD")) return `${"d".repeat(40)}\n`;
    return "";
  },
  link: () => null,
  exists: () => true,
  root: "/reviews-root",
  repoRoot: "/primary",
};

test("#3032 POSITIVE CONTROL: the fixture's error opens with the argv echo and keeps the reason on `stderr`", () => {
  const err = failedCommand(REASON);
  assert.match(err.message.split("\n")[0], /^Command failed: /, "the line the old refusal quoted");
  assert.ok(err.message.split("\n")[0].includes("agent start"), "and it is the argv, not the reason");
  assert.ok(!err.message.split("\n")[0].includes(REASON));
  assert.equal(err.stderr, REASON, "herdr's own words are on `stderr`");
});

test("#3032 REVIEWER: a refused `agent start` is refused WITH herdr's reason, and without the argv", () => {
  const herdr = herdrRefusingStart(failedCommand(`${REASON}\nusage: herdr agent start ...`));
  const got = deliver([reviewerOrder], agents({ ceo: "working" }), ROSTER, { run: herdr.run, checkout: checkoutSeams });

  assert.deepEqual(got.sent, []);
  const refusal = got.refused.join("\n");
  assert.ok(refusal.includes(`herdr refused to start "reviewer-18" (${REASON})`), refusal);
  assert.ok(!refusal.includes("Command failed"), refusal);
  assert.ok(!refusal.includes("--kind codex"), "no argv in the journal line");
  assert.ok(!refusal.includes("usage: herdr"), "the FIRST non-empty stderr line, not the whole of it");
  assert.match(refusal, /workspace it opened \(wB\) was closed/, "the teardown note is still there");
});

test("#3032 ENGINEER: the other `agent start` site says the same, because a fix at one of two is this repo's shape", () => {
  const herdr = herdrRefusingStart(failedCommand(`\n  ${REASON}\n`));
  const got = deliver([engineerOrder], agents({ ceo: "working" }), ROSTER, { run: herdr.run });

  const refusal = got.refused.join("\n");
  assert.ok(refusal.includes(`herdr refused to start "worker-2131" (${REASON})`), refusal);
  assert.ok(!refusal.includes("Command failed"), refusal);
});

test("#3032 FALLBACK: an error with no stderr still quotes its first message line, bounded", () => {
  const timeout = Object.assign(new Error("spawnSync herdr ETIMEDOUT\nstack frame nobody needs"), { stderr: "" });
  const herdr = herdrRefusingStart(timeout);
  const refusal = deliver([reviewerOrder], agents({ ceo: "working" }), ROSTER,
    { run: herdr.run, checkout: checkoutSeams }).refused.join("\n");

  assert.ok(refusal.includes('herdr refused to start "reviewer-18" (spawnSync herdr ETIMEDOUT)'), refusal);
  assert.ok(!refusal.includes("stack frame nobody needs"));

  const long = herdrRefusingStart(failedCommand("x".repeat(500)));
  const bounded = deliver([reviewerOrder], agents({ ceo: "working" }), ROSTER,
    { run: long.run, checkout: checkoutSeams }).refused.join("\n");
  assert.ok(!bounded.includes("x".repeat(121)), "a reason is an excerpt, not a dump");
});
