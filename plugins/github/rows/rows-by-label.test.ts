// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * #5039 / #5050 (A11-160, step 9, moved from `src/packaging/no-search-reads.test.ts`, whose `run` stubs fed GitHub's GraphQL connections and its refusal text to core's readers): NO SEARCH-BACKED READ ON THE CLAIM
 * PATH OR IN THE GATE, AND ONE REFUSAL IS ASKED ONCE PER TICK. What GitHub is asked (a connection read whose label is a variable, never `--label` or `--search`) and how its answer is read (a connection's pages, a
 * payload that is not one, a refusal for a limit) are this plugin's, so the stubbed answers are fed to the real operations here. What the claim and the gate DECIDE from the rows they get back is core's, and
 * `src/packaging/no-search-reads.test.ts` holds it over the fake code host's rows.
 *
 * `gh issue list --label X` (and `--search`) is sent by `gh` as a GitHub SEARCH, whose allowance is separate from and far smaller than the GraphQL points. On 2026-10-11 the scheduler App's installation spent it and every
 * claim was refused for it (`B4 COULD NOT BE ASKED`, eighteen times in thirty minutes) while 3,948 points were left and a plain `gh api graphql` still worked.
 *
 * Claims, each with a case that can fail:
 *   1. the claim's read answers through a `run` that REFUSES any argv carrying `--label` or `--search` (POSITIVE CONTROL: the same fake answers the non-search read); a read that fails THROWS (core turns it into
 *      `null`, never `[]`), and a payload that is not a connection, or a list that is not the whole population, throws too (NEGATIVE CONTROL);
 *   2. a read refused for a limit is asked ONCE in a tick, and the line it leaves names WHICH resource;
 *   3. (#5050) every list the gate reads answers through such a `run`, and a read the limit refused is NOT asked again by ANY other list read of the tick, whichever kind.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { closedAnswerConnection, connectionOf, readsClosedAnswerRows, readsRecentlyClosed, readsRowsByLabel, recentlyClosedConnection } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const TRACKER = "a11ign/a11ign";
const LIMIT_TEXT = "GraphQL: API rate limit already exceeded for installation ID 170075049";
const PROBE = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3948\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}";

beforeEach(() => rows().forgetRefusedReads());

const claimed = (number: number, file: string, labels: string[] = ["in-progress"]) => ({
  number, labels, body: `## Region\n\n\`\`\`\n${file}\n\`\`\`\n`, blockedBy: { nodes: [{ number: number + 1 }] },
});

/** The fake of the incident: any argv that is a search is refused in the words the installation was refused in; the connection answers. */
function searchRefusingRun(held: ReturnType<typeof claimed>[]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("--label") || args.includes("--search")) throw new Error(LIMIT_TEXT);
    if (readsRowsByLabel(args)?.label === "in-progress") return connectionOf(held);
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// --- 1. the claim's read ---------------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: with every `--label` and `--search` argv refused, the claim still reads who holds what -- as one connection read -- and the fake DOES refuse a search", () => {
  const { run, calls } = searchRefusingRun([claimed(5032, "src/work-gate.ts"), claimed(948, "src/queue-table.ts")]);
  assert.throws(() => run(["issue", "list", "--label", "in-progress"]), /rate limit already exceeded/, "the control: the fake is a refusing one, so a pass below is not a fake that accepts anything");
  calls.length = 0;
  const held = rows().readClaimedRows({ run, repo: TRACKER });
  assert.deepEqual(held.map(({ number, blockedBy }) => ({ number, blockedBy: blockedBy.nodes.map((edge) => edge.number) })), [{ number: 5032, blockedBy: [5033] }, { number: 948, blockedBy: [949] }]);
  assert.equal(calls.length, 1, "one read, and it is not a search");
  assert.ok(!calls[0].includes("--label") && !calls[0].includes("--search"));
  assert.ok(calls[0].includes("label=in-progress"), "the label is a variable of the connection, not a filter flag");
});

