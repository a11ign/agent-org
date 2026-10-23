// no-token: none -- every read is the fake code host's rows (a world held in memory, with refused reads named); the `run` the reader takes is one that throws, and nothing reaches `gh`
/**
 * a11ign/agent-org#483, part 2: THE `NOTE` SAYS WHY THE CLOSED-ANSWER-ROWS READ FAILED.
 *
 * `NOTE: could not read the closed rows that still owe an answer ...` printed every tick and `readClosedAnswerRows` hid the cause in a
 * bare `catch { return null }`. Measured by `orchestrator` off `gh-calls.tsv`: under the workers' token the second call
 * (`issue list --state closed --search 'label:"answer:..",...'`) is the last the reader makes. The return stays `null` -- "could not ask" is
 * not "nobody owes" -- and the line now names the `gh` verb that failed and the first line of why.
 *
 * #5050: the two reads after the label list are no longer `issue list` / `pr list` (both were SEARCHES) but aliased GraphQL connection reads. The refusal line still
 * names them `issue list` / `pr list`: the line says which of the three reads failed, not the transport.
 *
 * A11-160 (step 6): the three reads are the code host's (`labelNamesWithPrefix`, and `closedRowsCarryingLabels` once per kind), answered by the FAKE code host's rows over a world this file seeds: a read
 * is refused by naming it in `world.failures` (`closedRowsCarryingLabels issues` refuses the issues read alone), and an answer that is not whole is `world.gate.closedRowsNotWhole`. What each operation
 * sends and how it reads GitHub's answer is the plugin's (`plugins/github/rows/gate-pull-reads.test.ts`).
 *
 * POSITIVE CONTROL: the twin whose three calls all answer prints no `NOTE`, so the line is asserted absent on a read that DID run, and
 * the first case's `NOTE` is asserted present by the same capture.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { closedAnswerRows, readClosedAnswerRows } from "./work-gate/causes/rows-answers.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";

afterEach(() => forgetActivation());

/** What `closedAnswerRows` writes to stderr while it runs; the real `write` is put back whatever happens. */
function said(run: () => unknown): { lines: string[]; answer: unknown } {
  const write = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { answer: run(), lines }; } finally { process.stderr.write = write; }
}

/** What a closed read answers when it is told nothing else: it ran and found no closed row carrying the label (#5050). */
const NOBODY = "nobody";
/** A closed read whose answer is a connection that holds no list of rows (`{}`): not whole. */
const NOT_A_LIST = "{}";
/** A closed read whose answer is text that does not parse: the parser throws its own line. */
const GARBLED = "not json";

/**
 * The fake code host holding one `answer:` label, with the closed issues read answering `answers[0]` and the closed pull requests read `answers[1]`: `NOBODY`, `NOT_A_LIST`, `GARBLED`, or an `Error` the read
 * throws. `calls` names the reads asked, in order: `label list`, `issues`, `pullRequests`.
 */
const runWith = (...answers: (string | Error)[]) => {
  const host = createFakeCodeHost();
  const { rowsWorld: world, rows } = host;
  world.labelsCreated.push("answer:ceo");
  (["issues", "pullRequests"] as const).forEach((kind, at) => {
    const answer = answers[at] ?? NOBODY;
    if (answer instanceof Error) world.failures.set(`closedRowsCarryingLabels ${kind}`, answer);
    else if (answer === NOT_A_LIST) world.gate.closedRowsNotWhole.add(kind);
    else if (answer === GARBLED) world.failures.set(`closedRowsCarryingLabels ${kind}`, new SyntaxError("Unexpected token 'o', \"not json\" is not valid JSON"));
  });
  const calls: string[] = [];
  const labels = rows!.labelNamesWithPrefix;
  rows!.labelNamesWithPrefix = (request) => { calls.push("label list"); return labels(request); };
  const carrying = rows!.closedRowsCarryingLabels;
  rows!.closedRowsCarryingLabels = (request) => { calls.push(request.kind); return carrying(request); };
  substituteCodeHost(host);
  const run = (): string => {
    throw new Error("the fake code host acts on its own state: no gh is run");
  };
  return { run, calls };
};

