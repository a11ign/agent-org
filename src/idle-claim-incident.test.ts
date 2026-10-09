// no-token: gh -- no `gh`, `herdr` or file is touched; the claims, pull requests, listing and clock are fixtures (a11ign/a11ign#4642)
// #4642: a claim idle more than 60 minutes with no open pull request, or a pull request with nothing pending, is a `row-not-finishable` ledger incident.
//
// EVERY "NO INCIDENT" ASSERTION HAS A TWIN: the SAME fixture with ONE thing changed that DOES produce one (`incidentFixture` below, and each case names its twin), so a detector that
// never fires turns the twins red, and one that always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STALL_STATE_FILE } from "./claim-stall.ts";
import { FAILURE_LEDGER_FILE, recordFailures, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { IDLE_CLAIMANT_MINUTES, WAIT_FIELDS } from "./idle-claimant.ts";
import { buildReport, readIdleClaims, renderReport, retrospectiveTick } from "./org-retro.ts";
import { IDLE_CLAIM_INCIDENT_MINUTES, ROW_NOT_FINISHABLE, idleClaimIncidents, incidentEvents, incidentSummary, type IdleClaim } from "./idle-claim-incident.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-09T21:00:00Z");
const ago = (minutes: number) => NOW - minutes * MIN;
const LISTING = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: "worker-7", status: "idle" }];

/** An open pull request with nothing pending on it: green, no review asked of anybody, not approved, no label. */
const quietPr = (over: object = {}) => ({ number: 9, reviewDecision: "REVIEW_REQUIRED", labels: [{ name: "session:worker-7" }], checksPending: false, ...over });
/** The idle claim every case starts from: idle 61 minutes, no pull request, no wait. */
const claim = (over: Partial<IdleClaim> = {}): IdleClaim => ({ row: 4001, session: "worker-7", idleSince: ago(IDLE_CLAIM_INCIDENT_MINUTES + 1), ...over });
const incidents = (claims: IdleClaim[], agents: { label: string, status: string }[] | null = LISTING) => idleClaimIncidents({ claims, agents, now: NOW });

test("the named constant is 60, above the nudge's 45", () => {
  assert.equal(IDLE_CLAIM_INCIDENT_MINUTES, 60);
  assert.ok(IDLE_CLAIM_INCIDENT_MINUTES > IDLE_CLAIMANT_MINUTES);
});

test("a claim idle 61 minutes with no open PR is one no-pr incident, ref the row and the idle run", () => {
  const found = incidents([claim()]);
  assert.equal(found.length, 1);
  assert.deepEqual({ kind: found[0].kind, row: found[0].row, pr: found[0].pr, idleMinutes: found[0].idleMinutes }, { kind: "no-pr", row: 4001, pr: null, idleMinutes: 61 });
  assert.equal(found[0].ref, "#4001@2026-10-09T19:59:00Z");
});

test("the boundary: exactly 60 minutes is not an incident (the twin of the 61 above), 61 is", () => {
  assert.deepEqual(incidents([claim({ idleSince: ago(60) })]), []);
  assert.equal(incidents([claim({ idleSince: ago(61) })]).length, 1);
});

test("a claim idle past the nudge but inside the incident threshold (50 minutes) is not an incident", () => {
  assert.deepEqual(incidents([claim({ idleSince: ago(50) })]), []);
});

test("a holder that is working is no incident; the twin is the same claim with the holder idle", () => {
  const working = LISTING.map((a) => (a.label === "worker-7" ? { ...a, status: "working" } : a));
  assert.deepEqual(incidents([claim()], working), []);
  assert.equal(incidents([claim()]).length, 1);
});

test("a listing that is not the whole org, or none, proves nothing (the twin is the complete listing)", () => {
  assert.deepEqual(incidents([claim()], [{ label: "worker-7", status: "idle" }]), []);
  assert.deepEqual(incidents([claim()], null), []);
  assert.equal(incidents([claim()]).length, 1);
});

test("an idle start nobody recorded is CANNOT TELL, never an incident (the twin has it)", () => {
  assert.deepEqual(incidents([claim({ idleSince: null })]), []);
  assert.equal(incidents([claim()]).length, 1);
});

test("EVERY declared row wait clears a claim, and the decision is idle-claimant's own table", () => {
  const rowKinds = Object.entries(WAIT_FIELDS).filter(([, f]) => f.on === "row").map(([kind]) => kind);
  assert.ok(rowKinds.length >= 5, "the table has its row kinds, so this is not an empty loop");
  for (const kind of rowKinds) assert.deepEqual(incidents([claim({ waitKinds: [kind] })]), [], kind);
  assert.equal(incidents([claim({ waitKinds: [] })]).length, 1);
});

