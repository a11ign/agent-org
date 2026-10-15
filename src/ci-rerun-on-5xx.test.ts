// agent-org#1180: the 5xx rerun decider. Pure: no network, no run, no fleet, no CLI. Every log line is a fixture.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_RERUN_ON_5XX, lastErrorLine, rerunLedgerLine, rerunOn5xx, rerunRedOn5xx } from "./ci-rerun-on-5xx.ts";

const SERVER = "2026-10-12T12:00:01.0000000Z gh: Server Error (HTTP 502)";
const RUNNER_EXIT = "2026-10-12T12:00:02.0000000Z ##[error]Process completed with exit code 1.";
const TEST_FAIL = "2026-10-12T12:00:03.0000000Z AssertionError [ERR_ASSERTION]: expected 3, got 4";
// The shape of a poll loop that a 502 killed: the server error is the last error the step prints, and the runner then names the exit code.
const LOG_5XX = ["##[group]Run poll", "Polling run 38249729992", SERVER, RUNNER_EXIT].join("\n");
// The negative control: a 5xx earlier in the log, then a test that really fails last.
const LOG_5XX_THEN_TEST = [SERVER, "retrying", TEST_FAIL, RUNNER_EXIT].join("\n");

const DECIDE = { conclusion: "failure", rerunsOnThisHead: false } as const;

test("POSITIVE CONTROL: a failed job whose last error is a GitHub 5xx is rerun", () => {
  const decision = rerunOn5xx({ log: LOG_5XX, ...DECIDE });
  assert.equal(decision.action, "rerun");
  assert.match(decision.reason, /HTTP 502/);
});

test("NEGATIVE CONTROL: a 5xx earlier in the log and a test failure last is the owner's", () => {
  assert.equal(rerunOn5xx({ log: LOG_5XX_THEN_TEST, ...DECIDE }).action, "owner");
});

test("a second 5xx red on the same head is the owner's, not a second rerun", () => {
  assert.deepEqual(rerunOn5xx({ log: LOG_5XX, conclusion: "failure", rerunsOnThisHead: true }).action, "owner");
});

test("only a failed job is rerun: timed_out, success and no conclusion are the owner's", () => {
  for (const conclusion of ["timed_out", "success", null]) assert.equal(rerunOn5xx({ log: LOG_5XX, conclusion, rerunsOnThisHead: false }).action, "owner", String(conclusion));
});

test("a 4xx is the caller's own mistake and is the owner's; a bare `Server Error` is a 5xx", () => {
  assert.equal(rerunOn5xx({ log: `##[error]gh: Not Found (HTTP 404)\n${RUNNER_EXIT}`, ...DECIDE }).action, "owner");
  assert.equal(rerunOn5xx({ log: `gh: Server Error\n${RUNNER_EXIT}`, ...DECIDE }).action, "rerun");
});

test("the runner's exit-code summary and an echoed warning are not the last error, so the 5xx before them is", () => {
  assert.equal(lastErrorLine(LOG_5XX), "gh: Server Error (HTTP 502)");
  assert.equal(lastErrorLine(`${SERVER}\nwarning: something is slow\n${RUNNER_EXIT}`), "gh: Server Error (HTTP 502)");
});

test("a log that names no error is the owner's", () => {
  assert.equal(rerunOn5xx({ log: "##[group]Run\nall good\n", ...DECIDE }).action, "owner");
  assert.equal(lastErrorLine("all good\n"), null);
});

test("shipped ON: the flag is true, so a 5xx red is rerun by default; the explicit OFF is today's route", () => {
  assert.equal(CI_RERUN_ON_5XX.enabled, true);
  assert.equal(rerunRedOn5xx({ log: LOG_5XX, ...DECIDE }).action, "rerun", "no flag passed: the 5xx is rerun");
  assert.deepEqual(rerunRedOn5xx({ log: LOG_5XX, ...DECIDE }, { enabled: false }), { action: "owner", reason: "ci.rerunOn5xx is off" });
});

test("ON: a 5xx red is a rerun, and the ledger line names the repo, the run and the head", () => {
  const decision = rerunRedOn5xx({ log: LOG_5XX, ...DECIDE }, { enabled: true });
  assert.equal(decision.action, "rerun");
  assert.match(rerunLedgerLine("a11ign/a11ign", 38249729992, "abcdef12", decision), /^checks rerun on 5xx: a11ign\/a11ign run 38249729992 head abcdef12: the last error is a GitHub 5xx: /);
});

test("ON: a second red on the head is the owner's", () => {
  assert.equal(rerunRedOn5xx({ log: LOG_5XX, conclusion: "failure", rerunsOnThisHead: true }, { enabled: true }).action, "owner");
});

test("ON: a test failure last is the owner's, so the owner's red is never rerun", () => {
  assert.equal(rerunRedOn5xx({ log: LOG_5XX_THEN_TEST, ...DECIDE }, { enabled: true }).action, "owner");
});
