// no-token: gh -- no `gh` or file outside a temp directory is touched; the pull requests, consumer files, lists and clock are fixtures (agent-org#839)
// agent-org#839 (class `closed-on-merge-not-outcome`): an option a merged pull request declared as a consumer's to set, with no matching value in the consumer's file two hours after the
// merge, is a ledger incident. EVERY "NO INCIDENT" HAS A TWIN: the same fixture with ONE thing changed that DOES produce one, so a detector that never fires turns the twins red and one that
// always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURE_LEDGER_FILE, parseFailureLedger, recordFailures } from "./failure-ledger.ts";
import {
  CLOSED_ON_MERGE_NOT_OUTCOME, INERT_OPTION_MINUTES, inertOptionEvents, inertOptionIncidents, inertOptionSummary, type ConsumerFileReader, type MergedOptionPr,
} from "./inert-option-incident.ts";
import { buildReport } from "./org-retro/readings.ts";
import { readInertOptions } from "./org-retro/retro-cause.ts";
import { renderReport } from "./org-retro.ts";
import { readsRowsSince, sinceAnswer } from "./packaging/rows-by-label-fixtures.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const CONSUMER = "a11ign/a11ign";
const FILE = ".agent-org/project.json";
const LINE = `Consumer-declaration: ${CONSUMER}:${FILE} routing.question=choice`;

/** A merged agent-org pull request that declared `routing.question=choice`, merged `minutes` ago. */
const pr = (over: Partial<MergedOptionPr> = {}): MergedOptionPr => ({ repo: "a11ign/agent-org", number: 782, mergedAt: ago(121), acceptanceText: `Acceptance:\n${LINE}\n`, body: "Closes: none -- the switch is a11ign/a11ign#4904", ...over });
const consumer = (json: unknown): ConsumerFileReader => (repo, path) => (repo === CONSUMER && path === FILE ? JSON.stringify(json) : null);
const SET = consumer({ routing: { question: "choice" } });
const UNSET = consumer({ routing: {} });
const run = (prs: MergedOptionPr[], readConsumerFile: ConsumerFileReader, recorded: string[] = []) => inertOptionIncidents({ mergedPrs: prs, readConsumerFile, now: NOW, recorded });

test("the named constant is 120", () => {
  assert.equal(INERT_OPTION_MINUTES, 120);
});

test("POSITIVE CONTROL: the exact shape of agent-org#782 -- `routing.question=choice` merged 2026-10-11T00:41Z, a11ign's project.json without `routing`, read at 02:41Z -- is an incident", () => {
  const merged782: MergedOptionPr = { repo: "a11ign/agent-org", number: 782, mergedAt: "2026-10-11T00:41:00Z", acceptanceText: `Acceptance:\n${LINE}\n` };
  const projectJson = consumer({ name: "a11ign", traits: ["x"] });
  const found = inertOptionIncidents({ mergedPrs: [merged782], readConsumerFile: projectJson, now: Date.parse("2026-10-11T02:41:01Z") });
  assert.equal(found.incidents.length, 1);
  assert.equal(found.incidents[0].ref, "a11ign/agent-org#782:routing.question");
  assert.deepEqual(found.incidents[0].found, { state: "absent" });
  assert.equal(found.incidents[0].wanted, "choice");
  assert.deepEqual(found.unknown, []);
});

test("set: the consumer holds the value, no incident (twin: the same fixture with the key absent is one)", () => {
  assert.deepEqual(run([pr()], SET), { incidents: [], unknown: [] });
  assert.equal(run([pr()], UNSET).incidents.length, 1);
});

test("a key that holds ANOTHER value is an incident that says what it holds", () => {
  const found = run([pr()], consumer({ routing: { question: "traits" } })).incidents[0];
  assert.deepEqual(found.found, { state: "holds", value: "traits" });
});

test("not set at 119 minutes is none, at 121 is an incident, and exactly 120 is none", () => {
  assert.deepEqual(run([pr({ mergedAt: ago(119) })], UNSET).incidents, []);
  assert.deepEqual(run([pr({ mergedAt: ago(120) })], UNSET).incidents, []);
  assert.equal(run([pr({ mergedAt: ago(121) })], UNSET).incidents.length, 1);
});