test("a claim with a PR and nothing pending on it is one pr-idle incident, ref the PR", () => {
  const found = incidents([claim({ prs: [quietPr()] })]);
  assert.equal(found.length, 1);
  assert.deepEqual({ kind: found[0].kind, pr: found[0].pr, row: found[0].row }, { kind: "pr-idle", pr: 9, row: 4001 });
  assert.equal(found[0].ref, "PR#9@2026-10-09T19:59:00Z");
});

test("a pending check is not an incident (twin: the same PR with the check done)", () => {
  assert.deepEqual(incidents([claim({ prs: [quietPr({ checksPending: true })] })]), []);
  assert.equal(incidents([claim({ prs: [quietPr({ checksPending: false })] })]).length, 1);
});

test("a review asked for (a live reviewer-<n> pane) is not an incident (twin: no such pane)", () => {
  const withReviewer = [...LISTING, { label: "reviewer-9", status: "working" }];
  assert.deepEqual(incidents([claim({ prs: [quietPr()] })], withReviewer), []);
  assert.equal(incidents([claim({ prs: [quietPr()] })]).length, 1);
});

test("an APPROVED PR (the queue owns it), an awaiting-evidence PR and a held PR are not incidents (twin: none of the three)", () => {
  assert.deepEqual(incidents([claim({ prs: [quietPr({ reviewDecision: "APPROVED" })] })]), []);
  assert.deepEqual(incidents([claim({ prs: [quietPr({ labels: [{ name: "awaiting-evidence" }] })] })]), []);
  assert.deepEqual(incidents([claim({ prs: [quietPr({ labels: [{ name: "hold:worker-7" }] })] })]), []);
  assert.equal(incidents([claim({ prs: [quietPr()] })]).length, 1);
});

test("a PR is judged on its own: the holder's other PR waiting on a check does not hide the quiet one", () => {
  const found = incidents([claim({ prs: [quietPr({ number: 10, checksPending: true }), quietPr({ number: 11 })] })]);
  assert.deepEqual(found.map((i) => i.pr), [11]);
});

test("a declared row wait clears the claim's PRs too (twin: no wait)", () => {
  assert.deepEqual(incidents([claim({ prs: [quietPr()], waitKinds: ["not-before"] })]), []);
  assert.equal(incidents([claim({ prs: [quietPr()] })]).length, 1);
});

test("a quiet PR whose holder has been idle only 60 minutes is not an incident", () => {
  assert.deepEqual(incidents([claim({ prs: [quietPr()], idleSince: ago(60) })]), []);
});

