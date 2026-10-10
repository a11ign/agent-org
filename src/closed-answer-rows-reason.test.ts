// no-token: gh -- every `gh` here is the injected `run` seam `readClosedAnswerRows` takes; nothing reaches the real one
/**
 * a11ign/agent-org#483, part 2: THE `NOTE` SAYS WHY THE CLOSED-ANSWER-ROWS READ FAILED.
 *
 * `NOTE: could not read the closed rows that still owe an answer ...` printed every tick and `readClosedAnswerRows` hid the cause in a
 * bare `catch { return null }`. Measured by `orchestrator` off `gh-calls.tsv`: under the workers' token the second call
 * (`issue list --state closed --search 'label:"answer:..",...'`) is the last the reader makes. The return stays `null` -- "could not ask" is
 * not "nobody owes" -- and the line now names the `gh` verb that failed and the first line of why.
 *
 * POSITIVE CONTROL: the twin whose three calls all answer prints no `NOTE`, so the line is asserted absent on a read that DID run, and
 * the first case's `NOTE` is asserted present by the same capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedAnswerRows, readClosedAnswerRows } from "./work-gate.ts";

/** What `closedAnswerRows` writes to stderr while it runs; the real `write` is put back whatever happens. */
function said(run: () => unknown): { lines: string[]; answer: unknown } {
  const write = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { answer: run(), lines }; } finally { process.stderr.write = write; }
}

const LABELS = JSON.stringify([{ name: "answer:ceo" }]);

/** A `run` answering the label list and then `answers[n]` for the n-th later call; a function in `answers` is thrown from. */
const runWith = (...answers: (string | Error)[]) => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const answer = calls.length === 1 ? LABELS : answers[calls.length - 2];
    if (answer instanceof Error) throw answer;
    return answer ?? "[]";
  };
  return { run, calls };
};

const NOTE = /^NOTE: could not read the closed rows that still owe an answer/;

test("#483: a run that throws `boom` on its second call -- the NOTE names `issue list` and `boom`, and the read still answers null", () => {
  const { run, calls } = runWith(new Error("boom"));
  const rows = readClosedAnswerRows(run);
  assert.equal(rows, null, "could not ask is not nobody owes");
  assert.equal(calls.length, 2, "the throw is on `issue list`, the second call, and nothing is asked after it");
  assert.deepEqual(calls[1].slice(0, 2), ["issue", "list"]);
  const { lines, answer } = said(() => closedAnswerRows(rows));
  assert.deepEqual(answer, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], NOTE);
  assert.match(lines[0], /issue list/);
  assert.match(lines[0], /boom/);
  assert.ok(lines[0].endsWith("\n") && lines[0].indexOf("\n") === lines[0].length - 1, "one line");
});

test("#483 control: a run whose three calls all answer [] prints no NOTE and the read answers []", () => {
  const { run, calls } = runWith("[]", "[]");
  const rows = readClosedAnswerRows(run);
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 3, "the label list, the closed issues and the closed pull requests were all asked");
  const { lines } = said(() => closedAnswerRows(rows));
  assert.deepEqual(lines, []);
});

test("#483: the reason is the failing call's, not the previous one's, and a refusal does not outlive the read that made it", () => {
  const third = runWith("[]", new Error("HTTP 502\nsecond line"));
  const first = said(() => closedAnswerRows(readClosedAnswerRows(third.run)));
  assert.match(first.lines[0], /pr list/);
  assert.match(first.lines[0], /HTTP 502/);
  assert.doesNotMatch(first.lines[0], /second line/, "the first line only");
  // the next read answers, and a later refusal that is not its own reads as no reason rather than the stale one
  assert.deepEqual(readClosedAnswerRows(runWith("[]", "[]").run), []);
  const unreadable = said(() => closedAnswerRows(null));
  assert.match(unreadable.lines[0], NOTE);
  assert.doesNotMatch(unreadable.lines[0], /HTTP 502/);
});

test("#483: a gh failure's own `Command failed:` line is not the reason; its stderr is, and the line is cut", () => {
  const long = "x".repeat(400);
  const failed = Object.assign(new Error(`Command failed: gh issue list --search ${long}`), { stderr: "HTTP 403: Resource not accessible by personal access token\nmore" });
  const { lines } = said(() => closedAnswerRows(readClosedAnswerRows(runWith(failed).run)));
  assert.match(lines[0], /issue list: HTTP 403: Resource not accessible by personal access token/);
  assert.doesNotMatch(lines[0], /Command failed/);
  const cut = said(() => closedAnswerRows(readClosedAnswerRows(runWith(new Error(long)).run)));
  assert.ok(!cut.lines[0].includes("x".repeat(161)), "cut to the length of the other class-repeat lines (160)");
});

test("#483: a search answering a non-list names the call that did, and text that does not parse names the parser's own line", () => {
  const notList = said(() => closedAnswerRows(readClosedAnswerRows(runWith("[]", "{}").run)));
  assert.match(notList.lines[0], /pr list: answered something that is not a list/);
  const firstNotList = said(() => closedAnswerRows(readClosedAnswerRows(runWith("{}", "[]").run)));
  assert.match(firstNotList.lines[0], /issue list: answered something that is not a list/);
  const garbled = said(() => closedAnswerRows(readClosedAnswerRows(runWith("not json").run)));
  assert.match(garbled.lines[0], /issue list: /);
});
