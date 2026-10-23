// no-token: none -- the fake code host's rows answer the board from a world held in memory (A11-160, step 8); the few cases that hand the snapshot a malformed answer do it through a `run` that returns a string, and nothing here calls or spawns gh (#1352, route (a))
/**
 * Every board mutation must snapshot before it writes -- issue #399. 2026-09-08: adding one Status option
 * with `updateProjectV2Field` and a full `singleSelectOptions` list REPLACED the whole option set and
 * dropped all 112 items' Status assignment in one call. Recovered completely, and only because a snapshot
 * happened to exist from minutes earlier for an unrelated reason. `withBoardSnapshot` makes that
 * deliberate: the mutation runs ONLY after a real snapshot has been written, never on the strength of one
 * that "would have existed anyway".
 *
 * A11-160, step 8: the board's items and the ready list are the CODE HOST's reads now (`boardItemsPageOf`, `touchedItemTextOf` and `readRowsByLabel` of its rows), so what the snapshot DECIDES (the coverage floor, which
 * cause a missing row has, the Status refusal, the scoped and the reused route, the memory of a Project the token cannot read) runs on the fake code host: a case seeds rows (on the board, at a Status, `ready`) and the
 * world's facts (`world.reports.snapshot`), and counts the operations the snapshot asked. The query's shape, its variables and the error body a failed process carries are the plugin's
 * (`plugins/github/rows/board-snapshot-rows.test.ts`). THE CASES THAT STAY AT THE SEAM hand the snapshot an answer no row renders -- a page that is not JSON, that lacks the items, or that carries `errors` beside its
 * data -- through an injected `run` on the real operation, which returns GitHub's text untouched: they hold how the snapshot READS a malformed answer.
 */
import { afterEach, test } from "node:test";
import { testEach } from "../lib/test-each.ts";
import assert from "node:assert/strict";
import {
  fetchBoardItems,
  fetchReadyIssueNumbers,
  readyRowsMissingStatus,
  classifyAbsentReadyRows,
  missingStatusRefusal,
  writeBoardSnapshot,
  withBoardSnapshot,
  forgetProcessSnapshot,
  SNAPSHOT_MAX_AGE_MS,
  snapshotStamp,
  PROJECT_OWNER,
  PROJECT_NUMBER,
  SNAPSHOT_DIR,
} from "../board-snapshot.ts";
import { commonGitDirOf, snapshotDirFor, launchCheckoutOf, primaryLaunchRefusal, PRIMARY_MARK_KEY,
  primaryLaunchDecision, POLICY_LAUNCH_REASON_ENV, launchGate }
  from "../board-snapshot-scope.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync as mkdirOnDisk, realpathSync, rmSync, writeFileSync as writeOnDisk } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirOf, join as joinPath } from "node:path";
import { fileURLToPath as pathOf } from "node:url";
import { HOME_CHECKOUT } from "../project-config.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { REPO } from "../project-identity.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow, type FakeRow, type FakeRowsWorld } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

/** The fake code host in place, its operations WATCHED, and its world. A case seeds the world and counts what the snapshot asked of the rows (`asked("boardItemsPageOf")`). */
function board() {
  const host = createFakeCodeHost();
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  const asked = (op: string) => watched.calls.filter((call) => call.op === op);
  return { world: host.rowsWorld, calls: watched.calls, asked };
}

/** A row on the board at `status` (`null`: boarded with no Status), open unless it says otherwise; `ready` also labels it so. */
function onBoard(world: FakeRowsWorld, number: number, { status = null, ready = false, ...over }: { status?: string | null; ready?: boolean } & Partial<FakeRow> = {}) {
  world.rows.set(number, fakeRow(world, number, { onBoard: true, boardStatus: status, labels: ready ? ["ready"] : [], ...over }));
}

/** A row that is ready and open but is NOT an item of the project. */
function readyOffBoard(world: FakeRowsWorld, number: number) {
  world.rows.set(number, fakeRow(world, number, { labels: ["ready"] }));
}

/** A board of `pages` pages of items (a page holds 100), every item at Ready. */
function boardOfPages(world: FakeRowsWorld, pages: number) {
  for (let number = 1; number <= (pages - 1) * 100 + 1; number += 1) onBoard(world, number, { status: "Ready" });
}

/** A process that failed as `gh` does: its message, its exit status, and the response body it printed before exiting on `.stdout`. */
const failedProcess = (message: string, stdout?: string) => Object.assign(new Error(message), { status: 1, ...(stdout === undefined ? {} : { stdout }) });

/** One page of a GraphQL response of the items query at the seam: the items node only, for a case that hands the snapshot a text no row renders. */
const seamPage = (extra: Record<string, unknown> = {}, items: unknown = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }) =>
  JSON.stringify({ data: { organization: { projectV2: { items } } }, ...extra });

/** The items read off a board of the one row `number`, at `status`, with the ready list left out. */
function itemsOfOneRow(number: number, title: string, status: string) {
  const { world } = board();
  onBoard(world, number, { title, status });
  return fetchBoardItems({ fetchReady: () => [] });
}

test("fetchBoardItems reads number, title and Status off a single page", () => {
  assert.deepEqual(itemsOfOneRow(42, "the row", "Ready"), [{ itemId: "PVTI_42", number: 42, title: "the row", status: "Ready", state: "OPEN" }]);
});

test("a draft item (no linked issue) is recorded with number/title null, never dropped", () => {
  const { world } = board();
  world.reports.snapshot.drafts = ["PVTI_draft"];
  const items = fetchBoardItems({ fetchReady: () => [] });
  // #1219: `state` is null for a draft too -- a draft has no issue, so it has no state, and defaulting
  // it to OPEN would make every draft an open row the contradiction check then reasons about.
  assert.deepEqual(items, [{ itemId: "PVTI_draft", number: null, title: null, status: null, state: null }]);
});

test("fetchBoardItems follows pagination across multiple pages", () => {
  const { world, asked } = board();
  boardOfPages(world, 2);
  const items = fetchBoardItems({ fetchReady: () => [] });
  assert.equal(items.length, 101);
  assert.deepEqual(items.map((i) => i.number), Array.from({ length: 101 }, (_, i) => i + 1));
  const cursors = asked("boardItemsPageOf").map((call) => call.request.cursor);
  assert.equal(cursors[0], null, "the first page must not pass a cursor");
  assert.equal(typeof cursors[1], "string", "the second page must pass back the first page's endCursor");
  assert.equal(cursors.length, 2);
});

test("fetchBoardItems throws rather than returning a partial list when gh fails", () => {
  const { world } = board();
  onBoard(world, 1, { status: "Ready" });
  world.failures.set("boardItemsPageOf", new Error("gh: not authenticated"));
  assert.throws(() => fetchBoardItems({ fetchReady: () => [] }), /could not read Project/);
});

test("fetchBoardItems throws on a response missing the expected shape, rather than guessing", () => {
  const run = () => JSON.stringify({ data: { organization: { projectV2: null } } });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /did not have the shape/);
});

test("fetchBoardItems throws on a response that is not JSON, quoting what it was, rather than guessing", () => {
  assert.throws(() => fetchBoardItems({ run: () => "<html>502 Bad Gateway</html>", fetchReady: () => [] }), /was not JSON -- refusing to guess\. First 200 chars: <html>502 Bad Gateway/);
});

// --- #555: the refusal must name the GraphQL error, not just "could not read Project N items" ---