test("NEGATIVE CONTROL: a read that fails THROWS, never `[]` -- a refusal, a bad payload, and a list that is not the whole population", () => {
  const read = (run: (args: string[]) => string) => () => rows().readClaimedRows({ run, repo: TRACKER, log: () => undefined });
  assert.throws(read(() => { throw new Error(LIMIT_TEXT); }), /rate limit already exceeded/);
  rows().forgetRefusedReads();
  assert.throws(read(() => { throw new Error("gh: 502"); }), /502/);
  assert.throws(read(() => "not json"));
  assert.throws(read(() => JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] })), /did not come back as a connection: Could not resolve/);
  assert.throws(read(() => connectionOf([claimed(1, "src/a.ts")], { hasNextPage: true })), /may be cut short/, "a next page that is never read is a list cut short");
  assert.deepEqual(read(() => connectionOf([]))(), [], "control: nobody holding a file IS `[]` when the read succeeded -- the two answers are different values");
});

test("the rows come back in the shape `gh issue list --json` gave, across pages, so no comparison had to change", () => {
  const pages = [connectionOf([claimed(1, "src/a.ts")], { hasNextPage: true }), connectionOf([claimed(2, "src/b.ts", ["in-progress", "session:worker-2"])])];
  const held = rows().readClaimedRows({ run: () => pages.shift() as string, repo: TRACKER });
  assert.deepEqual(held.map((row) => row.number), [1, 2]);
  assert.deepEqual(held[1].labels, [{ name: "in-progress" }, { name: "session:worker-2" }]);
  assert.deepEqual(held[0].blockedBy, { nodes: [{ number: 2 }] });
});

// --- 2. a limit-refused read is asked once, and says which resource -----------------------------------------------------------------------

test("a read refused for a limit is asked ONCE in a tick, and the line names the resource it came from", () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (readsRowsByLabel(args) !== null) throw new Error(LIMIT_TEXT);
    return PROBE; // the one follow-up read of the GraphQL pool, whose headers name the pool that answered
  };
  const first = () => rows().readClaimedRows({ run, repo: TRACKER, log: (line: string) => lines.push(line) });
  assert.throws(first, /rate limit already exceeded/);
  assert.throws(first, /not asked again this tick/);
  assert.throws(first, /not asked again this tick/);
  assert.equal(calls.filter((args) => readsRowsByLabel(args) !== null).length, 1, "the refused read went to GitHub once; the second and third asks did not");
  assert.equal(lines.length, 1, "and said so once");
  assert.match(lines[0], /3948 of 5000 left/, "it names the pool it read, with the count");
  assert.match(lines[0], /a secondary limit: the installation was refused while its pool reads 3948 of 5000 left/, "and that an installation refused while its pool reads healthy is a secondary limit (#1523)");
  assert.match(lines[0], /installation ID 170075049/, "and keeps the one identifier the refusal carried");
});

test("a refusal that is not a limit is not remembered: the next ask goes to GitHub again", () => {
  let asked = 0;
  const run = (): string => { asked += 1; throw new Error("gh: 502"); };
  assert.throws(() => rows().readClaimedRows({ run, repo: TRACKER }), /502/);
  assert.throws(() => rows().readClaimedRows({ run, repo: TRACKER }), /502/);
  assert.equal(asked, 2);
});

// --- 3. the gate's lists ---------------------------------------------------------------------------------------------------------------

/** What a gate list read gets from a GitHub whose SEARCH allowance is spent: every `--label`/`--search` argv is refused in the incident's words, a connection answers. */
function gateGitHub() {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("--label") || args.includes("--search") && args[0] !== "label") throw new Error(LIMIT_TEXT);
    if (args[0] === "label") return JSON.stringify([{ name: "answer:ceo" }]);
    if (readsRowsByLabel(args) !== null) return connectionOf([claimed(7, "src/a.ts", ["ready", "backlog", "needs:chairman", "in-progress"])]);
    if (readsClosedAnswerRows(args) !== null) return closedAnswerConnection([]);
    if (readsRecentlyClosed(args)) return recentlyClosedConnection([{ number: 3, closedAt: "2026-10-11T10:00:00Z", updatedAt: "2026-10-11T10:00:00Z" }]);
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { run, calls };
}

