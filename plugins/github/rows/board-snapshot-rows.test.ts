// no-token: none -- `run` records the argument list and answers a captured response: no GitHub CLI runs
/**
 * A11-160 (step 8): THE QUERIES THE BOARD'S SNAPSHOT SENDS, AND WHAT THEY ANSWER, in GitHub's own words. What the snapshot DECIDES of the pages and items it reads (the coverage floor, the Status refusal, the scoped and the reused
 * route, the memory of a Project the token cannot read) is core's and its tests run on the fake code host (`src/packaging/board-snapshot.test.ts`, `src/packaging/board-snapshot-scope.test.ts`); the query's shape and its
 * variables, `-F` against `-f`, the cursor, the error body a failed process carries on its stdout and the shape of the responses are the operations', `boardItemsPageOf` and `touchedItemTextOf`, and are held here (moved from those
 * two files, where they were asserted over a stubbed `gh`).
 *
 * The three CAPTURED responses are what the touched-item query itself returned live on 2026-09-13/18 (gh 2.100.0), verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../../src/plugins/fakes/code-host.ts";
import { fakeRow } from "../../../src/plugins/fakes/code-host-rows.ts";
import { boardItemsPageOf, touchedItemTextOf } from "./board-rows.ts";
import { readRowsByLabel } from "./rows-by-label.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: string) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer; } };
};

/** The variables of a request: its argument list past `api graphql` without the query and the flag that carries it. */
const variablesOf = (args: string[]): string[] => args.slice(2).filter((arg, at, all) => !arg.startsWith("query=") && !all[at + 1]?.startsWith("query="));

/** The `query=` argument that was sent, pulled off the argv. */
const sentQuery = (args: string[]): string => args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";

/**
 * Captured LIVE 2026-09-18 against the ORG board: #1452, on `a11ign/projects/1` at "Ready". (It was #1275 on Project 2, and could not simply be re-pointed: on the org board #1275 has no item at all, so it cannot stand for an issue
 * ON the board. The subject moved to an issue that is on it, and the old capture went with the board it described.)
 */
const CAPTURED_ON_BOARD = "{\"data\":{\"organization\":{\"projectV2\":{\"id\":\"PVT_kwDOExeOA84Bj5SX\"}},\"repository\":{\"issue\":{\"number\":1452,\"title\":\"release.yml's dry run cannot print versions when dispatched on a branch: changeset status needs main (Failed to find where HEAD diverged from main, run 34783509737) -- or the job must say so before the gate\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lADOExeOA84Bj5SXzg7knyc\",\"project\":{\"number\":1},\"fieldValueByName\":{\"name\":\"Ready\"}}]}}}}}";
/** Captured: #393, closed and never added to Project 2 -- the row #400's not-on-board wording was measured on. */
const CAPTURED_OFF_BOARD = "{\"data\":{\"organization\":{\"projectV2\":{\"id\":\"PVT_kwDOExeOA84Bj5SX\"}},\"repository\":{\"issue\":{\"number\":393,\"title\":\"pre-push hook runs doc-references.test.ts without generating docs/coverage.md first, unlike CI's docs job\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}}}";
/** Captured: the same query naming project 999. `gh` exited 1 and printed this on stdout. */
const CAPTURED_NO_PROJECT = "{\"data\":{\"organization\":{\"projectV2\":null},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}},\"errors\":[{\"type\":\"NOT_FOUND\",\"path\":[\"organization\",\"projectV2\"],\"locations\":[{\"line\":3,\"column\":27}],\"message\":\"Could not resolve to a ProjectV2 with the number 999.\"}]}";

/** A page of the items query as the live schema returns it: one issue item at a Status, a draft item, and the Status field's options. */
const PAGE_SAMPLE = JSON.stringify({ data: { organization: { projectV2: { field: { options: [{ name: "Ready" }], },
  items: { pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" }, nodes: [
    { id: "PVTI_a", content: { number: 42, title: "the row", state: "OPEN" }, fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }] } }] } } } } });

