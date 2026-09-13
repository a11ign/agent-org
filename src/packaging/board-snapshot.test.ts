/**
 * Every board mutation must snapshot before it writes -- issue #399. 2026-09-08: adding one Status option
 * with `updateProjectV2Field` and a full `singleSelectOptions` list REPLACED the whole option set and
 * dropped all 112 items' Status assignment in one call. Recovered completely, and only because a snapshot
 * happened to exist from minutes earlier for an unrelated reason. `withBoardSnapshot` makes that
 * deliberate: the mutation runs ONLY after a real snapshot has been written, never on the strength of one
 * that "would have existed anyway".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBoardItems,
  fetchReadyIssueNumbers,
  readyRowsMissingStatus,
  writeBoardSnapshot,
  withBoardSnapshot,
  forgetProcessSnapshot,
  SNAPSHOT_MAX_AGE_MS,
  snapshotStamp,
  PROJECT_OWNER,
  PROJECT_NUMBER,
  SNAPSHOT_DIR,
  fetchTouchedItems,
  writeScopedSnapshot,
  TOUCHED_ITEM_QUERY,
} from "../../../../scripts/board-snapshot.mjs";
import { refusalCause, PROJECT_UNREADABLE } from "../../../../scripts/settle-closed-status.mjs";

/** One page of a real `gh api graphql` response, shaped exactly like the live schema returns it. */
function page({ nodes, hasNextPage = false, endCursor = null }: {
  nodes: Array<{ id: string; number?: number; title?: string; status?: string; state?: string }>;
  hasNextPage?: boolean;
  endCursor?: string | null;
}) {
  return JSON.stringify({
    data: {
      user: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage, endCursor },
            nodes: nodes.map((n) => ({
              id: n.id,
              // #1219: `state` is part of what the query asks for now, so the fixture emits it --
              // a fixture that models a narrower shape than the producer tests a response that
              // cannot occur. Defaults to OPEN so existing cases keep their meaning; a case that
              // cares passes `state` explicitly.
              content: n.number !== undefined
                ? { number: n.number, title: n.title ?? "", state: n.state ?? "OPEN" } : null,
              fieldValues: {
                nodes: n.status !== undefined
                  ? [{ name: n.status, field: { name: "Status" } }]
                  : [],
              },
            })),
          },
        },
      },
    },
  });
}

test("fetchBoardItems reads number, title and Status off a single page", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 42, title: "the row", status: "Ready" }] });
  const items = fetchBoardItems({ run, fetchReady: () => [] });
  assert.deepEqual(items, [{ itemId: "PVTI_1", number: 42, title: "the row", status: "Ready", state: "OPEN" }]);
});

test("a draft item (no linked issue) is recorded with number/title null, never dropped", () => {
  const run = () => page({ nodes: [{ id: "PVTI_draft" }] });
  const items = fetchBoardItems({ run, fetchReady: () => [] });
  // #1219: `state` is null for a draft too -- a draft has no issue, so it has no state, and defaulting
  // it to OPEN would make every draft an open row the contradiction check then reasons about.
  assert.deepEqual(items, [{ itemId: "PVTI_draft", number: null, title: null, status: null, state: null }]);
});

test("fetchBoardItems follows pagination across multiple pages", () => {
  let call = 0;
  const run = (_cmd: string, args: string[]) => {
    call += 1;
    if (call === 1) {
      assert.ok(!args.some((a) => a.startsWith("cursor=")), "the first page must not pass a cursor");
      return page({ nodes: [{ id: "PVTI_1", number: 1, title: "a" }], hasNextPage: true, endCursor: "CUR" });
    }
    assert.ok(args.includes("cursor=CUR"), "the second page must pass back the first page's endCursor");
    return page({ nodes: [{ id: "PVTI_2", number: 2, title: "b" }], hasNextPage: false });
  };
  const items = fetchBoardItems({ run, fetchReady: () => [] });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.number), [1, 2]);
});

test("fetchBoardItems throws rather than returning a partial list when gh fails", () => {
  const run = () => {
    throw new Error("gh: not authenticated");
  };
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /could not read Project/);
});

test("fetchBoardItems throws on a response missing the expected shape, rather than guessing", () => {
  const run = () => JSON.stringify({ data: { user: { projectV2: null } } });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /did not have the shape/);
});

// --- #555: the refusal must name the GraphQL error, not just "could not read Project N items" ---

test("#555: a non-zero exit whose stdout carries a GraphQL error quotes its type and message", () => {
  // The exact shape measured on the real FORBIDDEN failure that cost #546 three hours: `gh` exits 1, but
  // the response body it printed before exiting still carries the API's own diagnosis.
  const stdout = JSON.stringify({
    errors: [{ type: "FORBIDDEN", path: ["user", "projectV2"],
      message: "Resource not accessible by personal access token" }],
  });
  const run = () => {
    const err = new Error("Command failed: gh api graphql ...") as Error & { stdout: string; stderr: string };
    err.stdout = stdout;
    err.stderr = "gh: Resource not accessible by personal access token\n";
    throw err;
  };
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }),
    /FORBIDDEN \(user\.projectV2\): Resource not accessible by personal access token/);
});