test("events are keyed row-not-finishable with the ref; a second idle run on the same row is a second line, a standing one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-claim-incident-"));
  try {
    const logPath = join(dir, "failure-ledger");
    const record = (idleSince: number, now: number) => recordFailures({ logPath, events: incidentEvents(idleClaimIncidents({ claims: [claim({ idleSince })], agents: LISTING, now })), now });
    assert.equal(record(ago(120), NOW).appended, 1);
    assert.equal(record(ago(120), NOW + 2 * MIN).appended, 0, "the same run seen on the next tick is one standing event");
    assert.equal(record(ago(30), NOW + 100 * MIN).appended, 1, "a later idle run on the same row is another episode");
    const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
    assert.deepEqual(entries.map((e) => e.classKey), [ROW_NOT_FINISHABLE, ROW_NOT_FINISHABLE]);
    assert.equal(repeatsIn(entries, { windowMs: 24 * 60 * MIN }).length, 1, "two episodes are a repeat of the class");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the summary is the count and the first three refs; an unread population is null, never 0", () => {
  const many = incidents([1, 2, 3, 4, 5].map((n) => claim({ row: 4000 + n })));
  assert.equal(many.length, 5);
  assert.deepEqual(incidentSummary(many), { count: 5, first: many.slice(0, 3).map((i) => i.ref) });
  assert.deepEqual(incidentSummary([]), { count: 0, first: [] });
  assert.equal(incidentSummary(null), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// The daily pass: `org-retro.ts` reads the gate's idle memory, and prints and records what the detector finds.

const withState = (memory: object, body: (stateDir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "idle-claim-retro-"));
  try {
    writeFileSync(join(dir, STALL_STATE_FILE), JSON.stringify(memory));
    body(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const quietPrOf = (session: string, number = 9) => ({ number, labels: [{ name: `session:${session}` }], reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ name: "ts", status: "COMPLETED", conclusion: "SUCCESS" }] });

test("readIdleClaims: an idle-watch entry 61 minutes old with no PR is an incident; the twin is 59 minutes", () => {
  withState({ 4001: { session: "worker-7", idleSince: ago(61) } }, (stateDir) => {
    assert.deepEqual(readIdleClaims({ now: NOW, stateDir, openPrs: [], agents: LISTING })?.map((i) => i.row), [4001]);
  });
  withState({ 4001: { session: "worker-7", idleSince: ago(59) } }, (stateDir) => {
    assert.deepEqual(readIdleClaims({ now: NOW, stateDir, openPrs: [], agents: LISTING }), []);
  });
});

test("readIdleClaims: an idle nudge dates the run IDLE_CLAIMANT_MINUTES before it; a stall nudge or a vacating entry is not an idle run", () => {
  withState({ 4001: { session: "worker-7", nudgedAt: ago(30), idle: true }, 4002: { session: "worker-7", nudgedAt: ago(300) }, 4003: { session: "worker-7", goneSince: ago(300) } }, (stateDir) => {
    const found = readIdleClaims({ now: NOW, stateDir, openPrs: [], agents: LISTING });
    assert.deepEqual(found?.map((i) => [i.row, i.idleMinutes]), [[4001, 75]]);
  });
});

test("readIdleClaims: the holder's PR (by its session label) with nothing pending is a pr-idle incident; a running check clears it; another session's PR does not count", () => {
  withState({ 4001: { session: "worker-7", idleSince: ago(90) } }, (stateDir) => {
    const read = (openPrs: object[]) => readIdleClaims({ now: NOW, stateDir, openPrs, agents: LISTING });
    assert.deepEqual(read([quietPrOf("worker-7")])?.map((i) => [i.kind, i.pr]), [["pr-idle", 9]]);
    const running = { ...quietPrOf("worker-7"), statusCheckRollup: [{ name: "ts", status: "IN_PROGRESS" }] };
    assert.deepEqual(read([running]), []);
    assert.deepEqual(read([quietPrOf("worker-8")])?.map((i) => i.kind), ["no-pr"]);
  });
});

test("readIdleClaims: an unreadable PR list or listing is null (unknown), never an empty population", () => {
  withState({ 4001: { session: "worker-7", idleSince: ago(90) } }, (stateDir) => {
    assert.equal(readIdleClaims({ now: NOW, stateDir, openPrs: null, agents: LISTING }), null);
    assert.equal(readIdleClaims({ now: NOW, stateDir, openPrs: [], agents: null }), null);
    assert.equal(readIdleClaims({ now: NOW, stateDir, openPrs: [], agents: LISTING })?.length, 1);
  });
});

const emptyReads = { merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null };

test("the report prints the count and the first three refs, and unknown when the read was refused", () => {
  const many = incidents([1, 2, 3, 4].map((n) => claim({ row: 4000 + n })));
  const text = renderReport(buildReport({ ...emptyReads, idleClaims: many }, NOW));
  assert.match(text, /Claims idle past 60 minutes .*: 4; first: #4001@\S+, #4002@\S+, #4003@\S+\n/);
  assert.doesNotMatch(text, /#4004/);
  assert.match(renderReport(buildReport({ ...emptyReads, idleClaims: [] }, NOW)), /nothing pending on it: 0\n/);
  assert.match(renderReport(buildReport({ ...emptyReads, idleClaims: null }, NOW)), /nothing pending on it: unknown /);
  assert.match(renderReport(buildReport(emptyReads, NOW)), /nothing pending on it: unknown /);
});

test("the daily tick records the incidents once per episode in the failure ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-claim-tick-"));
  try {
    const inputs = { ...emptyReads, idleClaims: incidents([claim()]) };
    const tick = (now: number) => retrospectiveTick({ now, stateDir: dir, log: () => {}, read: () => inputs, readLedger: () => "", record: () => "recorded" });
    assert.equal(tick(NOW).length, 1);
    tick(NOW + 5 * MIN);
    const entries = parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));
    assert.deepEqual(entries.map((e) => [e.classKey, e.ref]), [[ROW_NOT_FINISHABLE, "#4001@2026-10-09T19:59:00Z"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
