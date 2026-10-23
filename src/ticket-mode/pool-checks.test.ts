// no-token: gh -- pure functions over a job log's text, and a stub `run` that answers one read
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLinesOfLog } from "../ci-log-lines.ts";
import { infrastructureCause } from "./pool-checks.ts";

const stamped = (lines: string[]) => lines.map((line) => `2026-10-20T10:00:00.1234567Z ${line}`).join("\n");

test("A11-154: the lines of a job log that name its failure have no colour, no timestamp, no warning, no echoed command and no exit-code line", () => {
  const log = stamped(["##[group]Run npm test", "\u001b[33mnpm warn deprecated left-pad\u001b[0m", "\u001b[31mnot ok 3 - git spawn classification\u001b[0m", "  AssertionError: expected 1 to equal 2",
    "##[command]npm run failing", "##[error]Process completed with exit code 1.", "all fine"]);
  assert.deepEqual(errorLinesOfLog(log), ["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"]);
});

test("A11-154: only the last 200 lines that name the failure are kept, since a job's summary is at its end", () => {
  const lines = errorLinesOfLog(stamped(Array.from({ length: 500 }, (_, i) => `Error: failure number ${i}`)));
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [200, "Error: failure number 300", "Error: failure number 499"]);
});

test("A11-154: a log is the infrastructure's when a runner was lost, a rate limit was hit, GitHub answered 5xx or the network failed, and the code's otherwise", () => {
  const cases: [string, string[], string | null][] = [
    ["a lost runner", ["##[error]The hosted runner lost communication with the server.", "##[error]Process completed with exit code 143."], "a runner was lost or a rate limit was hit"],
    ["a rate limit", ["gh: API rate limit exceeded for user ID 1"], "a runner was lost or a rate limit was hit"],
    ["a GitHub 5xx", ["Run gh api repos/x/y", "gh: HTTP 502: Server Error"], "GitHub answered with a server error"],
    ["a network error at the end", ["npm error code ECONNRESET", "npm error network aborted", "npm error A complete log of this run can be found in: /home/runner/.npm/_logs/x.log"], "a network error"],
    ["a build whose log mentions a rate limit long before its failure", ["Error: rate limit mentioned by a retry helper", ...Array.from({ length: 6 }, (_, i) => `error TS2322: type error ${i}`)], null],
    ["a failed assertion", ["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"], null],
    ["a 4xx", ["gh: HTTP 404: Not Found"], null],
    ["an early network line the code's failure follows", ["warning: ECONNREFUSED on a retry, then it connected", ...Array.from({ length: 6 }, (_, i) => `Error: test ${i} failed`)], null],
    ["a passing test that prints a rate limit beside a real failure", ["not ok 4 - a real failure", "ok 5 - prints 'rate limit' when throttled"], null],
    ["no error at all", ["done"], null],
  ];
  for (const [why, lines, cause] of cases) assert.equal(infrastructureCause(stamped(lines)), cause, why);
});