test("a consumer file that cannot be read is UNKNOWN: not an incident and not 'present' (twin: readable, it is an incident)", () => {
  const unreadable: ConsumerFileReader = () => null;
  const got = run([pr()], unreadable);
  assert.deepEqual(got.incidents, []);
  assert.equal(got.unknown.length, 1);
  assert.match(got.unknown[0].reason, /could not be read/);
  assert.equal(run([pr()], UNSET).incidents.length, 1);
});

test("a consumer file that is not JSON is unknown, and so is an acceptance file that could not be read", () => {
  const got = run([pr()], () => "{ not json");
  assert.deepEqual(got.incidents, []);
  assert.match(got.unknown[0].reason, /not JSON/);
  const noText = run([pr({ acceptanceText: null })], UNSET);
  assert.deepEqual(noText.incidents, []);
  assert.equal(noText.unknown.length, 1);
});

test("two lines in one acceptance file, one set and one not, is ONE incident, on the key that is not", () => {
  const two = pr({ acceptanceText: `${LINE}\nConsumer-declaration: ${CONSUMER}:${FILE} routing.other=yes\n` });
  const got = run([two], consumer({ routing: { question: "choice" } }));
  assert.deepEqual(got.incidents.map(({ ref }) => ref), ["a11ign/agent-org#782:routing.other"]);
});

test("already recorded is none (twin: a different pull request on the same key is a second incident)", () => {
  assert.deepEqual(run([pr()], UNSET, ["a11ign/agent-org#782:routing.question"]).incidents, []);
  const second = pr({ number: 790 });
  const got = run([pr(), second], UNSET, ["a11ign/agent-org#782:routing.question"]);
  assert.deepEqual(got.incidents.map(({ ref }) => ref), ["a11ign/agent-org#790:routing.question"]);
});

test("a pull request with no declaration, or a line that is prose and not a line start, declares nothing", () => {
  assert.deepEqual(run([pr({ acceptanceText: "Acceptance:\nnothing here\n" })], UNSET), { incidents: [], unknown: [] });
  assert.deepEqual(run([pr({ acceptanceText: `see \`${LINE}\` for the grammar` })], UNSET), { incidents: [], unknown: [] });
});

test("each consumer file is read once, and the switch row is the one a `Closes: none` reason names", () => {
  let reads = 0;
  const counting: ConsumerFileReader = (repo, path) => { reads += 1; return UNSET(repo, path); };
  const got = run([pr(), pr({ number: 791 })], counting);
  assert.equal(reads, 1);
  assert.equal(got.incidents[0].switchRow, "a11ign/a11ign#4904");
  assert.equal(run([pr({ body: "Closes #5" })], UNSET).incidents[0].switchRow, null);
});

