// no-token: none -- the wake prompt's words, and its sending over an injected herdr
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendWake, wakePrompt } from "./wait-prompt.ts";
import { judgeWaits } from "./wait-verdict.ts";
import type { Reading } from "./wait-types.ts";

const JOB = { kind: "fleetJob", id: "fj-1" } as const;
const done: Reading = { wait: JOB, status: "finished", job: { state: "done", reason: null, results: "/srv/fleet/jobs/fj-1", progress: null, estimatedFinish: null } };
const bad: Reading = { wait: JOB, status: "failed", job: { state: "failed", reason: "box offline", results: null, progress: null, estimatedFinish: null } };
const slow: Reading = { wait: JOB, status: "pending", job: { state: "running", reason: null, results: null, progress: { done: 4, total: 6 }, estimatedFinish: null } };
const DEADLINE = Date.UTC(2026, 9, 25, 12, 0);

test("A11-245: a finished wake says what happened, where the results are, and to act on it without declaring the same wait again", () => {
  const text = wakePrompt({ at: 1, why: "finished" }, judgeWaits([done]), DEADLINE);
  assert.equal(text, "What you waited on has finished: fleet job fj-1 is done; its results are at /srv/fleet/jobs/fj-1 (fleet job fetch fj-1 --to <dir> copies them). Act on it: write the outcome the run ended on, or a new working outcome for anything you still wait on, and do not declare the same wait again.");
  assert.equal(text.includes("\n"), false, "one line: a new line typed into a pane would submit it early");
});

test("A11-245: a failed wake starts with the reason", () => {
  assert.match(wakePrompt({ at: 1, why: "failed" }, judgeWaits([bad]), DEADLINE), /^Your wait failed: fleet job fj-1 failed: box offline\. All of it: fleet job fj-1 failed: box offline\. Act on it/);
});

test("A11-245: a late wake names the deadline and each pending item's progress; an undeclared one names only the bound", () => {
  assert.equal(wakePrompt({ at: 1, why: "late" }, judgeWaits([slow]), DEADLINE),
    "Your wait passed its deadline (2026-10-25T12:00:00.000Z) with these still pending: fleet job fj-1 is running, 4 of 6 pages. Check them, then carry on, or write a new working outcome with a new until if they are still worth waiting for.");
  assert.equal(wakePrompt({ at: 1, why: "late" }, null, DEADLINE), "your wait has passed its bound (2026-10-25T12:00:00.000Z); check it and carry on");
});

test("A11-245: sending is herdr's `agent prompt` in the board's session to the run's agent: null when taken, herdr's reason when refused", () => {
  const calls: string[][] = [];
  assert.equal(sendWake((args) => { calls.push(args); return "{}"; }, "tickets", "t-nbf-1", "hello"), null);
  assert.deepEqual(calls, [["--session", "tickets", "agent", "prompt", "t-nbf-1", "hello"]]);
  const refused = sendWake(() => { throw Object.assign(new Error("herdr exited 1"), { stderr: "error: no such agent\n" }); }, "tickets", "t-nbf-1", "hello");
  assert.match(refused ?? "", /no such agent/);
});
