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
  reportableUnattributable, attributionFor, closingPrFromResponse, ARM_LABELS_FROM,
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

// --- #848: THE THREE VERDICTS. Ten rows read as one population on 2026-09-09 because "no claim event"
// was printed as "unattributable": five had been closed by a merged PR that declared them, three were
// never worked, and two needed a person. These pin the split, with #887 (a record gap) and #853 (a real
// bypass) as the two fixtures that must read DIFFERENTLY.

const closedRow = (number: number, closedAt: string, stateReason?: string) =>
  ({ number, title: `row ${number}`, closedAt, events: [], stateReason });

test("#848: a row closed NOT_PLANNED is not reported -- it was never worked", () => {
  const rows = [
    closedRow(798, "2026-09-09T15:04:24Z", "NOT_PLANNED"),   // a junk row from a write used as a probe
    closedRow(397, "2026-09-09T17:45:30Z", "NOT_PLANNED"),   // premise refuted by measurement
    closedRow(853, "2026-09-09T17:46:42Z", "COMPLETED"),     // the real bypass
  ];

  assert.deepEqual(reportableUnattributable(rows as never, { since: PROVENANCE_REQUIRED_FROM })
    .map((r) => r.number), [853]);

  // The vacuity guard: without the filter all three come back, so the assertion above is about the
  // filter and not about an empty input.
  assert.equal(unattributableClosedRows(rows as never, { since: PROVENANCE_REQUIRED_FROM }).length, 3);
});

test("#848: a row whose stateReason was never read stays reportable", () => {
  const rows = [closedRow(601, "2026-09-09T14:33:49Z")];
  assert.deepEqual(reportableUnattributable(rows as never, { since: PROVENANCE_REQUIRED_FROM })
    .map((r) => r.number), [601], "absent is not NOT_PLANNED -- reading it as such empties the finding");
});

test("#848: #887's shape -- closed by a merged PR from BEFORE #839 -- names the work, not the worker", () => {
  const { verdict, line } = attributionFor({
    number: 894, headRefName: "agent/exhausted-over-a-gap-887", merged: true,
    createdAt: "2026-09-09T16:00:00Z", sessionLabels: [],
  });
  assert.equal(verdict, "work", "a branch name is not an attribution -- and not a finding either");
  assert.match(line, /PR #894 \(agent\/exhausted-over-a-gap-887\)/);
  assert.match(line, /the WORK, not the worker/);
});

test("#848: #853's shape -- no closing PR at all -- is the one that needs a person", () => {
  const { verdict, line } = attributionFor(null);
  assert.equal(verdict, "undeclared");
  assert.match(line, /no merged pull request declared it/);
  assert.doesNotMatch(line, /PR #/, "there is no PR to name, and inventing one would be worse than none");
});

test("#848: a PR armed after #839 carries the worker and IS an attribution", () => {
  const { verdict, line } = attributionFor({
    number: 900, headRefName: "agent/anything-1", merged: true,
    createdAt: ARM_LABELS_FROM, sessionLabels: ["session:worker-capture"],
  });
  assert.equal(verdict, "worker");
  assert.match(line, /session:worker-capture/);
});

test("#848: an UNMERGED closing reference attributes nothing", () => {
  const { verdict } = attributionFor({
    number: 89, headRefName: "agent/never-landed", merged: false,
    createdAt: "2026-09-09T18:00:00Z", sessionLabels: ["session:worker-judge"],
  });
  assert.equal(verdict, "undeclared", "#89 closed unmerged and #79 was closed anyway -- the work never landed");
});

test("#848: a closing-PR response that cannot be parsed THROWS rather than reading as 'nothing closed it'", () => {
  assert.throws(() => closingPrFromResponse("not json", 887), /was not JSON/);
  assert.throws(() => closingPrFromResponse(JSON.stringify({ data: {} }), 887), /had no timeline/);
  assert.equal(closingPrFromResponse(JSON.stringify(
    { data: { repository: { issue: { timelineItems: { nodes: [{ closer: null }] } } } } }, null, 0), 853),
  null, "a hand close has no closer, and that is a fact rather than a failure");
});

test("#848: a PR opened AFTER #839 with no session label is a finding -- there, absence means something", () => {
  // `arm-pr` copies the row's `session:` label onto its PR since #839, so a PR opened after it without
  // one closed a row nobody claimed through `row-claim`. Before #839 the same absence says nothing, which
  // is why the pre-#839 shape above is `work` and this one is not.
  const { verdict, line } = attributionFor({
    number: 912, headRefName: "agent/unclaimed-912", merged: true,
    createdAt: ARM_LABELS_FROM, sessionLabels: [],
  });
  assert.equal(verdict, "undeclared");
  assert.match(line, /never claimed through row-claim/);
});

test("#848: NOT_PLANNED reaches the filter through the REAL fetch path -- asked for, and carried", () => {
  // The first version filtered on `stateReason` while `fetchClosedRowEvents` never asked `gh` for it and
  // rebuilt each row without it, so in production the filter could not fire and the audit's
  // "N closed NOT_PLANNED are not counted" always said 0. The synthetic rows above carried the field by
  // hand, which is how every assertion passed.
  const calls: string[][] = [];
  const listing = JSON.stringify([
    { number: 798, title: "probe", closedAt: "2026-09-09T15:04:24Z", stateReason: "NOT_PLANNED" },
    { number: 853, title: "a real bypass", closedAt: "2026-09-09T17:46:42Z", stateReason: "COMPLETED" },
  ]);
  const run = (_cmd: string, args: string[]) => { calls.push(args); return args[0] === "issue" ? listing : ""; };
  const rows = fetchClosedRowEvents({ run: run as never });

  const listingArgs = calls.find((args) => args[0] === "issue") ?? [];
  assert.match(listingArgs[listingArgs.indexOf("--json") + 1] ?? "", /\bstateReason\b/,
    "the listing must ASK for stateReason");
  assert.deepEqual(reportableUnattributable(rows, { since: PROVENANCE_REQUIRED_FROM }).map((r) => r.number), [853]);
});

test("#848: a closing PR with no createdAt THROWS -- read as the earlier side of #839 it would leave the finding", () => {
  // worker-capture's review of #942: `createdAt` defaulted to "" compared earlier than ARM_LABELS_FROM, so a
  // malformed response read as `work` and dropped out of the count -- the one field that failed OPEN.
  const closer = (createdAt: unknown) => JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [
    { closer: { number: 913, headRefName: "agent/unclaimed-912", merged: true, createdAt, labels: { nodes: [] } } },
  ] } } } } });
  for (const createdAt of [undefined, null, "", 20260910]) {
    assert.throws(() => closingPrFromResponse(closer(createdAt), 912), /no createdAt/, `createdAt ${String(createdAt)}`);
  }
  // The control: the same closer WITH a createdAt parses, so the throws above are about the field.
  assert.equal(closingPrFromResponse(closer(ARM_LABELS_FROM), 912)?.createdAt, ARM_LABELS_FROM);
});