test("#555: a non-zero exit with no parseable GraphQL error falls back to the plain exit message, "
  + "rather than inventing a cause", () => {
  const run = () => { throw new Error("gh: not authenticated"); };
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /could not read Project.*not authenticated/s);
});

test("#555 MUTATION TARGET: a 200 response carrying `data` AND `errors` together is REFUSED, never read "
  + "as a complete board -- the exact shape the real probe returned: totalCount correct, every node null", () => {
  // GraphQL's own answer when the token can COUNT an item but not READ it: the request otherwise
  // succeeds (exit 0, `data` present, `pageInfo` well-formed), but the `nodes` list is null exactly
  // where an item should be, and the `errors` array is the only place that says why.
  const run = () => JSON.stringify({
    data: { user: { projectV2: { items: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [null, null, null],
    } } } },
    errors: [
      { type: "FORBIDDEN", path: ["user", "projectV2", "items", "nodes", 0], message: "Resource not accessible by personal access token" },
      { type: "FORBIDDEN", path: ["user", "projectV2", "items", "nodes", 1], message: "Resource not accessible by personal access token" },
      { type: "FORBIDDEN", path: ["user", "projectV2", "items", "nodes", 2], message: "Resource not accessible by personal access token" },
    ],
  });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /FORBIDDEN/);
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /Resource not accessible by personal access token/);
});

test("#555 CONTROL: an ordinary clean response (no errors array at all) is unaffected", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 1, title: "fine", status: "Ready" }] });
  const items = fetchBoardItems({ run, fetchReady: () => [] });
  assert.deepEqual(items, [{ itemId: "PVTI_1", number: 1, title: "fine", status: "Ready", state: "OPEN" }]);
});

test("#555: an `errors` array with data still present is refused BEFORE the shape check would even run "
  + "-- so a caller never sees \"did not have the shape\" for a response that actually named its own cause", () => {
  const run = () => JSON.stringify({
    data: { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
    errors: [{ type: "SOME_OTHER_TYPE", message: "a different failure entirely" }],
  });
  assert.throws(() => fetchBoardItems({ run, fetchReady: () => [] }), /SOME_OTHER_TYPE: a different failure entirely/);
});

test("PROJECT_OWNER and PROJECT_NUMBER match the real board (a11y-witness -- what is open, Project 2)", () => {
  assert.equal(PROJECT_OWNER, "DanBeckDev");
  assert.equal(PROJECT_NUMBER, 2);
});

test("snapshotStamp is filesystem-safe -- no colons, and two calls a second apart differ", () => {
  const a = snapshotStamp(new Date("2026-09-08T00:01:02.345Z"));
  assert.doesNotMatch(a, /:/);
  const b = snapshotStamp(new Date("2026-09-08T00:01:03.345Z"));
  assert.notEqual(a, b);
});

test("writeBoardSnapshot fetches, then writes JSON to runs/board-snapshots/<stamp>.json, and returns the path", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 42, title: "row", status: "Ready" }] });
  const written: Array<{ path: string; data: string }> = [];
  const mkdirs: string[] = [];
  const path = writeBoardSnapshot({
    run,
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
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_1", number: 42, title: "row", status: "Ready", state: "OPEN" }]);
});

test("writeBoardSnapshot throws, never swallows, when the fetch fails", () => {
  const run = () => {
    throw new Error("network unreachable");
  };
  assert.throws(() => writeBoardSnapshot({ run, fetchReady: () => [], mkdir: () => {}, writeFile: () => {} }),
    /could not read Project/);
});

/**
 * MUTATION-EQUIVALENT, run directly rather than through `npm run mutate`: a failing snapshot write must
 * refuse the mutation outright. This is the whole guarantee `withBoardSnapshot` exists to give.
 */
test("MUTATION: a failing snapshot write means the mutation never runs", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 1, title: "row" }] });
  let mutateCalled = false;
  assert.throws(() => withBoardSnapshot(() => { mutateCalled = true; return "ok"; }, {
    run,
    fetchReady: () => [],
    mkdir: () => {},
    writeFile: () => { throw new Error("disk full"); },
  }), /could not write the snapshot/);
  assert.equal(mutateCalled, false, "the mutation must never run when the snapshot did not write");
});

test("withBoardSnapshot calls the mutation, and only after logging the snapshot path, when the snapshot succeeds", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 1, title: "row" }] });
  const log: string[] = [];
  let mutateCalled = false;
  const result = withBoardSnapshot(() => {
    mutateCalled = true;
    return "mutation result";
  }, {
    run,
    fetchReady: () => [],
    mkdir: () => {},
    writeFile: () => {},
    now: () => new Date("2026-09-08T00:00:00.000Z"),
    log: (line) => log.push(line),
  });
  assert.equal(mutateCalled, true);
  assert.equal(result, "mutation result");
  assert.equal(log.length, 1);
  assert.match(log[0], /wrote runs\/board-snapshots\/2026-09-08T00-00-00-000Z\.json before mutating/);
});

