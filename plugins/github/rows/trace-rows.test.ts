// no-token: none -- every operation is handed a stub `run` that records the argument list; nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 8): THE TRACE'S OPERATIONS AND WHAT THEY SAY TO `gh`. The trace (`src/trace/freshness.ts`, `headless-pilot.ts`, `publish.ts`, `trace.ts`, `haiku-tier-report.ts`) decides what to do with a row, a status line or a window;
 * its core tests run on the fake code host's rows (or at the module's own seam over parsed answers). What only GitHub's words can assert is held here: the order of the arguments of the conditional GET, the body of a comment going
 * on standard input and not in an argument, the error text when the program cannot start, the view of a row, and how the window of closed rows the Haiku report reads (moved from `src/packaging/haiku-tier.test.ts`) is paged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, SinceRead } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun, RunAnswer, RunnerRequest } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { apiTextOf, commentOnRowByInput, conditionalGetOf, rowSnapshotOf } from "./trace-rows.ts";

type Called = { args: readonly string[]; input: string | undefined };

/** An answering `run` that records each call (its arguments and its standard input) and answers `answer`. */
function answering(answer: RunAnswer) {
  const called: Called[] = [];
  const run: AnsweringRun = (args, options) => { called.push({ args, input: options?.input }); return answer; };
  return { called, run };
}
const ok: RunAnswer = { status: 0, stdout: "", stderr: "" };

// --- the view of a row, and `gh api` ------------------------------------------------------------------------------------------------

