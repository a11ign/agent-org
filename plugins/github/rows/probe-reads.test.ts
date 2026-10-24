// no-token: none -- the probe is handed a stub runner that records the argument list; nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 9): THE TICK SNAPSHOT'S CONDITIONAL PROBE AND HOW GITHUB'S `-i` BLOCK IS READ (moved from `src/packaging/tick-snapshot.test.ts` and `src/event-drift.test.ts`). The tick DECIDES what a status and a tag mean (a 304 is
 * no change, a 404 is a repository with no Actions); here is what is SENT (`api -i`, the held tag as `If-None-Match`) and how the answer is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnsweringRun, RunnerRequest } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { factsOf, parseAnswer, probeOf } from "./probe-reads.ts";

const ISSUES = "repos/a11ign/agent-org/issues?state=all&sort=updated&direction=desc&per_page=5";
const ok = (tag: string, body = "[]"): string => `HTTP/2.0 200 OK\r\nEtag: W/"${tag}"\r\nX-Ratelimit-Resource: core\r\n\r\n${body}`;
const notModified = `HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n`;

/** An answering `run` that records the arguments it was given and answers `stdout`. */
function answering(stdout: string, status: number | null = 0) {
  const called: (readonly string[])[] = [];
  const run: AnsweringRun = (args) => { called.push(args); return { status, stdout, stderr: "" }; };
  return { called, run };
}

test("#4148: parseAnswer reads the status and the tag off an -i block, and the tag loses its W/", () => {
  assert.deepEqual(parseAnswer(ok("abc")), { status: 200, etag: '"abc"' });
  assert.deepEqual(parseAnswer(notModified), { status: 304, etag: '"x"' });
  assert.deepEqual(parseAnswer(""), { status: null, etag: null }, "no output is no status, not 200");
});

test("#4148: a probe is `api -i`, then `-H If-None-Match` when a tag is held, then the path; no tag held is unconditional", () => {
  const conditional = answering(notModified, 1);
  probeOf({ path: ISSUES, etag: '"t1"', run: conditional.run });
  assert.deepEqual(conditional.called, [["api", "-i", "-H", 'If-None-Match: "t1"', ISSUES]], "the held tag is sent, W/ already removed");
  const unconditional = answering(ok("t1"));
  probeOf({ path: ISSUES, etag: undefined, run: unconditional.run });
  assert.deepEqual(unconditional.called, [["api", "-i", ISSUES]]);
});

test("#4148: a probe never throws and answers how the call ended: a 304 (which `gh` exits 1 on), a server error and silence each carry their status, and none carries facts", () => {
  assert.deepEqual(probeOf({ path: "p", etag: '"t1"', run: answering(notModified, 1).run }), { status: 304, etag: '"x"', facts: undefined });
  assert.deepEqual(probeOf({ path: "p", etag: '"t1"', run: answering("HTTP/2.0 502 Bad Gateway\r\n\r\n", 1).run }), { status: 502, etag: null, facts: undefined });
  assert.deepEqual(probeOf({ path: "p", etag: '"t1"', run: answering("", null).run }), { status: null, etag: null, facts: undefined });
});

test("#1207: a 200 with a tag also says what its body listed; a 200 with no tag says nothing of its body", () => {
  const body = JSON.stringify([{ updated_at: "2026-10-11T18:00:00Z" }, { updated_at: "2026-10-11T19:05:00Z" }]);
  assert.deepEqual(probeOf({ path: "p", etag: undefined, run: answering(ok("t", body)).run }), { status: 200, etag: '"t"', facts: { newest: "2026-10-11T19:05:00Z", count: 2 } });
  assert.deepEqual(probeOf({ path: "p", etag: undefined, run: answering(`HTTP/2.0 200 OK\r\n\r\n${body}`).run }), { status: 200, etag: null, facts: undefined });
});

test("factsOf reads the newest updated_at and the count of an issues list or an Actions answer, and nothing it cannot confirm", () => {
  const issues = JSON.stringify([{ number: 100, updated_at: "2026-10-11T19:05:00Z" }, { number: 99, updated_at: "2026-10-11T18:00:00Z" }, { number: 98, updated_at: "2026-10-11T17:00:00Z" }]);
  const runs = JSON.stringify({ total_count: 2, workflow_runs: [{ updated_at: "2026-10-11T19:06:00Z" }, { updated_at: "2026-10-11T18:30:00Z" }] });
  assert.deepEqual(factsOf(`HTTP/2.0 200 OK\r\nEtag: "t"\r\n\r\n${issues}`), { newest: "2026-10-11T19:05:00Z", count: 3 });
  assert.deepEqual(factsOf(`HTTP/2.0 200 OK\r\n\r\n${runs}`), { newest: "2026-10-11T19:06:00Z", count: 2 });
  assert.deepEqual(factsOf("HTTP/2.0 200 OK\r\n\r\n[]"), { newest: null, count: 0 });
  assert.equal(factsOf("HTTP/2.0 200 OK\r\n\r\n<html>"), undefined);
  assert.equal(factsOf("HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify([{ number: 1 }])), undefined, "an item with no updated_at confirms nothing");
  assert.equal(factsOf("HTTP/2.0 200 OK\r\n"), undefined, "no blank line: no body");
});

test("the code host runs the probe with the bound, the buffer and the stderr policy the caller asked for, and answers the reading", () => {
  const requests: RunnerRequest[] = [];
  const withAnswer = (request: RunnerRequest): AnsweringRun => { requests.push(request); return () => ({ status: 0, stdout: ok("t9"), stderr: "" }); };
  const rows = createRows(() => ({ ...rowsReadHelpers } as never), { own: () => "", queue: () => "", withAnswer });
  const reading = rows.conditionalProbeOf({ path: ISSUES, etag: undefined, timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024 });
  assert.deepEqual(reading, { status: 200, etag: '"t9"', facts: { newest: null, count: 0 } });
  assert.deepEqual(requests, [{ timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024, echo: false }], "cut at the bound, 64 MiB of output, and what gh prints on stderr is not let through");
});