// --- #747: fieldValues is nested inside items, the one shape with no totalCount to check itself. An
// independently-derived floor -- every open `ready` issue must show up in the snapshot WITH a Status --
// catches a narrowed read that every assertion available inside the response itself would pass. ---

test("readyRowsMissingStatus: a ready row with a Status is not reported", () => {
  const items = [{ itemId: "PVTI_1", number: 725, title: "row", status: "Ready", state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), []);
});

test("readyRowsMissingStatus: a ready row present but with a null Status IS reported -- the exact shape "
  + "a narrowed fieldValues read produces", () => {
  const items = [{ itemId: "PVTI_1", number: 725, title: "row", status: null, state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), [725]);
});

test("readyRowsMissingStatus: a ready row absent from the snapshot entirely IS reported -- \"appears "
  + "with a Status\" fails on either half", () => {
  assert.deepEqual(readyRowsMissingStatus([], [725]), [725]);
});

test("readyRowsMissingStatus: draft items (number null) never match a ready issue number and are "
  + "ignored rather than crashing the lookup", () => {
  // #1219: `state: null` -- a draft has no issue, so it has no state. `tsc` caught this, the same way
  // it catches a partial fixture typechecking as the real thing.
  const items = [{ itemId: "PVTI_draft", number: null, title: null, status: null, state: null }];
  assert.deepEqual(readyRowsMissingStatus(items, [725]), [725]);
});

test("readyRowsMissingStatus: an empty ready population always passes -- nothing to check", () => {
  assert.deepEqual(readyRowsMissingStatus([{ itemId: "x", number: 1, title: "t", status: null, state: "OPEN" }], []), []);
});

test("fetchReadyIssueNumbers: reads --json number off gh issue list, filtered to open + ready", () => {
  let seenArgs: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    seenArgs = args;
    return JSON.stringify([{ number: 717 }, { number: 725 }]);
  };
  assert.deepEqual(fetchReadyIssueNumbers({ run }), [717, 725]);
  assert.ok(seenArgs.includes("--label") && seenArgs.includes("ready"));
  assert.ok(seenArgs.includes("--state") && seenArgs.includes("open"));
  assert.ok(seenArgs.includes("--json") && seenArgs.includes("number"));
});

test("fetchReadyIssueNumbers: exactly `limit` rows back is refused as indistinguishable from truncated, "
  + "same discipline as ready-label-audit.mjs's fetchIssues", () => {
  const run = () => JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ number: i })));
  assert.throws(() => fetchReadyIssueNumbers({ run, limit: 3 }), /exactly the requested limit/);
});

test("fetchReadyIssueNumbers: a non-array response is refused rather than guessed at", () => {
  const run = () => JSON.stringify({ not: "a list" });
  assert.throws(() => fetchReadyIssueNumbers({ run }), /was not a list/);
});

test("fetchReadyIssueNumbers: gh failing throws, never falls back to an empty (falsely clean) "
  + "population", () => {
  const run = () => { throw new Error("gh: not authenticated"); };
  assert.throws(() => fetchReadyIssueNumbers({ run }), /could not list open ready issues/);
});

/** A `run` that answers BOTH calls `fetchBoardItems` now makes: the items page, and the ready-issue list. */
function dualRun(itemsPageJson: string, readyNumbers: number[]) {
  return (_cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(readyNumbers.map((number) => ({ number })));
    return itemsPageJson;
  };
}

test("fetchBoardItems: every ready row carries a Status -- passes unchanged, same as today's 203 items", () => {
  const run = dualRun(page({ nodes: [{ id: "PVTI_1", number: 725, title: "row", status: "Ready" }] }), [725]);
  const items = fetchBoardItems({ run });
  assert.deepEqual(items, [{ itemId: "PVTI_1", number: 725, title: "row", status: "Ready", state: "OPEN" }]);
});