test("#555: a non-zero exit whose stdout carries a GraphQL error quotes its type and message", () => {
  // The exact shape measured on the real FORBIDDEN failure that cost #546 three hours: `gh` exits 1, but
  // the response body it printed before exiting still carries the API's own diagnosis.
  const stdout = JSON.stringify({
    errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2"],
      message: "Resource not accessible by personal access token" }],
  });
  const { world } = board();
  world.failures.set("boardItemsPageOf", Object.assign(failedProcess("Command failed: gh api graphql ...", stdout), { stderr: "gh: Resource not accessible by personal access token\n" }));
  assert.throws(() => fetchBoardItems({ fetchReady: () => [] }),
    /FORBIDDEN \(organization\.projectV2\): Resource not accessible by personal access token/);
});

test("#555: a non-zero exit with no parseable GraphQL error falls back to the plain exit message, "
  + "rather than inventing a cause", () => {
  const { world } = board();
  world.failures.set("boardItemsPageOf", new Error("gh: not authenticated"));
  assert.throws(() => fetchBoardItems({ fetchReady: () => [] }), /could not read Project.*not authenticated/s);
});

test("#555 MUTATION TARGET: a 200 response carrying `data` AND `errors` together is REFUSED, never read "
  + "as a complete board -- the exact shape the real probe returned: totalCount correct, every node null", () => {
  // GraphQL's own answer when the token can COUNT an item but not READ it: the request otherwise
  // succeeds (exit 0, `data` present, `pageInfo` well-formed), but the `nodes` list is null exactly
  // where an item should be, and the `errors` array is the only place that says why.
  const run = () => seamPage({
    errors: [
      { type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 0], message: "Resource not accessible by personal access token" },
      { type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 1], message: "Resource not accessible by personal access token" },
      { type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 2], message: "Resource not accessible by personal access token" },
    ],
  }, { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, null, null] });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /FORBIDDEN/);
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /Resource not accessible by personal access token/);
});

test("#555 CONTROL: an ordinary clean response (no errors array at all) is unaffected", () => {
  assert.deepEqual(itemsOfOneRow(1, "fine", "Ready"), [{ itemId: "PVTI_1", number: 1, title: "fine", status: "Ready", state: "OPEN" }]);
});

test("#555: an `errors` array with data still present is refused BEFORE the shape check would even run "
  + "-- so a caller never sees \"did not have the shape\" for a response that actually named its own cause", () => {
  const run = () => seamPage({ errors: [{ type: "SOME_OTHER_TYPE", message: "a different failure entirely" }] });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /SOME_OTHER_TYPE: a different failure entirely/);
});

test("PROJECT_OWNER and PROJECT_NUMBER match the real board (a11y-witness -- what is open, Project 2)", () => {
  assert.equal(PROJECT_OWNER, "a11ign");
  assert.equal(PROJECT_NUMBER, 1);
});

test("snapshotStamp is filesystem-safe -- no colons, and two calls a second apart differ", () => {
  const a = snapshotStamp(new Date("2026-09-08T00:01:02.345Z"));
  assert.doesNotMatch(a, /:/);
  const b = snapshotStamp(new Date("2026-09-08T00:01:03.345Z"));
  assert.notEqual(a, b);
});

test("writeBoardSnapshot fetches, then writes JSON to runs/board-snapshots/<stamp>.json, and returns the path", () => {
  const { world } = board();
  onBoard(world, 42, { title: "row", status: "Ready" });
  const written: Array<{ path: string; data: string }> = [];
  const mkdirs: string[] = [];
  const path = writeBoardSnapshot({
    fetchReady: () => [],
    mkdir: (p) => mkdirs.push(p),
    writeFile: (p, data) => written.push({ path: p, data }),
    now: () => new Date("2026-09-08T00:01:02.000Z"),
  });
  assert.equal(path, `${SNAPSHOT_DIR}/2026-09-08T00-01-02-000Z.json`);
  assert.deepEqual(mkdirs, [SNAPSHOT_DIR]);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, path);
  const parsed = JSON.parse(written[0].data);
  assert.equal(parsed.project.owner, PROJECT_OWNER);
  assert.equal(parsed.project.number, PROJECT_NUMBER);
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_42", number: 42, title: "row", status: "Ready", state: "OPEN" }]);
});

test("writeBoardSnapshot throws, never swallows, when the fetch fails", () => {
  const { world } = board();
  world.failures.set("boardItemsPageOf", new Error("network unreachable"));
  assert.throws(() => writeBoardSnapshot({ fetchReady: () => [], mkdir: () => {}, writeFile: () => {} }),
    /could not read Project/);
});

/**
 * MUTATION-EQUIVALENT, run directly rather than through `npm run mutate`: a failing snapshot write must
 * refuse the mutation outright. This is the whole guarantee `withBoardSnapshot` exists to give.
 */
test("MUTATION: a failing snapshot write means the mutation never runs", () => {
  const { world } = board();
  onBoard(world, 1, { title: "row" });
  let mutateCalled = false;
  assert.throws(() => withBoardSnapshot(() => { mutateCalled = true; return "ok"; }, {
    fetchReady: () => [],
    mkdir: () => {},
    writeFile: () => { throw new Error("disk full"); },
  }), /could not write the snapshot/);
  assert.equal(mutateCalled, false, "the mutation must never run when the snapshot did not write");
});

test("withBoardSnapshot calls the mutation, and only after logging the snapshot path, when the snapshot succeeds", () => {
  const { world } = board();
  onBoard(world, 1, { title: "row" });
  const log: string[] = [];
  let mutateCalled = false;
  const result = withBoardSnapshot(() => {
    mutateCalled = true;
    return "mutation result";
  }, {
    fetchReady: () => [],
    mkdir: () => {},
    writeFile: () => {},
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    log: (line) => log.push(line),
  });
  assert.equal(mutateCalled, true);
  assert.equal(result, "mutation result");
  assert.equal(log.length, 1);
  // #1352: the path is ABSOLUTE now -- the primary checkout's runs/board-snapshots, whatever tree ran this -- so the line
  // is matched against the exported directory rather than a relative literal.
  const escaped = SNAPSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(log[0], new RegExp(`wrote ${escaped}/2026-09-08T00-00-00-000Z\\.json before mutating`));
});


// --- #747: fieldValues is nested inside items, the one shape with no totalCount to check itself. An
// independently-derived floor -- every open `ready` issue must show up in the snapshot WITH a Status --
// catches a narrowed read that every assertion available inside the response itself would pass. ---

// #2157: THE POSITIVE CONTROL FOR EVERY EMPTINESS BELOW. Both halves of the return are `[]` here and
// nowhere else in this block, so a mutant that returned two empty lists unconditionally would pass THIS
// test and fail every other one in the group -- which is the direction that matters, since the group is
// otherwise all emptiness assertions.
test("readyRowsMissingStatus: a ready row with a Status is reported under NEITHER cause", () => {
  const items = [{ itemId: "PVTI_1", number: 725, title: "row", status: "Ready", state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), { absentFromItems: [], boardedWithoutStatus: [] });
});

// #2157: THE TWO LINES THE ROW'S OPEN-CHECK RAN. They were `[725]` and `[725]` -- identical answers to
// two inputs that differ in exactly the way the refusal one level up was asserting about. The pair is
// kept adjacent on purpose: separately each reads as an ordinary pin, and it is their AGREEMENT that was
// the defect.
test("readyRowsMissingStatus: a ready row present but with a null Status is `boardedWithoutStatus` -- "
  + "the exact shape a narrowed fieldValues read produces, and the ONLY shape #747 describes", () => {
  const items = [{ itemId: "PVTI_1", number: 725, title: "row", status: null, state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), { absentFromItems: [], boardedWithoutStatus: [725] });
});

test("readyRowsMissingStatus: a ready row absent from the snapshot entirely is `absentFromItems`, NOT "
  + "`boardedWithoutStatus` -- it is not evidence about fieldValues at all", () => {
  assert.deepEqual(readyRowsMissingStatus([], [725]), { absentFromItems: [725], boardedWithoutStatus: [] });
});

