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
  snapshotStamp,
  PROJECT_OWNER,
  PROJECT_NUMBER,
  SNAPSHOT_DIR,
} from "../../../../scripts/board-snapshot.mjs";

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