test("#747 ACCEPTANCE, MUTATION TARGET: a ready row's fieldValues dropped (the narrowed-connection "
  + "shape) makes fetchBoardItems REFUSE and NAME it, rather than returning it with no Status", () => {
  // #725 is `ready` and on the board, but its fieldValues came back empty -- exactly what a shared-budget
  // narrowing produces, and what today's response with no totalCount on fieldValues cannot itself catch.
  const run = dualRun(page({ nodes: [{ id: "PVTI_1", number: 725, title: "row" }] }), [725]);
  assert.throws(() => fetchBoardItems({ run }), /1 open ready row\(s\) came back with no Status/);
  assert.throws(() => fetchBoardItems({ run }), /#725/);
});

test("fetchBoardItems: a ready row missing from the board entirely is also refused and named", () => {
  const run = dualRun(page({ nodes: [{ id: "PVTI_1", number: 1, title: "unrelated", status: "Ready" }] }), [725]);
  assert.throws(() => fetchBoardItems({ run }), /#725/);
});

test("fetchBoardItems: two ready rows both missing Status are both named", () => {
  const run = dualRun(page({ nodes: [
    { id: "PVTI_1", number: 717, title: "a" },
    { id: "PVTI_2", number: 718, title: "b" },
  ] }), [717, 718]);
  assert.throws(() => fetchBoardItems({ run }), /#717, #718/);
});

test("fetchBoardItems: an empty ready population (fetchReady: () => []) skips the check entirely -- "
  + "every pre-#747 test in this file uses exactly this to isolate the pagination/error-handling behaviour "
  + "they actually test", () => {
  const run = () => page({ nodes: [{ id: "PVTI_1", number: 1, title: "row" }] });
  const items = fetchBoardItems({ run, fetchReady: () => [] });
  assert.equal(items.length, 1);
});

// --- #891, live 2026-09-09: a row freshly `gh project item-add`-ed, ready-labelled (a real `gh issue
// create -l ready`, not row-file's own later `--ready` sentinel), with no Status yet, tripped the #747
// floor ON ITSELF -- moveProjectStatus's own pre-write snapshot refused the very call meant to fix it.
// `excludeIssueNumber` lets the caller name the ONE row currently being boarded so the floor stops
// treating "about to be fixed" the same as "silently neglected", without blinding it to any other row. ---

test("readyRowsMissingStatus: excludeIssueNumber removes exactly that row from the report, even though "
  + "it is genuinely ready with no Status -- the #891 self-trip shape", () => {
  assert.deepEqual(readyRowsMissingStatus([], [891], 891), []);
});

test("readyRowsMissingStatus: excludeIssueNumber does not blind the floor to a DIFFERENT ready row "
  + "missing its Status -- only the named row is exempt", () => {
  const items = [{ itemId: "PVTI_1", number: 717, title: "unrelated", status: null, state: "OPEN" }];
  assert.deepEqual(readyRowsMissingStatus(items, [717, 891], 891), [717]);
});

test("readyRowsMissingStatus: excludeIssueNumber defaults to null, excluding nothing -- every existing "
  + "caller (a plain snapshot, an audit) sees every row honestly", () => {
  assert.deepEqual(readyRowsMissingStatus([], [725]), [725]);
});

test("fetchBoardItems: excludeIssueNumber threaded through end-to-end reproduces the #891 fix -- a "
  + "freshly boarded, ready-labelled, Status-less row does NOT refuse when it is the excluded row", () => {
  const run = dualRun(page({ nodes: [{ id: "PVTI_1", number: 891, title: "row" }] }), [891]);
  const items = fetchBoardItems({ run, excludeIssueNumber: 891 });
  assert.deepEqual(items, [{ itemId: "PVTI_1", number: 891, title: "row", status: null, state: "OPEN" }]);
});

test("fetchBoardItems, MUTATION TARGET: excludeIssueNumber naming the WRONG row still refuses -- proving "
  + "the exclusion is by number, not a blanket bypass of the floor", () => {
  const run = dualRun(page({ nodes: [{ id: "PVTI_1", number: 891, title: "row" }] }), [891]);
  assert.throws(() => fetchBoardItems({ run, excludeIssueNumber: 1 }), /#891/);
});

// --- #852: ONE SWEEP PER PROCESS ----------------------------------------------------------------
//
// Every Status move swept the whole board first: `moveProjectStatus` wraps a single-field edit in
// `withBoardSnapshot`, and the page count grows with the board, so every row added made every future
// claim more expensive. Measured on this branch with an injected `run` against a 3-page board:
//
//   before   1 move -> 3 pages   3 moves -> 9 pages    20 moves -> 60 pages
//   after    1 move -> 3 pages   3 moves -> 3 pages    20 moves -> 3 pages
//
// THE ASSERTIONS ARE ON THE CALLS, not on anything the result contains, because the result is identical
// either way — which is the reason nobody noticed for four days.

/** A board of `pages` pages, and a recorder of every `gh` invocation made against it. */
function boardOf(pages: number) {
  const calls: string[][] = [];
  let served = 0;
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (!args.join(" ").includes("graphql")) return "";
    const cursor = served; served += 1;
    return JSON.stringify({ data: { user: { projectV2: { items: {
      pageInfo: { hasNextPage: cursor < pages - 1, endCursor: `c${cursor + 1}` },
      nodes: [{ id: `PVTI_${cursor}`, content: { number: cursor, title: "t", state: "OPEN" },
        fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] } }],
    } } } } });
  };
  const boardPages = () => calls.filter((c) => c.join(" ").includes("graphql")).length;
  return { run, calls, boardPages };
}

// `exists` is stubbed TRUE here because `writeFile` is stubbed to drop the file: with the real
// `existsSync`, a snapshot these tests never actually wrote would read as deleted and every reuse would
// fall through to a fresh sweep. The disk check has its own test below, with its own in-memory disk.
const quiet = { fetchReady: () => [], mkdir: () => {}, writeFile: () => {}, log: () => {},
  exists: () => true };

test("#852: N board mutations in one process cost ONE sweep, not N", () => {
  forgetProcessSnapshot();
  const board = boardOf(3);
  let mutations = 0;
  const N = 20;
  for (let i = 0; i < N; i += 1) {
    withBoardSnapshot(() => { mutations += 1; }, { ...quiet, run: board.run });
  }
  assert.equal(mutations, N, "every mutation must still run -- this is a cost fix, not a skip");
  assert.equal(board.boardPages(), 3,
    `${N} mutations must cost one 3-page sweep. Before #852 this was ${N * 3} pages, and the page count `
    + "grows with the board, so the old cost rose every time a row was filed");
});

test("#852 POSITIVE CONTROL: a fresh process still sweeps, so the reuse is not a skip", () => {
  // Without this, "0 pages" would satisfy the test above perfectly — including for an implementation
  // that never snapshots at all, which is #399's guarantee deleted rather than made cheaper.
  forgetProcessSnapshot();
  const board = boardOf(3);
  withBoardSnapshot(() => {}, { ...quiet, run: board.run });
  assert.equal(board.boardPages(), 3, "the FIRST mutation of a process must pay for a real sweep");
});

test("#852: the reuse EXPIRES, so the record is never more than the bound older than the change", () => {
  forgetProcessSnapshot();
  const board = boardOf(1);
  const start = new Date("2026-09-13T12:00:00.000Z");
  const at = (ms: number) => new Date(start.getTime() + ms);
  withBoardSnapshot(() => {}, { ...quiet, run: board.run, now: () => start });
  withBoardSnapshot(() => {}, { ...quiet, run: board.run, now: () => at(SNAPSHOT_MAX_AGE_MS - 1000) });
  assert.equal(board.boardPages(), 1, "inside the bound, the existing snapshot still describes the board");
  withBoardSnapshot(() => {}, { ...quiet, run: board.run, now: () => at(SNAPSHOT_MAX_AGE_MS + 1000) });
  assert.equal(board.boardPages(), 2,
    "past the bound a fresh sweep is taken -- the trade is a snapshot slightly older than the mutation "
    + "it covers, and the bound is what keeps that sayable rather than unbounded");
});

test("#852: the snapshot FILE says it describes the board before the FIRST mutation", () => {
  // A reader who finds a snapshot next to a mutation will otherwise assume the stronger guarantee —
  // "the board immediately before THIS change" — which is exactly what it no longer is.
  forgetProcessSnapshot();
  const board = boardOf(1);
  const written: string[] = [];
  withBoardSnapshot(() => {}, { ...quiet, run: board.run, writeFile: (_p, data) => written.push(data) });
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
  const board = boardOf(1);
  const onDisk = new Set<string>();
  const deps = { ...quiet, run: board.run,
    writeFile: (p: string) => onDisk.add(p),
    exists: (p: string) => onDisk.has(p) };

  withBoardSnapshot(() => {}, deps);
  assert.equal(board.boardPages(), 1, "the first mutation sweeps");
  withBoardSnapshot(() => {}, deps);
  assert.equal(board.boardPages(), 1, "the second reuses it, because it is still there");

  onDisk.clear(); // `rm -rf runs/`
  let ranWithNothingBehindIt = false;
  withBoardSnapshot(() => { ranWithNothingBehindIt = true; }, deps);
  assert.equal(board.boardPages(), 2,
    "the snapshot is gone, so the next mutation takes a FRESH sweep rather than trusting a remembered path");
  assert.equal(ranWithNothingBehindIt, true, "and it still runs -- with a real snapshot behind it again");
});

test("#852: #399's guarantee is untouched -- a failed write still means the mutation never runs", () => {
  // The cost fix must not weaken the reason the sweep exists. A snapshot that cannot be written is still
  // a refusal, not a warning, on the first mutation of a process.
  forgetProcessSnapshot();
  const board = boardOf(1);
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; },
    { ...quiet, run: board.run, writeFile: () => { throw new Error("read-only filesystem"); } }),
  /refusing to proceed/);
  assert.equal(ran, false, "mutate must never be reached when the snapshot could not be written");
});