test("readyRowsMissingStatus: draft items (number null) never match a ready issue number and are "
  + "ignored rather than crashing the lookup", () => {
  // #1219: `state: null` -- a draft has no issue, so it has no state. `tsc` caught this, the same way
  // it catches a partial fixture typechecking as the real thing.
  const items = [{ itemId: "PVTI_draft", number: null, title: null, status: null, state: null }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), { absentFromItems: [725], boardedWithoutStatus: [] });
});

test("readyRowsMissingStatus: an empty ready population always passes -- nothing to check", () => {
  assert.deepEqual(readyRowsMissingStatus([{ itemId: "x", number: 1, title: "t", status: null, state: "OPEN" }], []),
    { absentFromItems: [], boardedWithoutStatus: [] });
});

test("readyRowsMissingStatus: both causes at once come back separated, not merged into one list", () => {
  const items = [{ itemId: "PVTI_1", number: 717, title: "boarded", status: null, state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [717, 725]),
    { absentFromItems: [725], boardedWithoutStatus: [717] });
});

// --- #2157: the discriminator, pure of `gh`. `classifyAbsentReadyRows` decides "off the board" from
// "this query has not enumerated it yet" with the per-issue read #1275 already makes; `missingStatusRefusal`
// builds the sentence. Both are driven by fixtures because the sentence IS the finding: `ready-label-audit`
// prints it verbatim after `COULD NOT AUDIT board membership:`, and on 2026-09-23 what it printed there
// told the reader the board was fine over three rows that were not on it. ---

const NO_REQUEST = () => { throw new Error("the discriminating read must not be made"); };

test("#2157: classifyAbsentReadyRows makes NO request for an empty absent list -- the positive control "
  + "for the two emptiness assertions below is every other case in this group", () => {
  assert.deepEqual(classifyAbsentReadyRows([], { request: NO_REQUEST, readTouched: NO_REQUEST }),
    { offBoard: [], boardedButNotEnumerated: [], undecided: [], undecidedReason: null });
});

test("#2157: a row GitHub reports no Project item for is `offBoard` -- the board is wrong", () => {
  assert.deepEqual(classifyAbsentReadyRows([2093], { request: NO_REQUEST, readTouched: touchedOnBoard([]) }),
    { offBoard: [2093], boardedButNotEnumerated: [], undecided: [], undecidedReason: null });
});

test("#2157: a row GitHub DOES report an item for is `boardedButNotEnumerated` -- this read is short", () => {
  assert.deepEqual(classifyAbsentReadyRows([2093], { request: NO_REQUEST, readTouched: touchedOnBoard([2093]) }),
    { offBoard: [], boardedButNotEnumerated: [2093], undecided: [], undecidedReason: null });
});

test("#2157: both at once are split, in the order they were asked about -- the live hour had one of each", () => {
  assert.deepEqual(
    classifyAbsentReadyRows([2093, 2155], { request: NO_REQUEST, readTouched: touchedOnBoard([2155]) }),
    { offBoard: [2093], boardedButNotEnumerated: [2155], undecided: [], undecidedReason: null });
});

test("#2157: a refused per-issue read makes every absent row `undecided`, carrying the read's own "
  + "refusal -- never silently one arm, and never a pass", () => {
  const readTouched = () => { throw new Error("FORBIDDEN: Resource not accessible by personal access token"); };
  assert.deepEqual(classifyAbsentReadyRows([2093, 2155], { request: NO_REQUEST, readTouched }), {
    offBoard: [], boardedButNotEnumerated: [], undecided: [2093, 2155],
    undecidedReason: "FORBIDDEN: Resource not accessible by personal access token",
  });
});

test("#2157: classifyAbsentReadyRows hands its `request` to the read rather than building its own", () => {
  const request = (args: string[]) => JSON.stringify(args);
  let seen: unknown = null;
  classifyAbsentReadyRows([2093], { request, readTouched: (ns, deps) => { seen = deps.request; return touchedOnBoard([])(ns); } });
  assert.equal(seen, request);
});

test("#2157: missingStatusRefusal is null when every ready row is accounted for -- and NOTHING ELSE in "
  + "this group returns null, which is what makes that assertion mean something", () => {
  assert.equal(missingStatusRefusal({
    offBoard: [], boardedButNotEnumerated: [], boardedWithoutStatus: [], undecided: [], undecidedReason: null,
  }), null);
});