const NOTE = /^NOTE: could not read the closed rows that still owe an answer/;

test("#483: a run that throws `boom` on its second call -- the NOTE names `issue list` and `boom`, and the read still answers null", () => {
  const { run, calls } = runWith(new Error("boom"));
  const rows = readClosedAnswerRows(run);
  assert.equal(rows, null, "could not ask is not nobody owes");
  assert.deepEqual(calls, ["label list", "issues"], "the throw is on the closed-issues read, the second call, and nothing is asked after it (#5050: a connection read, not `issue list`)");
  const { lines, answer } = said(() => closedAnswerRows(rows));
  assert.deepEqual(answer, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], NOTE);
  assert.match(lines[0], /issue list/);
  assert.match(lines[0], /boom/);
  assert.ok(lines[0].endsWith("\n") && lines[0].indexOf("\n") === lines[0].length - 1, "one line");
});

test("#483 control: a run whose three calls all answer nobody prints no NOTE and the read answers []", () => {
  const { run, calls } = runWith(NOBODY, NOBODY);
  const rows = readClosedAnswerRows(run);
  assert.deepEqual(rows, []);
  assert.deepEqual(calls, ["label list", "issues", "pullRequests"], "the label list, the closed issues and the closed pull requests were all asked");
  const { lines } = said(() => closedAnswerRows(rows));
  assert.deepEqual(lines, []);
});

test("#483: the reason is the failing call's, not the previous one's, and a refusal does not outlive the read that made it", () => {
  const third = runWith(NOBODY, new Error("HTTP 502\nsecond line"));
  const first = said(() => closedAnswerRows(readClosedAnswerRows(third.run)));
  assert.match(first.lines[0], /pr list/);
  assert.match(first.lines[0], /HTTP 502/);
  assert.doesNotMatch(first.lines[0], /second line/, "the first line only");
  // the next read answers, and a later refusal that is not its own reads as no reason rather than the stale one
  assert.deepEqual(readClosedAnswerRows(runWith(NOBODY, NOBODY).run), []);
  const unreadable = said(() => closedAnswerRows(null));
  assert.match(unreadable.lines[0], NOTE);
  assert.doesNotMatch(unreadable.lines[0], /HTTP 502/);
});

test("#483: a gh failure's own `Command failed:` line is not the reason; its stderr is, and the line is cut", () => {
  const long = "x".repeat(400);
  const failed = Object.assign(new Error(`Command failed: gh api graphql -f query=${long}`), { stderr: "HTTP 403: Resource not accessible by personal access token\nmore" });
  const { lines } = said(() => closedAnswerRows(readClosedAnswerRows(runWith(failed).run)));
  assert.match(lines[0], /issue list: HTTP 403: Resource not accessible by personal access token/);
  assert.doesNotMatch(lines[0], /Command failed/);
  const cut = said(() => closedAnswerRows(readClosedAnswerRows(runWith(new Error(long)).run)));
  assert.ok(!cut.lines[0].includes("x".repeat(161)), "cut to the length of the other class-repeat lines (160)");
});

test("#483: a read answering something that is not a connection names the call that did, and text that does not parse names the parser's own line", () => {
  const notList = said(() => closedAnswerRows(readClosedAnswerRows(runWith(NOBODY, NOT_A_LIST).run)));
  assert.match(notList.lines[0], /pr list: answered something that is not a list/);
  const firstNotList = said(() => closedAnswerRows(readClosedAnswerRows(runWith(NOT_A_LIST, NOBODY).run)));
  assert.match(firstNotList.lines[0], /issue list: answered something that is not a list/);
  const garbled = said(() => closedAnswerRows(readClosedAnswerRows(runWith(GARBLED).run)));
  assert.match(garbled.lines[0], /issue list: /);
});