/** The gate's list reads, each as the one operation of the code host it makes. */
const GATE_LISTS: { name: string; read: (run: (args: string[]) => string) => unknown; }[] = [
  { name: "rows labelled chairman-blocked", read: (run) => rows().readRowsByLabel({ label: "needs:chairman", state: "OPEN", select: "number", run }) },
  { name: "rows labelled backlog", read: (run) => rows().readRowsByLabel({ label: "backlog", state: "OPEN", select: "number", newest: 200, run }) },
  { name: "rows labelled ready", read: (run) => rows().readRowsByLabel({ label: "ready", state: "OPEN", select: "number", newest: 100, run }) },
  { name: "closed rows carrying an answer label", read: (run) => rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run }) },
  { name: "closed pull requests carrying an answer label", read: (run) => rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "pullRequests", run }) },
  { name: "the newest-updated closed rows", read: (run) => rows().recentlyClosedRowsOf({ limit: 100, run }) },
  { name: "the answer label names", read: (run) => rows().labelNamesWithPrefix({ prefix: "answer:", run }) },
];

test("POSITIVE CONTROL: every list the gate reads answers while every `--label` and `--search` argv is refused -- and the fake DOES refuse one", () => {
  const { run, calls } = gateGitHub();
  assert.throws(() => run(["issue", "list", "--label", "ready"]), /rate limit already exceeded/, "the control: a pass below is not a fake that accepts anything");
  calls.length = 0;
  for (const { name, read } of GATE_LISTS) {
    rows().forgetRefusedReads();
    assert.notEqual(read(run), null, `${name} answered through connections`);
  }
  assert.ok(calls.length >= GATE_LISTS.length, "each read asked");
  assert.deepEqual(calls.filter((args) => args.includes("--label") || (args.includes("--search") && args[0] !== "label")), [], "and none of them was a search");
});

test("NEGATIVE CONTROL: a gate list read that FAILS throws, never answers `[]` -- for every list", () => {
  for (const { name, read } of GATE_LISTS) {
    rows().forgetRefusedReads();
    assert.throws(() => read(() => { throw new Error("gh: 502"); }), /502/, `${name} is not an empty list from a failed read`);
  }
});

test("a read refused for a LIMIT is asked ONCE in the tick: no other gate list read -- by label, closed answers or recently closed -- is sent, and the line names the resource", () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "api" && args.includes("-i")) return PROBE;
    throw new Error(LIMIT_TEXT);
  };
  assert.throws(() => rows().readRowsByLabel({ label: "ready", state: "OPEN", select: "number", run, log: (line) => lines.push(line) }), /rate limit already exceeded/, "the first read is refused");
  const asked = calls.length;
  for (const { name, read } of GATE_LISTS.filter(({ name }) => name !== "rows labelled ready" && name !== "the answer label names")) {
    assert.throws(() => read(run), /not asked again this tick/, `${name} is not sent after the refusal`);
  }
  assert.equal(calls.length, asked, "and not one more call was sent by the other readers");
  assert.equal(lines.length, 1, "the refusal is said once");
  assert.match(lines[0], /OPEN rows labelled ready/);
  assert.match(lines[0], /3948 of 5000 left/, "and names the pool it read");
});

test("the closed answer reads are under the SAME memory as the by-label ones: a refused closed read stops the next by-label read of the tick", () => {
  let refused = false;
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (readsClosedAnswerRows(args) !== null) { refused = true; throw new Error(LIMIT_TEXT); }
    throw new Error("unexpected call after the refusal");
  };
  const quiet = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.throws(() => rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run }), /rate limit already exceeded/);
    const asked = calls.length;
    assert.throws(() => rows().readRowsByLabel({ label: "needs:chairman", state: "OPEN", select: "number", run }), /not asked again this tick/, "and the by-label read, which would have thrown `unexpected call`, was never sent");
    assert.equal(calls.length, asked);
  } finally {
    process.stderr.write = quiet;
  }
  assert.ok(refused, "control: the closed read was the one that was refused");
});