// --- #1275: A MUTATION THAT NAMES THE ITEM IT TOUCHES SNAPSHOTS THAT ITEM, NOT THE BOARD ------------------------
//
// Every board mutation in scripts/ is one item's Status, and each paid a full sweep first: 6 pages at 555 items,
// plus #747's ready-issue list. The account's GraphQL budget ran out twice on 2026-09-13. The three CAPTURED
// responses below are what `TOUCHED_ITEM_QUERY` itself returned live on 2026-09-13 (gh 2.100.0), verbatim.
// THE ASSERTIONS ARE ON THE CALLS, as #852's are: the snapshot's contents cannot show what reading it cost.

/** Captured: #1275, on Project 2 at "In progress". */
const CAPTURED_ON_BOARD = "{\"data\":{\"user\":{\"projectV2\":{\"id\":\"PVT_kwHOAsR0u84BinDJ\"}},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lAHOAsR0u84BinDJzg6uCZo\",\"project\":{\"number\":2},\"fieldValueByName\":{\"name\":\"In progress\"}}]}}}}}";
/** Captured: #393, closed and never added to Project 2 -- the row #400's not-on-board wording was measured on. */
const CAPTURED_OFF_BOARD = "{\"data\":{\"user\":{\"projectV2\":{\"id\":\"PVT_kwHOAsR0u84BinDJ\"}},\"repository\":{\"issue\":{\"number\":393,\"title\":\"pre-push hook runs doc-references.test.ts without generating docs/coverage.md first, unlike CI's docs job\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}}}";
/** Captured: the same query naming project 999. `gh` exited 1 and printed this on stdout. */
const CAPTURED_NO_PROJECT = "{\"data\":{\"user\":{\"projectV2\":null},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lAHOAsR0u84BinDJzg6uCZo\",\"project\":{\"number\":2},\"fieldValueByName\":{\"name\":\"In progress\"}}]}}}},\"errors\":[{\"type\":\"NOT_FOUND\",\"path\":[\"user\",\"projectV2\"],\"locations\":[{\"line\":3,\"column\":27}],\"message\":\"Could not resolve to a ProjectV2 with the number 999.\"}]}";

