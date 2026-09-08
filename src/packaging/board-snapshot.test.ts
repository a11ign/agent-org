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
  writeBoardSnapshot,
  withBoardSnapshot,
  snapshotStamp,
  PROJECT_OWNER,
  PROJECT_NUMBER,
  SNAPSHOT_DIR,
} from "../../../../scripts/board-snapshot.mjs";

/** One page of a real `gh api graphql` response, shaped exactly like the live schema returns it. */
function page({ nodes, hasNextPage = false, endCursor = null }: {
  nodes: Array<{ id: string; number?: number; title?: string; status?: string }>;
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
              content: n.number !== undefined ? { number: n.number, title: n.title ?? "" } : null,
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
  const items = fetchBoardItems({ run });
  assert.deepEqual(items, [{ itemId: "PVTI_1", number: 42, title: "the row", status: "Ready" }]);
});

test("a draft item (no linked issue) is recorded with number/title null, never dropped", () => {
  const run = () => page({ nodes: [{ id: "PVTI_draft" }] });
  const items = fetchBoardItems({ run });
  assert.deepEqual(items, [{ itemId: "PVTI_draft", number: null, title: null, status: null }]);
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
  const items = fetchBoardItems({ run });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.number), [1, 2]);
});

test("fetchBoardItems throws rather than returning a partial list when gh fails", () => {
  const run = () => {
    throw new Error("gh: not authenticated");
  };
  assert.throws(() => fetchBoardItems({ run }), /could not read Project/);
});

test("fetchBoardItems throws on a response missing the expected shape, rather than guessing", () => {
  const run = () => JSON.stringify({ data: { user: { projectV2: null } } });
  assert.throws(() => fetchBoardItems({ run }), /did not have the shape/);
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
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_1", number: 42, title: "row", status: "Ready" }]);
});

test("writeBoardSnapshot throws, never swallows, when the fetch fails", () => {
  const run = () => {
    throw new Error("network unreachable");
  };
  assert.throws(() => writeBoardSnapshot({ run, mkdir: () => {}, writeFile: () => {} }),
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