/** Keys and value types, recursively -- what a rendered response must share with the live response it stands in for. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return value === null ? "null" : typeof value;
}

// --- the items page ---------------------------------------------------------------------------------------------------------------

test("the items page is ONE GraphQL query with the owner as a string, the project number as an integer (`-F`), and no cursor on the first page", () => {
  const { seen, run } = recording(PAGE_SAMPLE);
  assert.equal(boardItemsPageOf({ owner: "a11ign", number: 1, cursor: null, run }), PAGE_SAMPLE, "the text GitHub answered, unparsed: the snapshot reads it");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 2), ["api", "graphql"]);
  assert.deepEqual(variablesOf(seen[0]), ["-f", "owner=a11ign", "-F", "number=1"]);
  assert.ok(!seen[0].some((arg) => arg.startsWith("cursor=")), "the first page must not pass a cursor");
  assert.match(sentQuery(seen[0]), /query\(\$owner: String!, \$number: Int!, \$cursor: String\)/, "the number is an Int, which is why it is `-F`");
});

test("a later page passes the cursor back as a string variable (`-f`), and nothing else changes", () => {
  const first = recording(PAGE_SAMPLE);
  boardItemsPageOf({ owner: "a11ign", number: 1, cursor: null, run: first.run });
  const { seen, run } = recording(PAGE_SAMPLE);
  boardItemsPageOf({ owner: "a11ign", number: 1, cursor: "CUR", run });
  assert.deepEqual(seen[0], [...first.seen[0], "-f", "cursor=CUR"], "the second page passes back the first page's endCursor, after the same arguments");
});

/** The query the items page sends. */
const itemsQuery = (): string => {
  const { seen, run } = recording(PAGE_SAMPLE);
  boardItemsPageOf({ owner: "a11ign", number: 1, cursor: null, run });
  return sentQuery(seen[0]);
};

/** The query one touched item's read sends. */
const touchedQuery = (): string => {
  const { seen, run } = recording(CAPTURED_ON_BOARD);
  touchedItemTextOf({ owner: "a11ign", repo: "a11ign/a11ign", project: 1, issue: 1, run });
  return sentQuery(seen[0]);
};

test("#1996: the items query ASKS for the Status field's options, a hundred items with their number, title, state and Status, and the page info the next page needs", () => {
  // THE MUTANT THIS KILLS: deleting the `field(name: "Status")` selection. The snapshot's drift check can only ever run on a board whose option list was REQUESTED; a query that stops selecting it takes the
  // short-read branch on every real board, silently. (Core's cases answer from the world; only the request can show this.)
  const query = itemsQuery();
  for (const pattern of [/field\(name: "Status"\)[\s\S]*?options\s*\{[\s\S]*?\bname\b/, /items\(first: 100, after: \$cursor\)/, /pageInfo \{ hasNextPage endCursor \}/, /content \{ \.\.\. on Issue \{ number title state \} \}/,
    /fieldValues\(first: 20\)/, /\.\.\. on ProjectV2ItemFieldSingleSelectValue \{\s+name\s+field \{ \.\.\. on ProjectV2FieldCommon \{ name \} \}/, /organization\(login: \$owner\) \{\s+projectV2\(number: \$number\)/]) {
    assert.match(query, pattern);
  }
});

test("a refused page throws what the process threw, with GraphQL's own error body still on its stdout (#555): the exit message never carries it", () => {
  const body = JSON.stringify({ errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2"], message: "Resource not accessible by personal access token" }] });
  const refusal = Object.assign(new Error("Command failed: gh api graphql ..."), { status: 1, stdout: body, stderr: "gh: Resource not accessible by personal access token\n" });
  assert.throws(() => boardItemsPageOf({ owner: "a11ign", number: 1, cursor: null, run: () => { throw refusal; } }), (error: unknown) => error === refusal && (error as { stdout: string }).stdout === body);
});

// --- one issue's item and the project ----------------------------------------------------------------------------------------------

test("#1275: the request for one touched issue is the query and its four variables, the repository's NAME split off its owner, the numbers as integers (`-F`) -- and it never names gh", () => {
  const { seen, run } = recording(CAPTURED_ON_BOARD);
  assert.equal(touchedItemTextOf({ owner: "a11ign", repo: "a11ign/agent-org", project: 1, issue: 1275, run }), CAPTURED_ON_BOARD, "the text GitHub answered, unparsed");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 2), ["api", "graphql"]);
  assert.deepEqual(variablesOf(seen[0]), ["-f", "owner=a11ign", "-f", "name=agent-org", "-F", "project=1", "-F", "issue=1275"]);
  assert.ok(!seen[0].includes("gh"), "the caller's runner adds the program");
});

test("#1275: the touched query NAMES THE PROJECT (whose refusal the close path classifies) and asks for the count a short list is checked against", () => {
  const query = touchedQuery();
  for (const pattern of [/organization\(login: \$owner\) \{ projectV2\(number: \$project\) \{ id \} \}/, /projectItems\(first: 10\) \{\s+totalCount/, /fieldValueByName\(name: "Status"\)/, /project \{ number \}/]) {
    assert.match(query, pattern);
  }
});

test("#1275: a Project the token cannot read is a thrown refusal whose failed process carries GraphQL's NOT_FOUND on stdout", () => {
  const refusal = Object.assign(new Error("Command failed: gh api graphql ..."), { status: 1, stdout: CAPTURED_NO_PROJECT });
  assert.throws(() => touchedItemTextOf({ owner: "a11ign", repo: "a11ign/a11ign", project: 999, issue: 1275, run: () => { throw refusal; } }),
    (error: unknown) => error === refusal && JSON.parse((error as { stdout: string }).stdout).errors[0].message === "Could not resolve to a ProjectV2 with the number 999.");
});

// --- the ready list the floor is checked against ------------------------------------------------------------------------------------

test("fetchReadyIssueNumbers' read (#5076): the OPEN rows labelled ready are a CONNECTION with the label as a variable, never a `--label` search, and the one field read is the number", () => {
  const { seen, run } = recording(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 717 }, { number: 725 }] } } } }));
  const nodes = readRowsByLabel({ label: "ready", state: "OPEN", select: "number", repo: "a11ign/a11ign", run }, {} as never);
  assert.deepEqual(nodes, [{ number: 717 }, { number: 725 }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(seen[0].includes("label=ready"), "the label is a variable of the connection");
  assert.ok(!seen[0].includes("--label") && !seen[0].includes("--search"), "a connection read: no argv is a GitHub search");
  assert.ok(seen[0].some((arg) => arg.startsWith("query=") && arg.includes("issues(states:OPEN,labels:[$label]") && arg.includes("nodes{number}")), "OPEN rows only, and the one field read is the number");
});