/** A response of the captured shape for any issue. The first test below pins that shape to the captures. */
function touched(issue: number, { onBoard = true, status = "In progress", totalCount }:
  { onBoard?: boolean; status?: string; totalCount?: number } = {}) {
  const nodes = onBoard ? [{ id: `PVTI_${issue}`, project: { number: 2 }, fieldValueByName: { name: status } }] : [];
  return JSON.stringify({ data: { user: { projectV2: { id: "PVT_kwHOAsR0u84BinDJ" } }, repository: { issue: {
    number: issue, title: `row ${issue}`, state: "OPEN", projectItems: { totalCount: totalCount ?? nodes.length, nodes },
  } } } });
}

/** Keys and value types, recursively -- what a fixture must share with the response it stands in for. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return value === null ? "null" : typeof value;
}

/** A `gh` serving a board of `pages` pages AND per-issue touched reads, recording every call by kind. */
function ghOf(pages: number, answer: (issue: number) => string = (issue) => touched(issue)) {
  const calls: string[][] = [];
  let served = 0;
  const issueOf = (args: string[]) => args.find((arg) => arg.startsWith("issue="));
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (!args.join(" ").includes("graphql")) return "";
    const issue = issueOf(args);
    if (issue) return answer(Number(issue.slice("issue=".length)));
    const cursor = served; served += 1;
    return JSON.stringify({ data: { user: { projectV2: { items: {
      pageInfo: { hasNextPage: cursor < pages - 1, endCursor: `c${cursor + 1}` },
      nodes: [{ id: `PVTI_page${cursor}`, content: { number: 10000 + cursor, title: "t", state: "OPEN" },
        fieldValues: { nodes: [{ name: "Backlog", field: { name: "Status" } }] } }],
    } } } } });
  };
  const graphqlCalls = () => calls.filter((call) => call.join(" ").includes("graphql"));
  return {
    run,
    boardPages: () => graphqlCalls().filter((call) => !issueOf(call)).length,
    touchedReads: () => graphqlCalls().filter((call) => issueOf(call)).length,
    // `gh issue list --json` is GraphQL too; it is counted separately because its argv does not say so.
    readyLists: () => calls.filter((call) => call[0] === "issue" && call[1] === "list").length,
  };
}

// `exists` is stubbed TRUE because `writeFile` is stubbed to drop the file -- see `quiet` above.
const quietIO = { mkdir: () => {}, writeFile: () => {}, log: () => {}, exists: () => true };

test("#1275: the fixture builder models the shape TOUCHED_ITEM_QUERY returned live, on and off the board", () => {
  assert.deepEqual(shapeOf(JSON.parse(touched(1275))), shapeOf(JSON.parse(CAPTURED_ON_BOARD)));
  assert.deepEqual(shapeOf(JSON.parse(touched(393, { onBoard: false }))), shapeOf(JSON.parse(CAPTURED_OFF_BOARD)));
  // What the stubs cannot see, and the captures were read through: the request names the Project, whose refusal the
  // close path classifies, and asks for the count a short list is checked against.
  assert.match(TOUCHED_ITEM_QUERY, /user\(login: \$owner\) \{ projectV2\(number: \$project\) \{ id \} \}/);
  assert.match(TOUCHED_ITEM_QUERY, /projectItems\(first: 10\) \{\s+totalCount/);
});

test("#1275 ACCEPTANCE: a mutation that names its item costs ONE GraphQL request -- no board page, no ready list", () => {
  forgetProcessSnapshot();
  const gh = ghOf(6); // 555 items today: six pages of 100
  let ran = false;
  withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: gh.run, touches: 725 });
  assert.equal(ran, true, "the mutation still runs -- this is a cost fix, not a skip");
  assert.equal(gh.touchedReads(), 1, "one targeted read of #725's item");
  assert.equal(gh.boardPages(), 0, "and no page of the board, whatever the board's size");
  assert.equal(gh.readyLists(), 0, "and no ready-issue list: #747's floor guards a 100-item page, not one item");
});

