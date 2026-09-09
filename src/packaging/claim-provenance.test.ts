/**
 * #683: a CLOSED row must still answer "who worked this". The `session:<name>` label is correctly removed
 * when a row closes, and the row read that as attribution being DESTROYED — but GitHub keeps the
 * `LabeledEvent` that applied the label forever, so the record survives the label. See
 * `scripts/claim-provenance.mjs`'s header for the measurement that decided the build: 189 of 295 closed
 * rows still name their claimant, and 77 of the 83 sitting behind a branch with no open PR — and for why
 * this reads the repository's own event log rather than GitHub's GraphQL timeline, which narrows a
 * nested history AND the `totalCount` describing it, so no assertion on the response can see it.
 *
 * THE MUTATION THE ROW ASKS FOR IS THE LAST TEST IN THE FIRST GROUP: take the record away, and the row
 * must be reported UNATTRIBUTABLE BY NAME. "Nobody claimed this" and "the record is missing" produced the
 * identical blank before this existed, and they are different states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimsFromEvents, describeClaims, unattributableClosedRows, parseEventLines, labelEventsByIssue,
  parseClosedRows, claimsWithNoEvent, fetchClosedRowEvents, PROVENANCE_REQUIRED_FROM,
} from "../../../../scripts/claim-provenance.mjs";

const row = (number: number, closedAt: string, events: unknown[] = []) =>
  ({ number, title: `row ${number}`, closedAt, events }) as never;
const ev = (event: "labeled" | "unlabeled", label: string, at: string) => ({ event, label, at });

// --- claimsFromEvents: pure ---

test("a claim applied and later removed yields the session and the window it was held", () => {
  const claims = claimsFromEvents([
    ev("labeled", "session:worker-judge", "2026-09-09T10:51:34Z"),
    ev("unlabeled", "session:worker-judge", "2026-09-09T11:15:47Z"),
  ] as never);
  assert.deepEqual(claims,
    [{ session: "worker-judge", from: "2026-09-09T10:51:34Z", to: "2026-09-09T11:15:47Z" }]);
});

test("a claim whose label is still on the row has an OPEN window, not an unknown one", () => {
  const claims = claimsFromEvents([ev("labeled", "session:dispatcher", "2026-09-09T09:00:00Z")] as never);
  assert.deepEqual(claims, [{ session: "dispatcher", from: "2026-09-09T09:00:00Z", to: null }]);
});

test("claim, decline, re-claim is TWO windows -- the gap is where another session could have held it", () => {
  const claims = claimsFromEvents([
    ev("labeled", "session:worker-audit", "2026-09-09T08:00:00Z"),
    ev("unlabeled", "session:worker-audit", "2026-09-09T09:00:00Z"),
    ev("labeled", "session:worker-audit", "2026-09-09T11:00:00Z"),
  ] as never);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((c) => c.to), ["2026-09-09T09:00:00Z", null]);
});

test("events arriving out of order are ordered by time, not by position", () => {
  const claims = claimsFromEvents([
    ev("unlabeled", "session:worker-config", "2026-09-09T12:00:00Z"),
    ev("labeled", "session:worker-config", "2026-09-09T11:00:00Z"),
  ] as never);
  assert.deepEqual(claims,
    [{ session: "worker-config", from: "2026-09-09T11:00:00Z", to: "2026-09-09T12:00:00Z" }]);
});

test("two sessions on one row keep their own windows rather than merging into one", () => {
  const claims = claimsFromEvents([
    ev("labeled", "session:worker-audit", "2026-09-09T08:00:00Z"),
    ev("labeled", "session:orchestrator", "2026-09-09T08:30:00Z"),
    ev("unlabeled", "session:worker-audit", "2026-09-09T09:00:00Z"),
  ] as never);
  assert.deepEqual(claims.map((c) => [c.session, c.to]),
    [["worker-audit", "2026-09-09T09:00:00Z"], ["orchestrator", null]]);
});

test("non-session label events are not claims -- `ready` coming off is not somebody taking the row", () => {
  assert.deepEqual(claimsFromEvents([
    ev("labeled", "backlog", "2026-09-09T08:00:00Z"),
    ev("unlabeled", "ready", "2026-09-09T08:30:00Z"),
  ] as never), []);
});

test("THE MUTATION: with the record gone the row is reported unattributable BY NAME, never skipped", () => {
  const rows = [
    row(1, "2026-09-09T14:00:00Z", [ev("labeled", "session:worker-judge", "2026-09-09T13:00:00Z")]),
    row(2, "2026-09-09T14:00:00Z", []),
  ];
  const found = unattributableClosedRows(rows as never, { since: PROVENANCE_REQUIRED_FROM });
  assert.deepEqual(found.map((r) => r.number), [2]);
  assert.match(describeClaims(claimsFromEvents(found[0]!.events)), /UNATTRIBUTABLE/);
});

test("a row that DOES name its claimant renders the session, the window and no refusal wording", () => {
  const rendered = describeClaims(claimsFromEvents([
    ev("labeled", "session:product-manager", "2026-09-09T12:28:18Z"),
    ev("unlabeled", "session:product-manager", "2026-09-09T13:05:00Z"),
  ] as never));
  assert.equal(rendered,
    "claimed by product-manager from 2026-09-09T12:28:18Z to 2026-09-09T13:05:00Z");
  assert.doesNotMatch(rendered, /UNATTRIBUTABLE/);
});

// --- the gate boundary: history is REPORTED, new rows are GATED ---

test("a row closed BEFORE the boundary is out of the gated population, however unattributable", () => {
  const rows = [row(3, "2026-09-08T09:00:00Z", [])];
  assert.deepEqual(unattributableClosedRows(rows as never, { since: PROVENANCE_REQUIRED_FROM }), []);
  assert.deepEqual(unattributableClosedRows(rows as never).map((r) => r.number), [3],
    "and it is still in the census, so the historical count stays visible");
});

test("a row closed AFTER the boundary with no claim event is a finding", () => {
  const rows = [row(4, "2026-09-10T09:00:00Z", [])];
  assert.deepEqual(unattributableClosedRows(rows as never, { since: PROVENANCE_REQUIRED_FROM })
    .map((r) => r.number), [4]);
});

// --- reading the event log: every unrecognised shape THROWS ---

const line = (number: number, event: string, label: string, at: string) =>
  JSON.stringify({ number, event, label, at });

test("line-delimited events parse, and blank lines between pages are not events", () => {
  const parsed = parseEventLines(
    `${line(1, "labeled", "session:a", "2026-09-09T10:00:00Z")}\n\n${line(1, "unlabeled", "session:a", "2026-09-09T11:00:00Z")}\n`);
  assert.equal(parsed.length, 2);
});

test("a line that is not JSON THROWS -- skipping it drops a claim and mislabels its row", () => {
  assert.throws(() => parseEventLines("not json"), /was not JSON/);
});

test("events group by issue number, keeping both kinds", () => {
  const grouped = labelEventsByIssue(parseEventLines(
    `${line(7, "labeled", "session:a", "2026-09-09T10:00:00Z")}\n${line(8, "labeled", "ready", "2026-09-09T10:00:00Z")}`));
  assert.deepEqual([...grouped.keys()], [7, 8]);
  assert.equal(grouped.get(7)![0]!.label, "session:a");
});

test("an event missing its issue, label, kind or time THROWS rather than being dropped", () => {
  assert.throws(() => labelEventsByIssue([{ number: 1, event: "labeled", label: "x" }]), /refusing to guess/);
  assert.throws(() => labelEventsByIssue([{ number: 1, event: "assigned", label: "x", at: "t" }]), /refusing to guess/);
});

test("a closed-row listing of exactly the limit THROWS -- truncation is indistinguishable from a fit", () => {
  const rows = JSON.stringify([{ number: 1, title: "a", closedAt: "2026-09-09T10:00:00Z" }]);
  assert.throws(() => parseClosedRows(rows, 1), /exactly the requested limit/);
  assert.equal(parseClosedRows(rows, 2).length, 1);
});

test("a closed row missing closedAt THROWS -- the boundary cannot be applied to an unknown time", () => {
  assert.throws(() => parseClosedRows(JSON.stringify([{ number: 1, title: "a" }]), 10),
    /number\/title\/closedAt/);
});

// --- the floor: the search asserts about ITSELF ---

test("THE FLOOR: a live session label whose applying event is absent means the log is SHORT", () => {
  const byNumber = labelEventsByIssue(parseEventLines(line(1, "labeled", "session:a", "2026-09-09T10:00:00Z")));
  assert.deepEqual(claimsWithNoEvent([{ number: 1, labels: ["session:a"] }], byNumber), []);
  assert.deepEqual(claimsWithNoEvent([{ number: 2, labels: ["session:b"] }], byNumber), [2]);
});

test("a row carrying no session label is not held to the floor", () => {
  assert.deepEqual(claimsWithNoEvent([{ number: 3, labels: ["ready"] }], new Map()), []);
});

test("an UNLABELED event does not satisfy the floor -- only the event that APPLIED the label does", () => {
  const byNumber = labelEventsByIssue(parseEventLines(line(4, "unlabeled", "session:a", "2026-09-09T10:00:00Z")));
  assert.deepEqual(claimsWithNoEvent([{ number: 4, labels: ["session:a"] }], byNumber), [4]);
});

// --- fetchClosedRowEvents: failure never degrades to an empty population ---

const listing = JSON.stringify([{ number: 1, title: "a", closedAt: "2026-09-09T10:00:00Z" }]);
const runWith = (events: string) => (_cmd: string, args: string[]) =>
  args[0] === "issue" ? listing : events;

test("a failed listing THROWS -- an empty one would audit a population it never read", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "issue") throw new Error("gh exploded");
    return "";
  };
  assert.throws(() => fetchClosedRowEvents({ run: run as never }), /could not list closed rows/);
});

test("a failed event read THROWS -- an empty log would report EVERY closed row unattributable", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "issue") return listing;
    throw new Error("gh exploded");
  };
  assert.throws(() => fetchClosedRowEvents({ run: run as never }), /refusing to report every closed row/);
});

test("a row with no events comes back with an empty history rather than being dropped", () => {
  const rows = fetchClosedRowEvents({ run: runWith("") as never });
  assert.deepEqual(rows.map((r) => [r.number, r.events.length]), [[1, 0]]);
});

test("THE FLOOR REFUSES THE WHOLE READ, not just the row it noticed on", () => {
  assert.throws(() => fetchClosedRowEvents({
    run: runWith(line(1, "labeled", "ready", "2026-09-09T10:00:00Z")) as never,
    openIssues: [{ number: 9, labels: ["session:worker-judge"] }],
  }), /the log is SHORT/);
});

test("the floor passes when every live claim's applying event is in the log", () => {
  const rows = fetchClosedRowEvents({
    run: runWith(line(9, "labeled", "session:worker-judge", "2026-09-09T10:00:00Z")) as never,
    openIssues: [{ number: 9, labels: ["session:worker-judge"] }],
  });
  assert.equal(rows.length, 1);
});