test("a row is viewed with one `issue view` of its repository asking exactly the five fields, and the answer is parsed", () => {
  const seen: string[][] = [];
  const row = { number: 7, state: "OPEN", title: "t", body: "b", labels: [{ name: "ready" }] };
  const run = (args: string[]): string => { seen.push(args); return JSON.stringify(row); };
  assert.deepEqual(rowSnapshotOf({ repo: "a11ign/a11ign", number: 7, run }), row);
  assert.deepEqual(seen, [["issue", "view", "7", "--repo", "a11ign/a11ign", "--json", "number,state,title,body,labels"]]);
  assert.throws(() => rowSnapshotOf({ repo: "r/r", number: 1, run: () => "not json" }), SyntaxError);
  assert.throws(() => rowSnapshotOf({ repo: "r/r", number: 1, run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);
});

test("`gh api` runs the caller's arguments after the verb, and answers the text as the run did; a refusal is thrown as it came", () => {
  const seen: string[][] = [];
  assert.equal(apiTextOf({ args: ["repos/a/b/pulls/9", "-X", "GET"], run: (args) => { seen.push(args); return "text"; } }), "text");
  assert.deepEqual(seen, [["api", "repos/a/b/pulls/9", "-X", "GET"]]);
  assert.throws(() => apiTextOf({ args: ["x"], run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

// --- the conditional GET ------------------------------------------------------------------------------------------------------------

test("a conditional GET puts `-H If-None-Match` FIRST (the ledger keeps the first two words, `api -H`), then `-i`, then the path; an unconditional one is `api -i <path>`", () => {
  const { called, run } = answering({ status: 0, stdout: "HTTP/2.0 200 OK\r\nEtag: W/\"a\"\r\n\r\n{}", stderr: "" });
  conditionalGetOf({ path: "repos/a/b/branches/main", etag: 'W/"abc"', run });
  conditionalGetOf({ path: "repos/a/b/branches/main", etag: null, run });
  assert.deepEqual(called.map((call) => call.args), [
    ["api", "-H", 'If-None-Match: W/"abc"', "-i", "repos/a/b/branches/main"],
    ["api", "-i", "repos/a/b/branches/main"],
  ]);
  assert.deepEqual(called.map((call) => call.args.slice(0, 2).join(" ")), ["api -H", "api -i"], "the two words the ledger keeps tell the conditional reads from the others");
  assert.deepEqual(called.map((call) => call.input), [undefined, undefined], "nothing is written to its standard input");
});

test("a conditional GET never throws: a 304 (which `gh` exits 1 on), a refusal and a program that could not start come back as how the call ended", () => {
  const notModified: RunAnswer = { status: 1, stdout: "HTTP/2.0 304 Not Modified\r\n\r\n", stderr: "gh: HTTP 304" };
  assert.deepEqual(conditionalGetOf({ path: "p", etag: 'W/"x"', run: answering(notModified).run }), notModified);
  const cannotStart: RunAnswer = { status: null, stdout: "", stderr: "spawnSync gh ENOENT", error: "spawnSync gh ENOENT" };
  assert.deepEqual(conditionalGetOf({ path: "p", etag: null, run: answering(cannotStart).run }), cannotStart);
});

test("through the code host, the conditional GET asks its runner for the caller's buffer and keeps what gh prints on stderr out of this process's", () => {
  const requests: RunnerRequest[] = [];
  const { called, run } = answering(ok);
  const rows = createRows(() => rowsReadHelpers() as unknown as RowsHelpers, { own: run as never, queue: run as never, withAnswer: (request) => { requests.push(request); return run; } });
  rows.conditionalGetOf({ path: "repos/a/b/pulls/3", etag: 'W/"q"', maxBuffer: 33_554_432 });
  assert.deepEqual(requests, [{ maxBuffer: 33_554_432, echo: false }]);
  assert.deepEqual(called.map((call) => call.args), [["api", "-H", 'If-None-Match: W/"q"', "-i", "repos/a/b/pulls/3"]]);
});

// --- the comment on the standing row ------------------------------------------------------------------------------------------------

test("a comment goes to the row of its repository with the BODY ON STANDARD INPUT (`--body-file -`) and not in an argument", () => {
  const { called, run } = answering(ok);
  const body = "an incident, with a secret-looking 192.0.2.1 in it";
  commentOnRowByInput({ repo: "a11ign/agent-org", number: 928, body, run });
  commentOnRowByInput({ repo: "a11ign/agent-org", number: "929", body, run });
  assert.deepEqual(called.map((call) => call.args), [
    ["issue", "comment", "928", "--repo", "a11ign/agent-org", "--body-file", "-"],
    ["issue", "comment", "929", "--repo", "a11ign/agent-org", "--body-file", "-"],
  ]);
  assert.deepEqual(called.map((call) => call.input), [body, body]);
  assert.ok(!called.some((call) => call.args.some((arg) => arg.includes("secret-looking"))), "the body is in no argument");
});

test("a comment that fails THROWS with what the program printed, the exit status when it printed nothing, and why it could not start when it did not", () => {
  const throwsWith = (answer: RunAnswer, text: RegExp) => assert.throws(() => commentOnRowByInput({ repo: "r/r", number: 1, body: "b", run: answering(answer).run }), text);
  throwsWith({ status: 1, stdout: "", stderr: "gh: HTTP 403: Resource not accessible\n" }, /^Error: gh: HTTP 403: Resource not accessible$/);
  throwsWith({ status: 2, stdout: "", stderr: "" }, /^Error: exit 2$/);
  throwsWith({ status: null, stdout: "", stderr: "", error: "spawnSync gh ETIMEDOUT" }, /^Error: spawnSync gh ETIMEDOUT$/);
  throwsWith({ status: null, stdout: "", stderr: "cut", error: "spawnSync gh ENOENT" }, /ENOENT/);
  assert.doesNotThrow(() => commentOnRowByInput({ repo: "r/r", number: 1, body: "b", run: answering(ok).run }), "CONTROL: a comment that was made is not an error");
});

test("through the code host, the comment is cut at the bound the caller names and what gh prints on stderr stays out of this process's", () => {
  const requests: RunnerRequest[] = [];
  const { called, run } = answering(ok);
  const rows = createRows(() => rowsReadHelpers() as unknown as RowsHelpers, { own: run as never, queue: run as never, withAnswer: (request) => { requests.push(request); return run; } });
  rows.commentOnRowByInput({ repo: "a11ign/agent-org", number: 928, body: "b", timeoutMs: 30_000 });
  assert.deepEqual(requests, [{ timeoutMs: 30_000, echo: false }]);
  assert.deepEqual(called, [{ args: ["issue", "comment", "928", "--repo", "a11ign/agent-org", "--body-file", "-"], input: "b" }]);
});

// --- the window of closed rows the Haiku report reads (moved from src/packaging/haiku-tier.test.ts, agent-org#707, #5076) ----------------

const REPO = "a11ign/agent-org";
const CLOSED_WINDOW = (since: string, maxPages: number): SinceRead => ({ kind: "issues", states: ["CLOSED"], orderBy: "UPDATED_AT", repo: REPO, select: "number closedAt", since, maxPages });

/** A GitHub whose CLOSED issues are `all`: the connection read answers them newest-UPDATED first, a hundred to a page, and keeps every argument list it was sent. */
function connection(all: { number: number; closedAt: string; updatedAt: string }[]) {
  const sorted = [...all].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const after = args.find((arg) => arg.startsWith("after="))?.slice("after=".length);
    const from = after === undefined ? 0 : Number(after.replace(/^c/, ""));
    const more = from + 100 < sorted.length;
    return JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: more, endCursor: more ? `c${from + 100}` : null }, nodes: sorted.slice(from, from + 100) } } } });
  };
  return { calls, run };
}
const closedAt = (hours: number) => new Date(Date.UTC(2026, 9, 10) + hours * 3_600_000).toISOString();
const closedRows = (count: number, startNumber = 1) => Array.from({ length: count }, (_, i) => ({ number: startNumber + i, closedAt: closedAt(1), updatedAt: closedAt(1 + i / 1000) }));
const reader = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