test("the ledger event is the EXISTING class's kind with the ref, and recording it twice is one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "inert-option-"));
  try {
    const events = inertOptionEvents(run([pr()], UNSET).incidents);
    assert.deepEqual(events, [{ classKey: CLOSED_ON_MERGE_NOT_OUTCOME, ref: "a11ign/agent-org#782:routing.question" }]);
    const logPath = join(dir, FAILURE_LEDGER_FILE);
    recordFailures({ logPath, events, now: NOW, report: () => {} });
    recordFailures({ logPath, events, now: NOW + MIN, report: () => {} });
    const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].classKey, "closed-on-merge-not-outcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary is null for a read nobody made, and names the file, key, wanted and found otherwise", () => {
  assert.equal(inertOptionSummary(null), null);
  const summary = inertOptionSummary(run([pr()], UNSET));
  assert.equal(summary?.count, 1);
  assert.match(summary?.details[0] ?? "", /a11ign\/a11ign:\.agent-org\/project\.json `routing\.question` must be `choice`, absent, 121 minutes after the merge; the consumer's switch row is a11ign\/a11ign#4904/);
});

// ---- the live read, over fakes ----

const declaration = { code: [{ repo: "a11ign/agent-org" }] } as any;
// #5076: the merged list is the `pullRequests` connection (it was `pr list --search merged:>=`); any other call is refused, as the old fake refused a non-merged list.
const listing = (prs: any[]) => (args: string[]) => (readsRowsSince(args) !== null ? JSON.parse(sinceAnswer(args, prs.map((pr) => ({ updatedAt: pr.mergedAt, ...pr })))) : null);

test("the live read reads the acceptance file AT THE MERGE COMMIT, never the default branch's current one, and reports through the retro", () => {
  const OID = "a".repeat(40);
  const asked: string[] = [];
  const readAcceptance = ({ repo, path, oid }: { repo: string, path: string, oid: unknown, readFile: unknown }) => {
    asked.push(`${repo}:${path}@${oid}`);
    return oid === OID ? `Acceptance:\n${LINE}\n` : null;
  };
  // the default branch's file is DIFFERENT now (a later pull request rewrote it): the consumer reader must never be asked for the acceptance path
  const readFile = (repo: string, path: string) => (repo === CONSUMER && path === FILE ? JSON.stringify({ traits: [] }) : "Acceptance:\nnothing now\n");
  const prs = [
    { number: 782, body: "Closes: none -- the switch is #4904", mergedAt: ago(200), mergeCommit: { oid: OID }, files: [{ path: "src/a.ts" }, { path: ".acceptance/agent~x-1.md" }] },
    { number: 783, body: "", mergedAt: ago(200), mergeCommit: { oid: "b".repeat(40) }, files: [{ path: "src/b.ts" }] },
  ];
  const reading = readInertOptions({ now: NOW, declaration, read: listing(prs), readFile, readAcceptance });
  assert.deepEqual(asked, [`a11ign/agent-org:.acceptance/agent~x-1.md@${OID}`]);
  assert.deepEqual(reading?.incidents.map(({ ref }) => ref), ["a11ign/agent-org#782:routing.question"]);
  const report = buildReport({ merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null, inertOptions: reading }, NOW);
  assert.match(renderReport(report), /Merged options a consumer has not set, more than 120 minutes after the merge: 1/);
  assert.match(renderReport(report), /routing\.question` must be `choice`, absent/);
});

test("the default acceptance reader asks for the file at the merge commit, and a missing or malformed commit is unknown (null) without asking", () => {
  const OID = "c".repeat(40);
  const asked: string[] = [];
  const readFile = (repo: string, path: string, ref?: string) => {
    asked.push(`${repo}:${path}@${ref}`);
    return path.startsWith(".acceptance/") ? `Acceptance:\n${LINE}\n` : JSON.stringify({ traits: [] });
  };
  const prs = [{ number: 5, mergedAt: ago(200), mergeCommit: { oid: OID }, files: [{ path: ".acceptance/agent~x-1.md" }] },
    { number: 6, mergedAt: ago(200), mergeCommit: null, files: [{ path: ".acceptance/agent~y-2.md" }] },
    { number: 7, mergedAt: ago(200), mergeCommit: { oid: "../x" }, files: [{ path: ".acceptance/agent~z-3.md" }] }];
  const reading = readInertOptions({ now: NOW, declaration, read: listing(prs), readFile });
  assert.deepEqual(asked, [`a11ign/agent-org:.acceptance/agent~x-1.md@${OID}`, `${CONSUMER}:${FILE}@undefined`]);
  assert.deepEqual(reading?.incidents.map(({ ref }) => ref), ["a11ign/agent-org#5:routing.question"]);
  assert.deepEqual(reading?.unknown.map(({ ref }) => ref), ["a11ign/agent-org#6", "a11ign/agent-org#7"]);
});

test("a refused list is `unknown` in the report and never 0 (twin: a listed empty window is 0)", () => {
  assert.equal(readInertOptions({ now: NOW, declaration, read: () => null, readFile: () => null }), null);
  const none = readInertOptions({ now: NOW, declaration, read: listing([]), readFile: () => null });
  assert.deepEqual(none, { incidents: [], unknown: [] });
  const text = renderReport(buildReport({ merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null, inertOptions: null }, NOW));
  assert.match(text, /Merged options a consumer has not set.*: unknown/);
});
