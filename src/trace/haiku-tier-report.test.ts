// a11ign/agent-org#689: the Haiku trial report's reading of a closing pull request. Fixtures only: the issue shape is what `gh issue list --json closedByPullRequestsReferences` returns
// (keys `id,name,owner` on the repository, `id,login` on the owner, NO `nameWithOwner`; agent-org#530), the store events are built here, and nothing reaches `gh` or the store.
// no-token: gh -- `closedRowOrUnresolved` and `reportLines` are pure over their arguments
import assert from "node:assert/strict";
import { test } from "node:test";
import { HAIKU_MODEL_ID, HAIKU_TIER_LABEL } from "../worker-profile.ts";
import { closedRowOf, closedRowOrUnresolved, closersOf, measuresOf, reportLines } from "./haiku-tier-report.ts";
import type { TraceEvent } from "./store.ts";

const T0 = Date.UTC(2026, 9, 10);
const HOUR = 3_600_000;
const REPO = "a11ign/agent-org";
const closedAt = new Date(T0 + HOUR).toISOString();

/** The repository exactly as the Open-check on the row printed it: `keys` is `["id","name","owner"]`. */
const ghRepository = { id: "R_kgDOfixture", name: "agent-org", owner: { id: "O_kgDOfixture", login: "a11ign" } };
const ghIssue = (number: number, closer?: { number: number; repository?: object }, labels = [{ name: HAIKU_TIER_LABEL }]) =>
  ({ number, labels, closedAt, ...(closer ? { closedByPullRequestsReferences: [closer] } : {}) });

/** What the store holds for one row: a Haiku turn (it starts the window) and, if `merged`, the merge of its pull request under the repo the event id carries. */
const stored = (number: number, merged: boolean): TraceEvent[] => [
  { id: `t${number}`, kind: "turn", source: "transcript", at: T0 + number, session: `worker-${number}`, row: number, pr: null, repo: null, model: HAIKU_MODEL_ID,
    tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
  ...(merged ? [{ id: `gh:${REPO}#${number}:merged:m`, kind: "merged", source: "github", at: T0, session: "github", row: null, pr: number, repo: null }] : []),
] as unknown as TraceEvent[];

const report = (issues: ReturnType<typeof ghIssue>[], events: TraceEvent[]) =>
  reportLines({ closed: issues.map(closedRowOrUnresolved), events, now: T0 + 2 * HOUR });
/** The header line of the `tier:haiku` block. */
const haikuHeader = (lines: string[]) => lines[lines.indexOf(`${HAIKU_TIER_LABEL} rows:`) + 1];
const firstPass = (lines: string[]) => lines.find((line) => line.startsWith("  first-pass merge:"));

test("the closing pull request's repo is read from owner.login and name, so its merge is found; the bare name finds none", () => {
  const row = closedRowOrUnresolved(ghIssue(10, { number: 100, repository: ghRepository }));
  assert.deepEqual(row.pr, { repo: REPO, number: 100 });
  assert.equal(row.unresolved, false);
  const events = stored(100, true);
  assert.equal(measuresOf(row, events).merged, true);
  assert.match(haikuHeader(report([ghIssue(100, { number: 100, repository: ghRepository })], events)), /\(1 with a merged pull request, 0 with no closing pull request, 0 unresolved\)/);
  // NEGATIVE CONTROL: the expression this row replaced, `nameWithOwner ?? name`, on the same repository.
  const old = (ghRepository as { nameWithOwner?: string }).nameWithOwner ?? ghRepository.name;
  assert.equal(old, "agent-org");
  assert.equal(measuresOf({ ...row, pr: { repo: old, number: 100 } }, events).merged, false);
});

test("a nameWithOwner a reader supplies is kept over owner.login and name", () => {
  const row = closedRowOrUnresolved(ghIssue(11, { number: 110, repository: { nameWithOwner: "other/lab", name: "lab", owner: { login: "someone" } } }));
  assert.deepEqual(row.pr, { repo: "other/lab", number: 110 });
});

test("a row with no closing pull request is counted apart, as neither merged nor unresolved", () => {
  const lines = report([ghIssue(20, undefined), ghIssue(21, { number: 21, repository: ghRepository })], [...stored(20, false), ...stored(21, true)]);
  assert.match(haikuHeader(lines), /n=2 closed \(1 with a merged pull request, 1 with no closing pull request, 0 unresolved\)/);
  const row = closedRowOrUnresolved(ghIssue(20, undefined));
  assert.deepEqual({ pr: row.pr, unresolved: row.unresolved }, { pr: null, unresolved: false });
  assert.deepEqual(closersOf([row]), { noPr: 1, unresolved: 0 });
});

test("a closing pull request whose repository cannot be read is counted as unresolved, and 'none merged' says it is not a reading", () => {
  const unreadable = { number: 300, repository: { id: "R_kgDOfixture", name: "agent-org" } };
  const row = closedRowOrUnresolved(ghIssue(30, unreadable));
  assert.deepEqual({ pr: row.pr, unresolved: row.unresolved }, { pr: null, unresolved: true });
  assert.deepEqual(closersOf([row]), { noPr: 0, unresolved: 1 });
  const lines = report([ghIssue(30, unreadable)], stored(30, false));
  assert.match(haikuHeader(lines), /n=1 closed \(0 with a merged pull request, 0 with no closing pull request, 1 unresolved\)/);
  assert.match(firstPass(lines) ?? "", /none merged \(1 unresolved, so not a reading\)/);
  // POSITIVE CONTROL: the same row with no closing pull request at all is the plain "none merged", so the line above comes from the count and not from the wording.
  const plain = report([ghIssue(30, undefined)], stored(30, false));
  assert.equal(firstPass(plain), "  first-pass merge: none merged");
  assert.match(haikuHeader(plain), /0 unresolved\)/);
});

test("an unresolved row is counted in its own arm only", () => {
  const unreadable = { number: 400, repository: { name: "agent-org" } };
  const lines = report([ghIssue(40, { number: 40, repository: ghRepository }), ghIssue(41, unreadable, [{ name: "ready" }])], [...stored(40, true), ...stored(41, false)]);
  const other = lines.indexOf("other rows closed in the same window:");
  assert.match(haikuHeader(lines), /1 with a merged pull request, 0 with no closing pull request, 0 unresolved/);
  assert.match(lines[other + 1], /n=1 closed \(0 with a merged pull request, 0 with no closing pull request, 1 unresolved\)/);
});

test("the strict reader still refuses an unreadable repository, naming the row and the keys it saw", () => {
  assert.throws(() => closedRowOf(ghIssue(7, { number: 70, repository: { name: "lab" } })), /#7: .*no repository.*keys: name/);
  assert.throws(() => closedRowOf(ghIssue(8, { number: 80 })), /#8: .*keys: none/);
});