test("a window of 351 closed rows updated inside it is four pages of the connection, read to the first row before it, and a row opened long ago is among them", () => {
  const { calls, run } = connection([...closedRows(350, 5000), { number: 10, closedAt: closedAt(5), updatedAt: closedAt(5) }, { number: 20, closedAt: closedAt(-10), updatedAt: closedAt(-10) }]);
  const read = reader().readRowsSince({ ask: CLOSED_WINDOW(closedAt(0), 10), run });
  assert.equal(read.length, 351, "everything updated at or after the window's start, and not #20");
  assert.ok(read.some((node) => node.number === 10), "#10 is read though it was opened before the 300 newest created");
  assert.ok(!read.some((node) => node.number === 20));
  assert.equal(calls.length, 4, "four pages: three full ones and the one that reaches the first row before the window");
});

test("the window is a connection read: no argument list is a GitHub search, a label filter or a limit (#5076)", () => {
  const { calls, run } = connection(closedRows(3));
  reader().readRowsSince({ ask: CLOSED_WINDOW(closedAt(0), 10), run });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(calls.every((args) => !args.includes("--search") && !args.includes("--label") && !args.includes("--limit")), "no argv is a GitHub search");
  const query = calls[0].find((arg) => arg.startsWith("query="))!;
  assert.match(query, /issues\(states:\[CLOSED\],first:100,after:\$after,orderBy:\{field:UPDATED_AT,direction:DESC\}\)/);
  assert.ok(calls[0].includes(`owner=a11ign`) && calls[0].includes(`name=agent-org`));
});

test("a window of more updated rows than the pages allowed THROWS, never a count short by the rows it left behind; one that fits is read whole", () => {
  assert.throws(() => reader().readRowsSince({ ask: CLOSED_WINDOW(closedAt(0), 10), run: connection(closedRows(1001)).run }), /may be cut short/);
  const whole = connection(closedRows(1000));
  assert.equal(reader().readRowsSince({ ask: CLOSED_WINDOW(closedAt(0), 10), run: whole.run }).length, 1000, "control: exactly the limit is a whole window");
  assert.equal(whole.calls.length, 10);
});