test("a response that is not a connection is refused by the read, naming the label, rather than guessed at (the snapshot wraps it and refuses to check coverage against it)", () => {
  assert.throws(() => readRowsByLabel({ label: "ready", state: "OPEN", select: "number", run: () => JSON.stringify({ not: "a list" }) }, {} as never), /rows labelled ready did not come back as a connection/);
});

// --- the fake renders what GitHub answers -------------------------------------------------------------------------------------------

test("the fake code host renders the shape the queries returned live -- the touched read on and off the board, and a page of items -- so a core test seeded from rows reads a response that can occur", () => {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.rows.set(1452, fakeRow(world, 1452, { onBoard: true, boardStatus: "Ready" }));
  world.rows.set(393, fakeRow(world, 393, { state: "CLOSED" }));
  world.rows.set(42, fakeRow(world, 42, { onBoard: true, boardStatus: "Ready" }));
  const noRun = (): string => { throw new Error("the fake ignores the run it is handed"); };
  const touched = (issue: number) => JSON.parse(host.rows!.touchedItemTextOf({ owner: "a11ign", repo: "a11ign/a11ign", project: 1, issue, run: noRun }));
  assert.deepEqual(shapeOf(touched(1452)), shapeOf(JSON.parse(CAPTURED_ON_BOARD)));
  assert.deepEqual(shapeOf(touched(393)), shapeOf(JSON.parse(CAPTURED_OFF_BOARD)));
  assert.equal(touched(1452).data.repository.issue.projectItems.nodes[0].fieldValueByName.name, "Ready");
  world.reports.snapshot.project.statusOptions = ["Ready"];
  world.rows.delete(1452);
  const page = JSON.parse(host.rows!.boardItemsPageOf({ owner: "a11ign", number: 1, cursor: null, run: noRun }));
  assert.deepEqual(shapeOf(page.data.organization.projectV2.field), shapeOf(JSON.parse(PAGE_SAMPLE).data.organization.projectV2.field));
  assert.deepEqual(shapeOf(page.data.organization.projectV2.items.nodes), shapeOf(JSON.parse(PAGE_SAMPLE).data.organization.projectV2.items.nodes));
  assert.deepEqual(Object.keys(page.data.organization.projectV2.items.pageInfo).sort(), ["endCursor", "hasNextPage"]);
});