test("#1275 CONTROL: a mutation that names its item still has a snapshot WRITTEN and PRINTED before it runs", () => {
  // Holds for the scoped snapshot and for the full sweep alike, which is what makes it the row's control: restore the
  // full sweep and the ACCEPTANCE count above goes back up while this stays green.
  forgetProcessSnapshot();
  const gh = ghOf(6);
  const order: string[] = [];
  withBoardSnapshot(() => { order.push("mutate"); }, { ...quietIO, run: gh.run, touches: 725,
    writeFile: () => { order.push("write"); }, log: (line: string) => { order.push(line); } });
  assert.equal(order.filter((entry) => entry === "write").length, 1, "one snapshot written -- never #399's guarantee deleted");
  assert.match(order[1] ?? "", /^board-snapshot: wrote runs\/board-snapshots\/\S+\.json before mutating/, "and printed");
  assert.equal(order[2], "mutate", "and only then the mutation");
});

test("#1275: the scoped file is named for its item, and says it is not the board", () => {
  forgetProcessSnapshot();
  const gh = ghOf(6);
  const written: Array<{ path: string; data: string }> = [];
  const log: string[] = [];
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, touches: 725, now: () => new Date("2026-09-13T19:00:00.000Z"),
    writeFile: (path: string, data: string) => { written.push({ path, data }); }, log: (line: string) => { log.push(line); } });
  assert.equal(written[0].path, `${SNAPSHOT_DIR}/2026-09-13T19-00-00-000Z-issue-725.json`);
  const parsed = JSON.parse(written[0].data);
  assert.deepEqual(parsed.scope, { issues: [725] });
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_725", number: 725, title: "row 725", status: "In progress", state: "OPEN" }]);
  assert.deepEqual(parsed.notOnBoard, []);
  assert.match(parsed.takenBefore, /SCOPED to the item\(s\) that mutation touches, not the whole board/,
    "and the file says so, so nobody takes it for the board");
  assert.match(log.join("\n"), /wrote runs\/board-snapshots\/2026-09-13T19-00-00-000Z-issue-725\.json before mutating #725/);
});

test("#1275: the same counter on the UNSCOPED path -- what every one-item move paid before this row", () => {
  forgetProcessSnapshot();
  const gh = ghOf(6);
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run });
  assert.equal(gh.boardPages(), 6, "six pages of 100 at today's 555 items -- and one more per hundred rows filed");
  assert.equal(gh.readyLists(), 1, "plus #747's ready-issue list");
  assert.equal(gh.touchedReads(), 0);
});

test("#1275: fetchTouchedItems asks gh for exactly the touched issues, and reads the captured responses", () => {
  const argv: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    argv.push(args);
    return args.includes("issue=1275") ? CAPTURED_ON_BOARD : CAPTURED_OFF_BOARD;
  };
  const result = fetchTouchedItems([1275, 393], { run });
  assert.deepEqual(result, {
    items: [{ itemId: "PVTI_lAHOAsR0u84BinDJzg6uCZo", number: 1275,
      title: JSON.parse(CAPTURED_ON_BOARD).data.repository.issue.title, status: "In progress", state: "OPEN" }],
    notOnBoard: [393],
  });
  assert.equal(argv.length, 2, "one request per touched issue");
  for (const [args, issue] of [[argv[0], 1275], [argv[1], 393]] as const) {
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    assert.ok(args.includes(`query=${TOUCHED_ITEM_QUERY}`), "the query the captures were read through");
    for (const variable of ["owner=DanBeckDev", "name=a11y-witness", "project=2", `issue=${issue}`]) {
      assert.ok(args.includes(variable), `${variable} must reach gh`);
    }
  }
});

test("#1275: an issue NOT on the board is recorded as such, and the mutation still runs so gh can say so", () => {
  forgetProcessSnapshot();
  const gh = ghOf(6, () => CAPTURED_OFF_BOARD);
  const written: string[] = [];
  let ran = false;
  withBoardSnapshot(() => { ran = true; },
    { ...quietIO, run: gh.run, touches: 393, writeFile: (_path: string, data: string) => { written.push(data); } });
  assert.equal(ran, true, "`gh project item-edit` names a row that is not on the board, and moveProjectStatus reads "
    + "that as notOnBoard (#400) -- refusing here would replace that wording with this file's");
  const parsed = JSON.parse(written[0]);
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.notOnBoard, [393]);
});

test("#1275: a token that cannot read the Project is REFUSED, and the close path still classifies it as project-unreadable", () => {
  forgetProcessSnapshot();
  const run = (_cmd: string, args: string[]): string => {
    assert.ok(args.some((arg) => arg.startsWith("issue=")), "only the touched read may run");
    const error = new Error("Command failed: gh api graphql ...") as Error & { stdout: string; status: number };
    error.stdout = CAPTURED_NO_PROJECT;
    error.status = 1;
    throw error;
  };
  let ran = false;
  let message = "";
  try {
    withBoardSnapshot(() => { ran = true; }, { ...quietIO, run, touches: 1275 });
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(ran, false, "no snapshot, no mutation (#399)");
  assert.match(message, /NOT_FOUND \(user\.projectV2\): Could not resolve to a ProjectV2 with the number 999/,
    "GraphQL's own error, read off the failed process's stdout (#555)");
  assert.equal(refusalCause(`could not move #1275's Status to "Done" -- ${message}`), PROJECT_UNREADABLE,
    "settle-closed-status.mjs's own classifier: #546's bridge reads this cause, and a scoped read must still produce it");
  assert.equal(refusalCause("could not move #1275's Status to \"Done\" -- board-snapshot: gh's response for #1275 "
    + "did not have the shape"), "other", "CONTROL: the classifier is not satisfied by any board-snapshot refusal");
});

test("#1275: the SAME captured error on a zero exit -- errors beside data -- is refused before data is read", () => {
  forgetProcessSnapshot();
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: () => CAPTURED_NO_PROJECT, touches: 1275 }),
    /GraphQL returned an error alongside its response.*NOT_FOUND \(user\.projectV2\)/s);
  assert.equal(ran, false);
});

