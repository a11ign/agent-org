// no-token: none -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): WHAT `close-rows-sweep.ts`'s `mergedPrsInWindow` ASKS OF GITHUB, AS THE PLUGIN READS IT. Moved from `src/packaging/close-rows-sweep.test.ts`, where the cases drove `mergedPrsInWindow` with an injected `gh`
 * (#394, #5076): the sweep's window, its number list and its refusal are core's and its test runs on the fake code host; the argument list the sweep's request builds (a connection of MERGED pull requests,
 * ordered by update, `main` as the base) and the reading of the answer (the base filter, `mergedAt` against the window) are the plugin's `readMergedPullRequests`, asked here with the sweep's own request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readsRowsSince, sinceAnswer } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { readMergedPullRequests } from "./rows-since.ts";

class CutShort extends Error {}
const POOL = { probe: [], fromResponse: () => null, rawResponse: () => null, fromRateLimitField: () => null };
const DEPS = { pool: POOL, WindowCutShort: CutShort };

/** A merged pull request as the connection returns it. `updatedAt` is never before `mergedAt`. */
const merged = (number: number, mergedAt: string, base = "main", updatedAt = mergedAt) => ({ number, mergedAt, updatedAt, baseRefName: base });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** The request `mergedPrsInWindow` makes for a window of `minutes`. */
const sweepRead = (minutes: number, run: (args: string[]) => string) =>
  readMergedPullRequests({ repo: "owner/repo", select: "number", run, base: "main", window: { since: new Date(Date.now() - minutes * 60_000).toISOString() } }, DEPS);

test("the sweep's merged list is the MERGED pull requests of the repository as a connection -- never a search, and never an unscoped list", () => {
  const calls: string[][] = [];
  readMergedPullRequests({ repo: "a11ign/a11ign", select: "number", run: (args) => { calls.push(args); return sinceAnswer(args, []); }, base: "main", window: { since: ago(45) } }, DEPS);
  assert.equal(calls.length, 1);
  assert.deepEqual(readsRowsSince(calls[0]), { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", label: null, repo: "a11ign/a11ign", after: null },
    "THE RISK #394 NAMES: a PR that did not merge must never be in this list at all -- proven at the query, not by a downstream filter that could be forgotten");
  assert.ok(!calls[0].includes("--search") && !calls[0].includes("--label"), "no argv is a GitHub search");
  assert.match(calls[0].find((arg) => arg.startsWith("query=")) ?? "", /nodes\{number mergedAt baseRefName updatedAt\}/, "the base and the merge time are asked for, since the filters read them");
});

test("the window is read by each pull request's own `mergedAt`: a merge before it is not returned, one inside it is, and a row only UPDATED inside it is not", () => {
  const rows = [merged(3, ago(5)), merged(2, ago(40)), merged(9, ago(600), "main", ago(1)), merged(1, ago(50), "main", ago(30))];
  assert.deepEqual(sweepRead(45, (args) => sinceAnswer(args, rows)).map((pr) => pr.number), [3, 2],
    "#9 was merged ten hours ago and updated a minute ago (a comment): read, and dropped by its own mergedAt; #1 merged 50 minutes ago is outside a 45 minute window");
});

test("only pull requests merged into `main` are returned (the base filter is kept)", () => {
  const rows = [merged(5, ago(2), "main"), merged(6, ago(3), "release"), merged(7, ago(4), "main")];
  assert.deepEqual(sweepRead(45, (args) => sinceAnswer(args, rows)).map((pr) => pr.number), [5, 7]);
});

test("a read that fails THROWS, and an answer that is not JSON throws: never an empty list that reads as 'nothing merged' (negative control)", () => {
  assert.throws(() => sweepRead(45, () => { throw new Error("gh: 502"); }), /gh: 502/);
  assert.throws(() => sweepRead(45, () => "not json"), SyntaxError);
  assert.deepEqual(sweepRead(45, (args) => sinceAnswer(args, [])), [], "control: an answered empty window IS []");
});
