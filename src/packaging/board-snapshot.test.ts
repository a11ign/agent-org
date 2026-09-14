// no-token: gh -- every board read and write here goes through an injected run, fetchReady, writeFile and exists; this file's own code never calls or spawns gh (#1352, route (a))
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
} from "../../../../scripts/board-snapshot.mjs";
import { touchedItemRequest, commonGitDirOf, snapshotDirFor, launchCheckoutOf, primaryLaunchRefusal, PRIMARY_MARK_KEY,
  primaryLaunchDecision, POLICY_LAUNCH_REASON_ENV }
  from "../../../../scripts/board-snapshot-scope.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync as mkdirOnDisk, rmSync, writeFileSync as writeOnDisk } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirOf, join as joinPath } from "node:path";
import { fileURLToPath as pathOf } from "node:url";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

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
  // #1352: the path is ABSOLUTE now -- the primary checkout's runs/board-snapshots, whatever tree ran this -- so the line
  // is matched against the exported directory rather than a relative literal.
  const escaped = SNAPSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(log[0], new RegExp(`wrote ${escaped}/2026-09-08T00-00-00-000Z\\.json before mutating`));
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

// --- #1275: THE WRAPPER'S ROUTE, WHICH ONLY THIS FILE CAN SHOW -------------------------------------------------
//
// The scoped snapshot itself -- its request, parsing, refusals, file and reuse -- is tested in
// board-snapshot-scope.test.ts, which imports nothing from this file so CI's acceptance job can run it. What stays
// here is the part that needs `gh`: which `gh` calls `withBoardSnapshot` actually makes.

/** Every `gh` call by command and argv: board pages answered, the ready list empty, a touched read refused. */
function recordingGh(pages: number) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let served = 0;
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args.some((arg) => arg.startsWith("issue="))) {
      throw new Error("the touched read is not served here -- board-snapshot-scope.test.ts drives it");
    }
    const cursor = served; served += 1;
    return JSON.stringify({ data: { user: { projectV2: { items: {
      pageInfo: { hasNextPage: cursor < pages - 1, endCursor: `c${cursor + 1}` },
      nodes: [{ id: `PVTI_page${cursor}`, content: { number: 10000 + cursor, title: "t", state: "OPEN" },
        fieldValues: { nodes: [{ name: "Backlog", field: { name: "Status" } }] } }],
    } } } } });
  };
  const readyLists = () => calls.filter((call) => call.args[0] === "issue" && call.args[1] === "list").length;
  const boardPages = () => calls.filter((call) => call.args.includes("graphql")
    && !call.args.some((arg) => arg.startsWith("issue="))).length;
  return { run, calls, boardPages, readyLists };
}

// `exists` is stubbed TRUE because `writeFile` is stubbed to drop the file -- see `quiet` above.
const quietIO = { mkdir: () => {}, writeFile: () => {}, log: () => {}, exists: () => true };

test("#1275 WIRING: a mutation that names its item makes ONE gh call, the scoped request -- no board page, no ready list", () => {
  forgetProcessSnapshot();
  const gh = recordingGh(6);
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: gh.run, touches: 725 }),
    /could not read Project 2's item for #725/);
  assert.deepEqual(gh.calls, [{ cmd: "gh", args: touchedItemRequest(725) }],
    "exactly the pure module's request, sent through gh by THIS file -- the gh call the pure half leaves here");
  assert.equal(ran, false, "and a refused read still means no mutation (#399)");
});

test("#1275: the same wrapper with no `touches` still sweeps the board -- what every one-item move paid before", () => {
  forgetProcessSnapshot();
  const gh = recordingGh(6);
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run });
  assert.equal(gh.boardPages(), 6, "six pages of 100 at today's 555 items -- and one more per hundred rows filed");
  assert.equal(gh.readyLists(), 1, "plus #747's ready-issue list, which `gh issue list --json` reads over GraphQL too");
});

test("#1275: a FULL snapshot this process already holds covers a scoped move, with no further gh call (#852)", () => {
  forgetProcessSnapshot();
  const gh = recordingGh(2);
  withBoardSnapshot(() => {}, { ...quietIO, run: gh.run, fetchReady: () => [] });
  const callsAfterTheSweep = gh.calls.length;
  let ran = false;
  withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: gh.run, touches: 725 });
  assert.equal(gh.calls.length, callsAfterTheSweep, "the board already covers the item");
  assert.equal(ran, true);
});

test("#1275: `touches` that names no issue refuses in the wrapper before gh is asked anything", () => {
  forgetProcessSnapshot();
  const gh = recordingGh(1);
  let ran = false;
  assert.throws(() => withBoardSnapshot(() => { ran = true; }, { ...quietIO, run: gh.run, touches: [] as number[] }),
    /`touches` must name the issue\(s\) this mutation changes/);
  assert.equal(ran, false);
  assert.equal(gh.calls.length, 0);
});

// --- #1425: the FULL route honours the same once-per-process record ---------------------------------------------------
//
// A mutation that names no item takes the full sweep. Against a Project the token cannot read, that sweep's first
// page is refused, and before #1425 every later mutation in the process asked again. The record lives in the scoped
// module, so both routes share one answer.

/** A run failing every call as CI's token does against Project 2 (#546), or with `stdout` when one is given. */
function refusingRun(message: string, stdout?: string) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    throw Object.assign(new Error(message), { status: 1, ...(stdout === undefined ? {} : { stdout }) });
  };
  return { run, calls };
}

const PROJECT_2_NOT_FOUND = JSON.stringify({ data: { user: { projectV2: null } }, errors: [{ type: "NOT_FOUND",
  path: ["user", "projectV2"], message: `Could not resolve to a ProjectV2 with the number ${PROJECT_NUMBER}.` }] });

test("#1425: 7 full-route mutations against an unreadable Project make ONE request, and none mutates", () => {
  forgetProcessSnapshot();
  const board = refusingRun("Command failed: gh api graphql", PROJECT_2_NOT_FOUND);
  let mutations = 0;
  const messages: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    try {
      withBoardSnapshot(() => { mutations += 1; }, { ...quiet, run: board.run });
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  assert.equal(board.calls.length, 1, "the first sweep's refusal is recorded, and the other six refuse from it");
  assert.equal(mutations, 0);
  assert.equal(messages.length, 7);
  for (const message of messages) {
    assert.match(message, /NOT_FOUND \(user\.projectV2\): Could not resolve to a ProjectV2 with the number 2/);
  }
  forgetProcessSnapshot();
});

test("#1425 CONTROL: a full-route failure that is NOT project-unreadable is read again on every mutation", () => {
  forgetProcessSnapshot();
  const board = refusingRun("Command failed: gh api graphql\nerror connecting to api.github.com");
  for (let i = 0; i < 3; i += 1) {
    assert.throws(() => withBoardSnapshot(() => {}, { ...quiet, run: board.run }), /could not read Project/);
  }
  assert.equal(board.calls.length, 3);
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
  const repoRoot = pathOf(new URL("../../../../", import.meta.url));
  const common = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
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

test("#1352 DONE-WHEN 1: each policy script, launched from a plain checkout, refuses before anything; from a linked worktree it does not", () => {
  const scripts = pathOf(new URL("../../../../scripts/", import.meta.url));
  const root = mkdtempSync(joinPath(tmpdir(), "policy-launch-"));
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
    for (const [script, code] of [["row-claim.mjs", 2], ["row-file.mjs", 1], ["pr-open.mjs", 1]] as const) {
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