test("#1275: an answer about a different issue, or a list shorter than its own count, is refused -- never 'not on the board'", () => {
  forgetProcessSnapshot();
  assert.throws(() => withBoardSnapshot(() => {}, { ...quietIO, run: ghOf(1, () => touched(999)).run, touches: 725 }),
    /did not have the shape .* for that issue/s);
  forgetProcessSnapshot();
  assert.throws(() => withBoardSnapshot(() => {}, { ...quietIO, run: ghOf(1, (n) => touched(n, { totalCount: 2 })).run,
    touches: 725 }), /came back 1 of 2 -- refusing to read a partial list as "not on the board"/);
  forgetProcessSnapshot();
  assert.throws(() => withBoardSnapshot(() => {}, { ...quietIO, run: ghOf(1, () => "not json").run, touches: 725 }),
    /response for #725 was not JSON/);
});

test("#1275: a second move of the SAME item reuses its scoped snapshot; a different item takes its own", () => {
  forgetProcessSnapshot();
  const gh = ghOf(6);
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, touches: 725 });
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, touches: 725 });
  assert.equal(gh.touchedReads(), 1, "a claim then a decline of one row: one read");
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, touches: 726 });
  assert.equal(gh.touchedReads(), 2, "a scoped file never licenses a mutation of a different item");
  assert.equal(gh.boardPages(), 0);
});

test("#1275: a FULL snapshot this process already holds covers a scoped move, as #852's reuse did", () => {
  forgetProcessSnapshot();
  const gh = ghOf(2);
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, fetchReady: () => [] });
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, touches: 725 });
  assert.equal(gh.boardPages(), 2, "the full sweep, once");
  assert.equal(gh.touchedReads(), 0, "and the scoped move reads nothing more: the board already covers its item");
});

test("#1275: a scoped snapshot deleted from disk, or past the bound, is read again", () => {
  forgetProcessSnapshot();
  const gh = ghOf(1);
  const onDisk = new Set<string>();
  const start = new Date("2026-09-13T19:00:00.000Z");
  const at = (ms: number) => ({ ...quietIO, run: gh.run, touches: 725, now: () => new Date(start.getTime() + ms),
    writeFile: (path: string) => { onDisk.add(path); }, exists: (path: string) => onDisk.has(path) });
  withBoardSnapshot(() => {}, at(0));
  withBoardSnapshot(() => {}, at(1000));
  assert.equal(gh.touchedReads(), 1, "still on disk and inside the bound: reused");
  onDisk.clear(); // `rm -rf runs/`
  withBoardSnapshot(() => {}, at(2000));
  assert.equal(gh.touchedReads(), 2, "the file is gone, so the reuse is not taken -- #852's disk re-read, per item");
  withBoardSnapshot(() => {}, at(2000 + SNAPSHOT_MAX_AGE_MS));
  assert.equal(gh.touchedReads(), 3, "past the bound: a fresh read");
});

test("#1275: #399's guarantee holds on the scoped path -- a failed write means the mutation never runs", () => {
  forgetProcessSnapshot();
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: ghOf(1).run, touches: 725,
    writeFile: () => { throw new Error("read-only filesystem"); } }), /could not write the snapshot .*refusing to proceed/s);
  assert.equal(ran, false);
});

test("#1275: `touches` that names no issue refuses before gh is asked anything", () => {
  for (const touches of [[], 7.5, [725, Number.NaN]]) {
    forgetProcessSnapshot();
    const gh = ghOf(1);
    let ran = false;
    assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: gh.run, touches: touches as number[] }),
      /`touches` must name the issue\(s\) this mutation changes/);
    assert.equal(ran, false);
    assert.equal(gh.touchedReads() + gh.boardPages() + gh.readyLists(), 0, `${JSON.stringify(touches)}: no call made`);
  }
});

test("#1275: one scoped snapshot of several issues names them all, in the file and its name", () => {
  const written: Array<{ path: string; data: string }> = [];
  const path = writeScopedSnapshot([725, 726], { run: ghOf(1).run, mkdir: () => {},
    writeFile: (p: string, data: string) => { written.push({ path: p, data }); }, now: () => new Date("2026-09-13T19:00:00.000Z") });
  assert.equal(path, `${SNAPSHOT_DIR}/2026-09-13T19-00-00-000Z-issue-725-726.json`);
  assert.deepEqual(JSON.parse(written[0].data).items.map((item: { number: number }) => item.number), [725, 726]);
});