test("#2157: missingStatusRefusal counts every cause in its total and names each cause it found, and "
  + "only those", () => {
  const refusal = missingStatusRefusal({
    offBoard: [2093, 2092], boardedButNotEnumerated: [2155], boardedWithoutStatus: [725],
    undecided: [], undecidedReason: null,
  });
  assert.match(String(refusal), /4 open ready row\(s\) are not accounted for/);
  assert.match(String(refusal), /OFF THE BOARD -- THE BOARD IS WRONG, NOT THIS READ: #2093, #2092/);
  assert.match(String(refusal), /NOT YET IN THIS QUERY'S PAGES -- THE READ IS SHORT: #2155/);
  assert.match(String(refusal), /IN THIS READ WITH NO STATUS -- THE READ IS SHORT: #725/);
  assert.doesNotMatch(String(refusal), /CANNOT TELL/);
});

test("#2157: the OFF THE BOARD arm alone never prints either short-read sentence -- the defect was one "
  + "sentence printed over three populations, so each line must be absent when its cause is", () => {
  const refusal = String(missingStatusRefusal({
    offBoard: [2093], boardedButNotEnumerated: [], boardedWithoutStatus: [], undecided: [], undecidedReason: null,
  }));
  assert.match(refusal, /1 open ready row\(s\) are not accounted for/);
  assert.doesNotMatch(refusal, /THE READ IS SHORT/);
  assert.doesNotMatch(refusal, /fieldValues has no totalCount/);
  assert.doesNotMatch(refusal, /CANNOT TELL/);
});

test("#2157: the #747 arm alone still cites #747 and still refuses -- this row separates the causes, it "
  + "does not relax the floor", () => {
  const refusal = String(missingStatusRefusal({
    offBoard: [], boardedButNotEnumerated: [], boardedWithoutStatus: [725], undecided: [], undecidedReason: null,
  }));
  assert.match(refusal, /refusing to report it as complete/);
  assert.match(refusal, /#747: fieldValues has no totalCount to check itself/);
  assert.doesNotMatch(refusal, /OFF THE BOARD/);
});

test("#2157: the CANNOT TELL arm carries the refusal that caused it, so a reader can act on the reason "
  + "rather than on the fact that something went wrong", () => {
  const refusal = String(missingStatusRefusal({
    offBoard: [], boardedButNotEnumerated: [], boardedWithoutStatus: [], undecided: [2093],
    undecidedReason: "FORBIDDEN: Resource not accessible by personal access token",
  }));
  assert.match(refusal, /CANNOT TELL off-board from short-read: #2093/);
  assert.match(refusal, /FORBIDDEN: Resource not accessible by personal access token/);
});

test("fetchReadyIssueNumbers: asks for the OPEN rows labelled ready, the number only, and answers theirs -- not the closed ones, not the unlabelled (#5076)", () => {
  const { world, asked } = board();
  onBoard(world, 717, { ready: true });
  onBoard(world, 725, { ready: true });
  world.rows.set(700, fakeRow(world, 700, { state: "CLOSED", labels: ["ready"] }));
  world.rows.set(701, fakeRow(world, 701, { labels: ["backlog"] }));
  assert.deepEqual(fetchReadyIssueNumbers().sort((a, b) => a - b), [717, 725]);
  assert.equal(asked("readRowsByLabel").length, 1, "one read of the by-label connection");
  const { request } = asked("readRowsByLabel")[0];
  assert.deepEqual({ label: request.label, state: request.state, select: request.select, repo: request.repo }, { label: "ready", state: "OPEN", select: "number", repo: REPO },
    "the connection's own query is the plugin's (board-snapshot-rows.test.ts): never a `--label` search, and the one field read is the number");
});

test("fetchReadyIssueNumbers: exactly `limit` rows back is refused as indistinguishable from truncated, "
  + "same discipline as ready-label-audit.ts's fetchIssues", () => {
  const { world } = board();
  for (const number of [1, 2, 3]) readyOffBoard(world, number);
  assert.throws(() => fetchReadyIssueNumbers({ limit: 3 }), /exactly the requested limit/);
  assert.deepEqual(fetchReadyIssueNumbers({ limit: 4 }).sort(), [1, 2, 3], "control: one under the limit is a complete read");
});

test("fetchReadyIssueNumbers: a response that is not a connection is refused rather than guessed at", () => {
  const run = () => JSON.stringify({ not: "a list" });
  assert.throws(() => fetchReadyIssueNumbers({ run }), /could not list open ready issues[\s\S]*did not come back as a connection/);
});

test("fetchReadyIssueNumbers: gh failing throws, never falls back to an empty (falsely clean) "
  + "population", () => {
  const { world } = board();
  readyOffBoard(world, 1);
  world.failures.set("readRowsByLabel", new Error("gh: not authenticated"));
  assert.throws(() => fetchReadyIssueNumbers(), /could not list open ready issues[\s\S]*not authenticated/);
});

/**
 * #2157: a `readTouched` that answers the per-issue read from a list of issue numbers GitHub reports as
 * items on this Project. It stands in for the per-issue read in the CLASSIFIER's own cases above, which are pure of
 * the code host; the cases below run the real read over the fake's world, where the two arms are driven by the world's
 * facts (a row off the board; a row on it that the items connection has not enumerated yet) -- they disagree in the live
 * defect, and a fixture where they agree would pin neither.
 */
function touchedOnBoard(onBoard: number[]) {
  return (issueNumbers: number[]) => ({
    items: issueNumbers.filter((n) => onBoard.includes(n)).map((n) => ({
      itemId: `PVTI_touched_${n}`, number: n, title: `row ${n}`, status: "Ready", state: "OPEN",
    })),
    notOnBoard: issueNumbers.filter((n) => !onBoard.includes(n)),
  });
}

test("fetchBoardItems: every ready row carries a Status -- passes unchanged, same as today's 203 items", () => {
  const { world } = board();
  onBoard(world, 725, { title: "row", status: "Ready", ready: true });
  const items = fetchBoardItems();
  assert.deepEqual(items, [{ itemId: "PVTI_725", number: 725, title: "row", status: "Ready", state: "OPEN" }]);
});

test("#2157: a clean board makes NO discriminating per-issue read -- the extra call is on the refusal "
  + "path only, so a snapshot that accounts for every ready row costs exactly the calls it always did", () => {
  const { world, asked } = board();
  onBoard(world, 725, { title: "row", status: "Ready", ready: true });
  fetchBoardItems();
  assert.equal(asked("touchedItemTextOf").length, 0);
  assert.equal(asked("boardItemsPageOf").length, 1);
  assert.equal(asked("readRowsByLabel").length, 1);
});

test("#747 ACCEPTANCE, MUTATION TARGET: a ready row's fieldValues dropped (the narrowed-connection "
  + "shape) makes fetchBoardItems REFUSE and NAME it, rather than returning it with no Status", () => {
  // #725 is `ready` and on the board, but its fieldValues came back empty -- exactly what a shared-budget
  // narrowing produces, and what today's response with no totalCount on fieldValues cannot itself catch.
  const { world } = board();
  onBoard(world, 725, { title: "row", status: null, ready: true });
  assert.throws(() => fetchBoardItems(), /1 open ready row\(s\) are not accounted for/);
  assert.throws(() => fetchBoardItems(), /IN THIS READ WITH NO STATUS[\s\S]*#725/);
  // #2157: and it is NOT reported as off the board -- the item WAS in the page, only its Status was not.
  assert.throws(() => fetchBoardItems(), (error: Error) => {
    assert.doesNotMatch(error.message, /OFF THE BOARD/);
    return true;
  });
});

test("fetchBoardItems: a ready row missing from the board entirely is also refused and named", () => {
  const { world } = board();
  onBoard(world, 1, { title: "unrelated", status: "Ready" });
  readyOffBoard(world, 725);
  assert.throws(() => fetchBoardItems(), /#725/);
});

// --- #2157, measured 2026-09-23: a row absent from the items connection is one of TWO unrelated things,
// and the refusal asserted the second over both. #2093, #2092 and #2094 were open with no project item at
// all while the message said "not the board being wrong"; #2093 once boarded took ~25 minutes to appear in
// this query's own pagination although its per-issue read returned it at once. ---

test("#2157 ACCEPTANCE, MUTATION TARGET: a ready row with NO item on the Project is refused as OFF THE "
  + "BOARD, and the refusal does NOT tell the reader the board is fine", () => {
  const { world } = board();
  onBoard(world, 1, { title: "unrelated", status: "Ready" });
  readyOffBoard(world, 2093);
  assert.throws(() => fetchBoardItems(), (error: Error) => {
    assert.match(error.message, /OFF THE BOARD -- THE BOARD IS WRONG, NOT THIS READ: #2093/);
    // The sentence the live refusal printed over exactly this row. It must not survive on this arm.
    assert.doesNotMatch(error.message, /not the board being wrong/);
    assert.doesNotMatch(error.message, /NOT YET IN THIS QUERY'S PAGES/);
    return true;
  });
});

test("#2157: a ready row the per-issue read DOES find on the Project is refused as a SHORT READ of the "
  + "pagination -- same input to this function, opposite verdict, decided by the world's facts", () => {
  const { world } = board();
  onBoard(world, 1, { title: "unrelated", status: "Ready" });
  onBoard(world, 2093, { status: "Ready", ready: true });
  world.reports.snapshot.notEnumerated = [2093];
  assert.throws(() => fetchBoardItems(), (error: Error) => {
    assert.match(error.message, /NOT YET IN THIS QUERY'S PAGES -- THE READ IS SHORT: #2093/);
    assert.doesNotMatch(error.message, /OFF THE BOARD/);
    return true;
  });
  world.reports.snapshot.notEnumerated = [];
  assert.equal(fetchBoardItems().length, 2, "CONTROL: once the connection enumerates it, the same world is a complete snapshot");
});

test("#2157: the discriminating read is asked ONLY about the rows absent from the items connection -- "
  + "not about the ready rows the page already accounted for", () => {
  const { world, asked } = board();
  onBoard(world, 717, { title: "boarded, no Status", ready: true });
  onBoard(world, 718, { title: "boarded, with Status", status: "Ready", ready: true });
  readyOffBoard(world, 2093);
  assert.throws(() => fetchBoardItems(), /#2093/);
  assert.deepEqual(asked("touchedItemTextOf").map((call) => call.request.issue), [2093]);
});

testEach("#2157: a refused discriminating read is CANNOT TELL, loudly -- the floor still refuses, the rows are still named, and neither arm is asserted on the strength of a read that did not happen", [
  { name: "the refusal is named CANNOT TELL", expect: "match", pattern: /CANNOT TELL off-board from short-read: #2093/ },
  { name: "the read's own refusal is carried", expect: "match", pattern: /FORBIDDEN/ },
  { name: "no off-the-board arm", expect: "doesNotMatch", pattern: /OFF THE BOARD/ },
  { name: "no short-read arm", expect: "doesNotMatch", pattern: /NOT YET IN THIS QUERY'S PAGES/ },
] as const, (c) => {
  const { world } = board();
  onBoard(world, 1, { title: "unrelated", status: "Ready" });
  readyOffBoard(world, 2093);
  world.failures.set("touchedItemTextOf", failedProcess("Command failed: gh api graphql",
    JSON.stringify({ errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2"], message: "Resource not accessible by personal access token" }] })));
  assert.throws(() => fetchBoardItems(), (error: Error) => {
    assert[c.expect](error.message, c.pattern);
    return true;
  });
});

test("fetchBoardItems: two ready rows both missing Status are both named", () => {
  const { world } = board();
  for (const number of [717, 718]) onBoard(world, number, { title: `row ${number}`, ready: true });
  assert.throws(() => fetchBoardItems(), (error: Error) => {
    assert.match(error.message, /2 open ready row\(s\) are not accounted for/);
    for (const number of [717, 718]) assert.match(error.message, new RegExp(`#${number}\\b`));
    return true;
  });
});

test("fetchBoardItems: an empty ready population (fetchReady: () => []) skips the check entirely -- "
  + "every pre-#747 test in this file uses exactly this to isolate the pagination/error-handling behaviour "
  + "they actually test", () => {
  const { world } = board();
  onBoard(world, 1, { title: "row" });
  const items = fetchBoardItems({ fetchReady: () => [] });
  assert.equal(items.length, 1);
});


// --- #891, live 2026-09-09: a row freshly `gh project item-add`-ed, ready-labelled (a real `gh issue
// create -l ready`, not row-file's own later `--ready` sentinel), with no Status yet, tripped the #747
// floor ON ITSELF -- moveProjectStatus's own pre-write snapshot refused the very call meant to fix it.
// `excludeIssueNumber` lets the caller name the ONE row currently being boarded so the floor stops
// treating "about to be fixed" the same as "silently neglected", without blinding it to any other row. ---

test("readyRowsMissingStatus: excludeIssueNumber removes exactly that row from the report, even though "
  + "it is genuinely ready with no Status -- the #891 self-trip shape", () => {
  assert.deepEqual(readyRowsMissingStatus([], [891], 891), { absentFromItems: [], boardedWithoutStatus: [] });
});

test("readyRowsMissingStatus: excludeIssueNumber does not blind the floor to a DIFFERENT ready row "
  + "missing its Status -- only the named row is exempt", () => {
  const items = [{ itemId: "PVTI_1", number: 717, title: "unrelated", status: null, state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [717, 891], 891),
    { absentFromItems: [], boardedWithoutStatus: [717] });
});

test("readyRowsMissingStatus: excludeIssueNumber defaults to null, excluding nothing -- every existing "
  + "caller (a plain snapshot, an audit) sees every row honestly", () => {
  assert.deepEqual(readyRowsMissingStatus([], [725]), { absentFromItems: [725], boardedWithoutStatus: [] });
});

test("fetchBoardItems: excludeIssueNumber threaded through end-to-end reproduces the #891 fix -- a "
  + "freshly boarded, ready-labelled, Status-less row does NOT refuse when it is the excluded row", () => {
  const { world } = board();
  onBoard(world, 891, { title: "row", ready: true });
  const items = fetchBoardItems({ excludeIssueNumber: 891 });
  assert.deepEqual(items, [{ itemId: "PVTI_891", number: 891, title: "row", status: null, state: "OPEN" }]);
});

test("fetchBoardItems, MUTATION TARGET: excludeIssueNumber naming the WRONG row still refuses -- proving "
  + "the exclusion is by number, not a blanket bypass of the floor", () => {
  const { world } = board();
  onBoard(world, 891, { title: "row", ready: true });
  assert.throws(() => fetchBoardItems({ excludeIssueNumber: 1 }), /#891/);
});

// --- #852: ONE SWEEP PER PROCESS ----------------------------------------------------------------
//
// Every Status move swept the whole board first: `moveProjectStatus` wraps a single-field edit in
// `withBoardSnapshot`, and the page count grows with the board, so every row added made every future
// claim more expensive. Measured on this branch against a 3-page board:
//
//   before   1 move -> 3 pages   3 moves -> 9 pages    20 moves -> 60 pages
//   after    1 move -> 3 pages   3 moves -> 3 pages    20 moves -> 3 pages
//
// THE ASSERTIONS ARE ON THE CALLS, not on anything the result contains, because the result is identical
// either way — which is the reason nobody noticed for four days.

/** A board of `pages` pages on the fake code host, and a count of the pages of it the snapshot has read. */
function boardOf(pages: number) {
  const fake = board();
  boardOfPages(fake.world, pages);
  return { ...fake, boardPages: () => fake.asked("boardItemsPageOf").length };
}

// `exists` is stubbed TRUE here because `writeFile` is stubbed to drop the file: with the real
// `existsSync`, a snapshot these tests never actually wrote would read as deleted and every reuse would
// fall through to a fresh sweep. The disk check has its own test below, with its own in-memory disk.
const quiet = { fetchReady: () => [], mkdir: () => {}, writeFile: () => {}, log: () => {},
  exists: () => true };

/** Forgets the process's record, then runs one board mutation through `withBoardSnapshot`: the sweep it pays is what a test counts. */
function sweepOnce(io: Partial<typeof quiet>) {
  forgetProcessSnapshot();
  withBoardSnapshot(() => {}, { ...io });
}

test("#852: N board mutations in one process cost ONE sweep, not N", () => {
  forgetProcessSnapshot();
  const fake = boardOf(3);
  let mutations = 0;
  const N = 20;
  for (let i = 0; i < N; i += 1) {
    withBoardSnapshot(() => { mutations += 1; }, { ...quiet });
  }
  assert.equal(mutations, N, "every mutation must still run -- this is a cost fix, not a skip");
  assert.equal(fake.boardPages(), 3,
    `${N} mutations must cost one 3-page sweep. Before #852 this was ${N * 3} pages, and the page count `
    + "grows with the board, so the old cost rose every time a row was filed");
});

test("#852 POSITIVE CONTROL: a fresh process still sweeps, so the reuse is not a skip", () => {
  // Without this, "0 pages" would satisfy the test above perfectly — including for an implementation
  // that never snapshots at all, which is #399's guarantee deleted rather than made cheaper.
  const fake = boardOf(3);
  sweepOnce(quiet);
  assert.equal(fake.boardPages(), 3, "the FIRST mutation of a process must pay for a real sweep");
});

test("#852: the reuse EXPIRES, so the record is never more than the bound older than the change", () => {
  forgetProcessSnapshot();
  const fake = boardOf(1);
  const start = new Date("2026-09-13T12:00:00.000Z");
  const at = (ms: number) => new Date(start.getTime() + ms);
  withBoardSnapshot(() => {}, { ...quiet, now: () => start });
  withBoardSnapshot(() => {}, { ...quiet, now: () => at(SNAPSHOT_MAX_AGE_MS - 1000) });
  assert.equal(fake.boardPages(), 1, "inside the bound, the existing snapshot still describes the board");
  withBoardSnapshot(() => {}, { ...quiet, now: () => at(SNAPSHOT_MAX_AGE_MS + 1000) });
  assert.equal(fake.boardPages(), 2,
    "past the bound a fresh sweep is taken -- the trade is a snapshot slightly older than the mutation "
    + "it covers, and the bound is what keeps that sayable rather than unbounded");
});

test("#852: the snapshot FILE says it describes the board before the FIRST mutation", () => {
  // A reader who finds a snapshot next to a mutation will otherwise assume the stronger guarantee —
  // "the board immediately before THIS change" — which is exactly what it no longer is.
  forgetProcessSnapshot();
  boardOf(1);
  const written: string[] = [];
  withBoardSnapshot(() => {}, { ...quiet, writeFile: (_p, data) => written.push(data) });
  const parsed = JSON.parse(written[0]);
  assert.match(parsed.takenBefore, /first board mutation of this process/);
  assert.match(parsed.takenBefore, /reuse this snapshot/,
    "and it must say WHY it is not per-mutation, not merely that it is not");
});

test("#852: a REUSED snapshot is re-read from disk, so a deleted one does not license a mutation", () => {
  // worker-judge's blocker on #1281, driven there before it was fixed here: the snapshot was written,
  // `rm -rf runs/` took it, and the NEXT mutation proceeded with nothing behind it. `runs/` is gitignored
  // so `git clean -xdf` removes it too. Without the disk check, #399's guarantee holds at SWEEP time and
  // not at MUTATION time -- true of a process's first mutation and false of every reused one.
  forgetProcessSnapshot();
  const fake = boardOf(1);
  const onDisk = new Set<string>();
  const deps = { ...quiet,
    writeFile: (p: string) => onDisk.add(p),
    exists: (p: string) => onDisk.has(p) };

  withBoardSnapshot(() => {}, deps);
  assert.equal(fake.boardPages(), 1, "the first mutation sweeps");
  withBoardSnapshot(() => {}, deps);
  assert.equal(fake.boardPages(), 1, "the second reuses it, because it is still there");

  onDisk.clear(); // `rm -rf runs/`
  let ranWithNothingBehindIt = false;
  withBoardSnapshot(() => { ranWithNothingBehindIt = true; }, deps);
  assert.equal(fake.boardPages(), 2,
    "the snapshot is gone, so the next mutation takes a FRESH sweep rather than trusting a remembered path");
  assert.equal(ranWithNothingBehindIt, true, "and it still runs -- with a real snapshot behind it again");
});

test("#852: #399's guarantee is untouched -- a failed write still means the mutation never runs", () => {
  // The cost fix must not weaken the reason the sweep exists. A snapshot that cannot be written is still
  // a refusal, not a warning, on the first mutation of a process.
  forgetProcessSnapshot();
  boardOf(1);
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; },
    { ...quiet, writeFile: () => { throw new Error("read-only filesystem"); } }),
  /refusing to proceed/);
  assert.equal(ran, false, "mutate must never be reached when the snapshot could not be written");
});

// --- #1275: THE WRAPPER'S ROUTE, WHICH ONLY THIS FILE CAN SHOW -------------------------------------------------
//
// The scoped snapshot itself -- its request, parsing, refusals, file and reuse -- is tested in
// board-snapshot-scope.test.ts, which imports nothing from this file so CI's acceptance job can run it. What stays
// here is the part that needs the wrapper: which reads of the code host `withBoardSnapshot` actually makes.

/** A board of `pages` pages on the fake code host: the operations the snapshot asked of it, by name; and a count of the board pages and the ready lists. */
function recordingBoard(pages: number) {
  const fake = board();
  boardOfPages(fake.world, pages);
  return { ...fake, boardPages: () => fake.asked("boardItemsPageOf").length, readyLists: () => fake.asked("readRowsByLabel").length };
}

// `exists` is stubbed TRUE because `writeFile` is stubbed to drop the file -- see `quiet` above.
const quietIO = { mkdir: () => {}, writeFile: () => {}, log: () => {}, exists: () => true };

test("#1275 WIRING: a mutation that names its item makes ONE read, the scoped one -- no board page, no ready list", () => {
  forgetProcessSnapshot();
  const fake = recordingBoard(6);
  fake.world.failures.set("touchedItemTextOf", new Error("the touched read is refused"));
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, touches: 725 }),
    /could not read Project 1's item for #725/);
  assert.deepEqual(fake.calls.map((call) => ({ op: call.op, owner: call.request.owner, repo: call.request.repo, project: call.request.project, issue: call.request.issue })),
    [{ op: "touchedItemTextOf", owner: PROJECT_OWNER, repo: REPO, project: PROJECT_NUMBER, issue: 725 }],
    "exactly one read of the code host, the item of #725 on the project -- the read the pure half leaves to this file");
  assert.equal(ran, false, "and a refused read still means no mutation (#399)");
});

test("#1275: the same wrapper with no `touches` still sweeps the board -- what every one-item move paid before", () => {
  const fake = recordingBoard(6);
  sweepOnce(quietIO);
  assert.equal(fake.boardPages(), 6, "six pages of 100 at today's 555 items -- and one more per hundred rows filed");
  assert.equal(fake.readyLists(), 1, "plus #747's ready-issue list, which is a GraphQL connection read too");
});

test("#1275: a FULL snapshot this process already holds covers a scoped move, with no further read (#852)", () => {
  forgetProcessSnapshot();
  const fake = recordingBoard(2);
  withBoardSnapshot(() => {}, { ...quietIO, fetchReady: () => [] });
  const callsAfterTheSweep = fake.calls.length;
  let ran = false;
  withBoardSnapshot(() => { ran = true; }, { ...quietIO, touches: 725 });
  assert.equal(fake.calls.length, callsAfterTheSweep, "the board already covers the item");
  assert.equal(ran, true);
});

test("#1275: `touches` that names no issue refuses in the wrapper before the code host is asked anything", () => {
  forgetProcessSnapshot();
  const fake = recordingBoard(1);
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, touches: [] as number[] }),
    /`touches` must name the issue\(s\) this mutation changes/);
  assert.equal(ran, false);
  assert.equal(fake.calls.length, 0);
});

// --- #1425: the FULL route honours the same once-per-process record ---------------------------------------------------
//
// A mutation that names no item takes the full sweep. Against a Project the token cannot read, that sweep's first
// page is refused, and before #1425 every later mutation in the process asked again. The record lives in the scoped
// module, so both routes share one answer.

/** A board whose page read fails every time as CI's token does against Project 2 (#546), or with `stdout` when one is given. */
function refusingBoard(message: string, stdout?: string) {
  const fake = board();
  fake.world.failures.set("boardItemsPageOf", failedProcess(message, stdout));
  return { ...fake, requests: () => fake.asked("boardItemsPageOf").length };
}

const PROJECT_2_NOT_FOUND = JSON.stringify({ data: { organization: { projectV2: null } }, errors: [{ type: "NOT_FOUND",
  path: ["organization", "projectV2"], message: `Could not resolve to a ProjectV2 with the number ${PROJECT_NUMBER}.` }] });

test("#1425: 7 full-route mutations against an unreadable Project make ONE request, and none mutates", () => {
  forgetProcessSnapshot();
  const fake = refusingBoard("Command failed: gh api graphql", PROJECT_2_NOT_FOUND);
  let mutations = 0;
  const messages: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    try {
      withBoardSnapshot(() => { mutations += 1; }, { ...quiet });
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  assert.equal(fake.requests(), 1, "the first sweep's refusal is recorded, and the other six refuse from it");
  assert.equal(mutations, 0);
  assert.equal(messages.length, 7);
  for (const message of messages) {
    assert.match(message, /NOT_FOUND \(organization\.projectV2\): Could not resolve to a ProjectV2 with the number 1/);
  }
  forgetProcessSnapshot();
});

test("#1425 CONTROL: a full-route failure that is NOT project-unreadable is read again on every mutation", () => {
  forgetProcessSnapshot();
  const fake = refusingBoard("Command failed: gh api graphql\nerror connecting to api.github.com");
  for (let i = 0; i < 3; i += 1) {
    assert.throws(() => withBoardSnapshot(() => {}, { ...quiet }), /could not read Project/);
  }
  assert.equal(fake.requests(), 3);
  forgetProcessSnapshot();
});


// --- #1352: ONE snapshot directory from every worktree, and policy scripts refuse outside a linked worktree -----------

/** A filesystem of `dirs` and `files` (path -> text), in the shapes git writes, for `commonGitDirOf` and the refusal. */
function fakeGitFs({ dirs = [] as string[], files = {} as Record<string, string> }) {
  return {
    exists: (path: string) => dirs.includes(path) || path in files,
    isDirectory: (path: string) => dirs.includes(path),
    read: (path: string) => { if (!(path in files)) throw new Error(`ENOENT ${path}`); return files[path]; },
  };
}

/** The primary at /repo, and two linked worktrees made by `git worktree add`. */
const REPO_WITH_WORKTREES = fakeGitFs({
  dirs: ["/repo/.git"],
  files: {
    "/wts/wt-a/.git": "gitdir: /repo/.git/worktrees/wt-a\n", "/repo/.git/worktrees/wt-a/commondir": "../..\n",
    "/wts/wt-b/.git": "gitdir: /repo/.git/worktrees/wt-b\n", "/repo/.git/worktrees/wt-b/commondir": "../..\n",
  },
});

test("#1352 DONE-WHEN 2: the snapshot directory is IDENTICAL from two different worktrees, and it is the primary's", () => {
  const fromA = snapshotDirFor("/wts/wt-a", REPO_WITH_WORKTREES);
  const fromB = snapshotDirFor("/wts/wt-b", REPO_WITH_WORKTREES);
  assert.equal(fromA, "/repo/runs/board-snapshots");
  assert.equal(fromB, fromA);
  assert.equal(snapshotDirFor("/repo", REPO_WITH_WORKTREES), fromA, "and the primary resolves to the same place");
  assert.equal(commonGitDirOf("/wts/wt-a", REPO_WITH_WORKTREES), "/repo/.git");
});

test("#1352: a relative gitdir resolves against the worktree, a gitdir with no commondir is its own, and no .git is the root", () => {
  const fs = fakeGitFs({ files: { "/wts/rel/.git": "gitdir: ../../repo/.git/worktrees/rel\n", "/repo/.git/worktrees/rel/commondir": "../..\n",
    "/wts/lone/.git": "gitdir: /elsewhere/gitdir\n" } });
  assert.equal(commonGitDirOf("/wts/rel", fs), "/repo/.git");
  assert.equal(commonGitDirOf("/wts/lone", fs), "/elsewhere/gitdir");
  assert.equal(commonGitDirOf("/nowhere", fs), null);
  assert.equal(snapshotDirFor("/nowhere", fs), "/nowhere/runs/board-snapshots");
});

test("#1352: the REAL SNAPSHOT_DIR is the git common dir's checkout plus runs/board-snapshots -- asked of git itself", () => {
  // SNAPSHOT_DIR is derived from the project's checkout, so git is asked about that checkout.
  const common = execFileSync("git", ["-C", HOME_CHECKOUT, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", env: sandboxGitEnv() }).trim();
  assert.equal(SNAPSHOT_DIR, joinPath(dirOf(common), "runs", "board-snapshots"),
    "a second derivation: git's own answer, not this module's reading of git's files");
  assert.ok(SNAPSHOT_DIR.startsWith("/"), "absolute, so it cannot depend on where a script was launched");
});

test("#1352: the refusal fires in a checkout whose .git is a directory, and names the mark only when it is set", () => {
  const unmarked = fakeGitFs({ dirs: ["/clone/.git", "/clone/sub"], files: { "/clone/.git/config": "[core]\n\tbare = false\n" } });
  const refusal = primaryLaunchRefusal("row-claim", { cwd: "/clone/sub", fs: unmarked });
  assert.match(refusal ?? "", /^row-claim: REFUSED -- launched from \/clone, which is not a linked worktree: its \.git is a directory\. /);
  assert.match(refusal ?? "", /Nothing was read or written/);
  assert.doesNotMatch(refusal ?? "", new RegExp(PRIMARY_MARK_KEY));
  const marked = fakeGitFs({ dirs: ["/repo/.git"], files: { "/repo/.git/config": "[core]\n[A11y]\n\tprimaryCheckout = true\n" } });
  assert.match(primaryLaunchRefusal("row-file", { cwd: "/repo", fs: marked }) ?? "",
    /its \.git is a directory, and it carries a11y\.primaryCheckout=true, the fleet-driving primary checkout\./);
});

test("#1352 POSITIVE CONTROL: a linked worktree proceeds, and so does a directory outside any checkout", () => {
  assert.equal(primaryLaunchRefusal("pr-open", { cwd: "/wts/wt-a", fs: REPO_WITH_WORKTREES }), null);
  assert.equal(primaryLaunchRefusal("pr-open", { cwd: "/tmp/not-a-checkout", fs: fakeGitFs({}) }), null);
  assert.equal(launchCheckoutOf("/wts/wt-a/deep", fakeGitFs({ files: { "/wts/wt-a/.git": "gitdir: x" } })), "/wts/wt-a");
});

test("#1352: a non-empty A11Y_POLICY_LAUNCH_REASON turns the refusal into a PRINTED notice; an empty or blank one is no reason", () => {
  const plain = fakeGitFs({ dirs: ["/clone/.git"] });
  const overridden = primaryLaunchDecision("row-file", { cwd: "/clone", fs: plain, env: { [POLICY_LAUNCH_REASON_ENV]: "a test driving the CLI" } });
  assert.deepEqual(overridden, { refusal: null,
    notice: 'row-file: launched outside a linked worktree, proceeding anyway -- A11Y_POLICY_LAUNCH_REASON="a test driving the CLI"' });
  for (const blank of ["", "   ", undefined]) {
    const decision = primaryLaunchDecision("row-file", { cwd: "/clone", fs: plain, env: { [POLICY_LAUNCH_REASON_ENV]: blank } });
    assert.match(decision.refusal ?? "", /REFUSED -- launched from \/clone/, `a reason of ${JSON.stringify(blank)} does not count`);
    assert.equal(decision.notice, null);
  }
  const linked = primaryLaunchDecision("row-file", { cwd: "/wts/wt-a", fs: REPO_WITH_WORKTREES, env: { [POLICY_LAUNCH_REASON_ENV]: "unused" } });
  assert.deepEqual(linked, { refusal: null, notice: null }, "a linked worktree needs no override, and prints none");
});

test("#1352: launchGate writes the notice or the refusal and says whether to stop -- the one call each entry point makes", () => {
  const plain = fakeGitFs({ dirs: ["/clone/.git"] });
  const written: string[] = [];
  const write = (text: string) => { written.push(text); };
  assert.equal(launchGate("row-claim", { write, cwd: "/clone", fs: plain, env: {} }), true);
  assert.match(written.join(""), /^row-claim: REFUSED -- launched from \/clone, [^\n]*\n$/);
  written.length = 0;
  assert.equal(launchGate("row-claim", { write, cwd: "/clone", fs: plain, env: { [POLICY_LAUNCH_REASON_ENV]: "why" } }), false);
  assert.deepEqual(written, ['row-claim: launched outside a linked worktree, proceeding anyway -- A11Y_POLICY_LAUNCH_REASON="why"\n']);
  written.length = 0;
  assert.equal(launchGate("row-claim", { write, cwd: "/wts/wt-a", fs: REPO_WITH_WORKTREES, env: {} }), false);
  assert.deepEqual(written, [], "a linked worktree writes nothing");
});

test("#1352 DONE-WHEN 1: each policy script, launched from a plain checkout, refuses before anything; from a linked worktree it does not", () => {
  // The policy scripts (row-claim, board-snapshot, ...) moved into @a11ign/agent-org.
  const scripts = pathOf(new URL("../", import.meta.url));
  // REALPATH'D: on macOS `tmpdir()` is /var/..., a symlink to /private/var/..., and the scripts resolve
  // the real path before naming the checkout they refused. Comparing against the unresolved path made this
  // fail on a Mac and pass on Linux -- a platform artefact, not a policy one.
  const root = realpathSync(mkdtempSync(joinPath(tmpdir(), "policy-launch-")));
  try {
    const plain = joinPath(root, "plain");
    const linked = joinPath(root, "linked");
    const bin = joinPath(root, "bin");
    mkdirOnDisk(plain);
    mkdirOnDisk(bin);
    // A command named like the GitHub CLI that always fails, first on PATH: no run here can reach GitHub.
    writeOnDisk(joinPath(bin, ["g", "h"].join("")), "#!/bin/sh\necho 'stub: no GitHub here' >&2\nexit 1\n");
    chmodSync(joinPath(bin, ["g", "h"].join("")), 0o755);
    const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args],
      { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: "pipe" });
    git(plain, ["init", "--quiet"]);
    git(plain, ["commit", "--quiet", "--allow-empty", "-m", "base"]);
    git(plain, ["worktree", "add", "--quiet", "--detach", linked]);
    const env = { ...sandboxGitEnv(), PATH: `${bin}:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    for (const [script, code] of [["row-claim.ts", 2], ["row-file.ts", 1], ["pr-open.ts", 1]] as const) {
      const fromPlain = spawnSync("node", [joinPath(scripts, script)], { cwd: plain, encoding: "utf8", env });
      assert.equal(fromPlain.status, code, `${script} from a plain checkout: ${fromPlain.stderr}`);
      assert.match(fromPlain.stderr, new RegExp(`REFUSED -- launched from ${plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which is not a linked worktree`),
        `${script} names the checkout and the reason`);
      const fromLinked = spawnSync("node", [joinPath(scripts, script)], { cwd: linked, encoding: "utf8", env });
      assert.doesNotMatch(`${fromLinked.stdout}${fromLinked.stderr}`, /which is not a linked worktree/,
        `${script} from a linked worktree must not be refused for where it was launched`);
      const overridden = spawnSync("node", [joinPath(scripts, script)], { cwd: plain, encoding: "utf8",
        env: { ...env, [POLICY_LAUNCH_REASON_ENV]: "the override's own test" } });
      assert.doesNotMatch(overridden.stderr, /which is not a linked worktree/, `${script} with a reason is not refused`);
      assert.match(overridden.stderr, /proceeding anyway -- A11Y_POLICY_LAUNCH_REASON="the override's own test"/,
        `${script} prints the reason it proceeded on`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// --- #1996/#2010: THE CALL, NOT THE HELPER -------------------------------------------------------------
//
// `reviewer-2` on #2010, upheld by `product-manager`: clause 2's deliverable is a CALL --
// `fetchBoardItems` parsing `field.options` and handing them to `reportVocabularyDrift`. The reviewer
// commented that call out and the stated 25-test Acceptance stayed green, because
// `board-status-health.test.ts` imports only the pure module and never `board-snapshot.ts`.
//
// **And the fixtures could not have caught it either.** Every existing page omitted `field` entirely,
// so `statusOptions` stayed `null` and the implementation took its SHORT-READ branch -- printing
// "the vocabulary drift check DID NOT RUN" -- which looks nothing like a drift and fails no assertion. A
// fixture set that never supplies the input cannot witness the code that consumes it: the same
// empty-population defect one level up, inside the fix for a vocabulary nothing live ever read.
//
// So both directions are pinned here, against the fake code host (no token, no network): a board missing
// `Done` must REPORT, and a board offering it must NOT. Either one alone would pass with the call deleted
// -- the negative control is what kills that mutant, and the positive control is what stops the check
// being satisfied by a function that always complains.
//
// **AND THE THIRD TIME, ONE LAYER BELOW AGAIN.** The two controls below prove `fetchBoardItems` CONSUMES the
// option list the world holds, and nothing here proves the live query ASKS for it: measured at `bd398c5f`, with
// `field(name: "Status")` deleted from the query the three-file Acceptance was 83/83 GREEN, because a fake that
// hands back `field` whenever it is seeded answers a question production need never have asked. That half
// is the code host's: the request the query sends is held by the plugin's test (`board-snapshot-rows.test.ts`,
// "the items query ASKS for the Status field's options"), the query `run` actually received and not the source text.

/** Captures `process.stderr` for the duration of `fn`, restoring it even when `fn` throws. */
function stderrDuring(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { captured += String(chunk); return true; }) as never;
  try {
    fn();
  } finally {
    process.stderr.write = original as never;
  }
  return captured;
}

/** A board with the one row, whose Status field offers `statusOptions` (`null`: the page does not carry the field). */
function boardOffering(statusOptions: string[] | null) {
  const { world } = board();
  onBoard(world, 42, { title: "the row", status: "Ready" });
  world.reports.snapshot.project.statusOptions = statusOptions;
}

test("#1996: a board that does not offer `Done` is REPORTED as drift -- by fetchBoardItems, not the helper", () => {
  // THE MUTANT THIS KILLS is the one the review actually applied: deleting
  // `reportVocabularyDrift(statusOptions)` from `fetchBoardItems`. With the call gone this stderr is
  // silent and the assertion fails, which is precisely what the old Acceptance could not do.
  boardOffering(["Backlog", "Ready", "In progress", "Blocked", "Fleet-gated"]);
  const noted = stderrDuring(() => { fetchBoardItems({ fetchReady: () => [] }); });
  assert.match(noted, /does NOT offer "Done"/,
    "the live option list came back WITHOUT `Done` -- the exact state measured on the board 2026-09-22, "
    + "with 121 closed rows stranded because every settle was refused");
  assert.match(noted, /Repair is on the BOARD/,
    "and it names where the repair goes: the code is writing a correct name the field cannot accept");
  assert.doesNotMatch(noted, /DID NOT RUN/,
    "and it is the DRIFT branch, not the short-read branch -- `field` was supplied, so 'we could not ask' "
    + "would be a different and wrong answer");
});

test("#1996: a board that DOES offer `Done` reports nothing -- the control that stops a check crying wolf", () => {
  boardOffering(["Backlog", "Ready", "In progress", "Blocked", "Fleet-gated", "Done"]);
  const noted = stderrDuring(() => { fetchBoardItems({ fetchReady: () => [] }); });
  assert.doesNotMatch(noted, /does NOT offer/,
    "every name this code writes is on the board -- this is the state the row repaired the board INTO, "
    + "and a check that still complained here would be turned off within a day");
  assert.doesNotMatch(noted, /DID NOT RUN/, "and the check did run: `field` was supplied");
});

test("#1996: a page carrying NO `field` is a SHORT READ, never a clean board", () => {
  // The third answer, and the reason `statusOptions` is `null` rather than `[]`. An empty array would
  // make `vocabularyDrift` report every written name as missing -- "the board lost its whole vocabulary"
  // when it means "nobody asked it". This is the branch a query that stopped selecting `field` would take on the REAL board, forever.
  boardOffering(null);
  const noted = stderrDuring(() => { fetchBoardItems({ fetchReady: () => [] }); });
  assert.match(noted, /DID NOT RUN/,
    "a read that came back short must say so rather than pass as a board with no drift");
  assert.doesNotMatch(noted, /does NOT offer/,
    "and it must NOT wear the drift's clothes -- that is the failure `vocabularyDrift`'s own TypeError "
    + "guard refuses one level down");
});
