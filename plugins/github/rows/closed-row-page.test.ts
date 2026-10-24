// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE QUERY AND THE READING OF THE CLOSED-ROW PAGE `settle-closed-rows.ts` WALKS, which core's test of the pass used to assert (`src/packaging/settle-closed-status.test.ts`) and which are the plugin's now
 * (core's tests of the walk run on the fake code host's pages). The argument lists are copied from `closedRowsPageQuery`, as it stood in `src/settle-closed-status.ts`.
 *
 * #2081, ON REVIEW, THEN #2719 REPLACED THE READ ENTIRELY: THE FLOOR'S POPULATION IS A POPULATION, NOT A PAGE, AND NOT A CAPPED SEARCH EITHER. A cursor walk of `repository.issues(states: CLOSED)` is not capped by
 * GitHub, so the page is read per issue (the connection has no `project:` qualifier) and every shape it would have to guess at is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_ROWS_QUERY, closedRowPageOf, closedRowsPageFromRead, closedRowsPageQuery } from "./closed-row-page.ts";

/** The Project the pass narrows to, as the caller names it. */
const PROJECT = 1;

/** One page of `closedRowsPageQuery`'s response, in the shape `gh api graphql` returns it. */
const closedRowsPage = (
  entries: { number: number; projectNumbers?: number[]; totalCount?: number }[],
  { hasNextPage = false, endCursor = null as string | null } = {},
) => JSON.stringify({
  data: { repository: { issues: {
    pageInfo: { hasNextPage, endCursor },
    nodes: entries.map(({ number, projectNumbers = [PROJECT], totalCount }) => ({
      number,
      projectItems: { totalCount: totalCount ?? projectNumbers.length,
        nodes: projectNumbers.map((n) => ({ project: { number: n } })) },
    })),
  } } },
});

test("#2081/#2719 the floor's population read names the repository it is given, and walks by cursor", () => {
  assert.deepEqual(closedRowsPageQuery({ owner: "a11ign", name: "a11ign", after: null }), [
    "api", "graphql", "-f", `query=${CLOSED_ROWS_QUERY}`, "-F", "owner=a11ign", "-F", "name=a11ign",
  ]);
  const withCursor = closedRowsPageQuery({ owner: "a11ign", name: "a11ign", after: "cursor-1" });
  assert.deepEqual(withCursor.slice(-2), ["-f", "after=cursor-1"], "a second page names its cursor, never re-asking for the first");
  assert.match(withCursor.join(" "), /issues\(states: CLOSED/, "CLOSED, never OPEN or ALL -- this pass's population is rows GitHub already reports closed");
  assert.equal(withCursor.join(" ").includes("pullRequests"), false,
    "and it is `repository.issues`, never `repository.pullRequests` -- a PR read is what makes a hand-closed row invisible, which is all of #2081");
});

test("the page operation asks that argument list through the run it is given, and reads the answer for the project it is given", () => {
  const seen: string[][] = [];
  const run = (args: string[]): string => { seen.push(args); return closedRowsPage([{ number: 100 }, { number: 101, projectNumbers: [99] }], { hasNextPage: true, endCursor: "next" }); };
  assert.deepEqual(closedRowPageOf({ owner: "o", name: "r", after: "c0", projectNumber: PROJECT, run }), { numbers: [100], hasNextPage: true, endCursor: "next" });
  assert.deepEqual(seen, [closedRowsPageQuery({ owner: "o", name: "r", after: "c0" })]);
  assert.throws(() => closedRowPageOf({ owner: "o", name: "r", after: null, projectNumber: PROJECT, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/, "a refused read THROWS, never an empty page");
});

test("#2081/#2719 a page is narrowed to THIS Project, per issue, because the connection has no `project:` filter", () => {
  const page = closedRowsPage([
    { number: 100, projectNumbers: [PROJECT] },
    { number: 101, projectNumbers: [99] },
    { number: 102, projectNumbers: [] },
  ]);
  const result = closedRowsPageFromRead(page, PROJECT);
  assert.deepEqual(result.numbers, [100],
    "an item on some OTHER project, or on none, is excluded -- membership is read PER ISSUE because `repository.issues` carries no `project:` qualifier the way the old search did");
  assert.equal(result.hasNextPage, false);
  assert.equal(result.endCursor, null);
});

test("#2081/#2719 the walk's own cursor contract: `hasNextPage`/`endCursor` pass through untouched", () => {
  const result = closedRowsPageFromRead(closedRowsPage([{ number: 1 }], { hasNextPage: true, endCursor: "abc123" }), PROJECT);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.endCursor, "abc123");
});

test("#2081/#2719 an issue whose Project membership could not be read completely REFUSES rather than guesses", () => {
  // `projectItems(first: 10)` came back with fewer nodes than `totalCount`, and none of the ones it did fetch name this Project -- the eleventh could, and guessing either way is the defect the floor exists
  // to catch, arriving through its own per-issue read.
  const page = closedRowsPage([{ number: 200, projectNumbers: [99], totalCount: 11 }]);
  assert.throws(() => closedRowsPageFromRead(page, PROJECT), /#200's Project membership could not be read completely/,
    "NAMED by row number: a silent guess here is the same defect the old sample-vs-population bug was, arriving through the per-issue read instead of the per-page one");
  assert.deepEqual(closedRowsPageFromRead(closedRowsPage([{ number: 201, projectNumbers: [PROJECT], totalCount: 11 }]), PROJECT).numbers, [201],
    "CONTROL: the same short membership that DOES name the Project is on it, whatever the rest of the total holds");
});

test("#2727 an issue node with no `projectItems` at all REFUSES rather than defaulting to an empty, complete list", () => {
  // reviewer-2727's blocker: `closedRowsPageFromRead` used to default a missing `projectItems` to an empty `nodes` array and a `totalCount` of 0, which reads as `complete` with zero matches -- silently reporting
  // "not on this board" for a row whose membership was never actually fetched, undercounting the floor.
  const page = JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 300 }] } } } });
  assert.throws(() => closedRowsPageFromRead(page, PROJECT),
    /#300's Project membership came back in an unexpected shape -- refusing to default it to an empty, complete list/,
    "NAMED by row number: a missing `projectItems` must refuse, the same as one with fewer nodes than `totalCount` -- both are membership this read never actually established");
});

test("#2081/#2719 the floor refuses every response shape it would otherwise have to guess at", () => {
  assert.throws(() => closedRowsPageFromRead("not json at all", PROJECT), /was not JSON -- refusing to guess/);
  assert.throws(() => closedRowsPageFromRead(JSON.stringify({ errors: [{ message: "rate limited" }] }), PROJECT), /came back with errors -- refusing to guess/);
  assert.throws(() => closedRowsPageFromRead(JSON.stringify({ data: {} }), PROJECT), /was not the expected shape -- refusing to guess/);
  assert.throws(() => closedRowsPageFromRead(
    JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ title: "no number" }] } } } }), PROJECT),
    /entry 0 has no number -- refusing to guess/,
    "NAMED by position: this list is the only thing that can tell a complete board read from a partial one, so a list the parser had to guess at would make the floor report clean over a population it never established");
});
