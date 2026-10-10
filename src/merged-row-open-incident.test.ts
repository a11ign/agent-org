// no-token: gh -- no `gh` or file outside a temp directory is touched; the rows, pull requests, lists and clock are fixtures (a11ign/a11ign#4769)
// #4769: an open row (claimed or not) whose deliverable pull request merged more than 30 minutes ago is a `row-not-finishable` ledger incident.
//
// EVERY "NO INCIDENT" ASSERTION HAS A TWIN: the SAME fixture with ONE thing changed that DOES produce one (`row` and `merged` below), so a detector that never fires turns the
// twins red and one that always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURE_LEDGER_FILE, parseFailureLedger, recordFailures } from "./failure-ledger.ts";
import { ROW_NOT_FINISHABLE } from "./idle-claim-incident.ts";
import { MERGED_ROW_OPEN_MINUTES, mergedRowOpenEvents, mergedRowOpenIncidents, mergedRowOpenSummary, type NamingPr, type OpenRow } from "./merged-row-open-incident.ts";
import { buildReport, readMergedRowOpen, renderReport, retrospectiveTick } from "./org-retro.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const TRACKER = "o/tracker";
const CODE = "o/code";

/** An open, unclaimed, ordinary row: the fixture every case starts from. */
const row = (over: Partial<OpenRow> = {}): OpenRow => ({ repo: TRACKER, number: 4001, labels: ["ready"], ...over });
/** A pull request in the CODE repository that merged `minutes` ago and declares row 4001 of the tracker. */
const merged = (over: Partial<NamingPr> = {}, minutes = 31): NamingPr => ({ repo: CODE, number: 7, body: `Closes ${TRACKER}#4001`, headRefName: "agent/x-4001", mergedAt: ago(minutes), ...over });
const incidents = (rows: OpenRow[], mergedPrs: NamingPr[], openPrs: NamingPr[] = []) => mergedRowOpenIncidents({ rows, mergedPrs, openPrs, now: NOW });

test("the named constant is 30", () => {
  assert.equal(MERGED_ROW_OPEN_MINUTES, 30);
});

test("a row open 31 minutes after its deliverable merged is one incident, ref the row and the merge", () => {
  const found = incidents([row()], [merged()]);
  assert.equal(found.length, 1);
  assert.deepEqual({ row: found[0].row.number, pr: found[0].pr.number, openMinutes: found[0].openMinutes }, { row: 4001, pr: 7, openMinutes: 31 });
  assert.equal(found[0].ref, "o/tracker#4001@o/code#7");
});

test("the boundary: 29 minutes and exactly 30 are not incidents (the twin is the 31 above)", () => {
  assert.deepEqual(incidents([row()], [merged({}, 29)]), []);
  assert.deepEqual(incidents([row()], [merged({}, 30)]), []);
  assert.equal(incidents([row()], [merged({}, 31)]).length, 1);
});

test("an UNCLAIMED row and a CLAIMED row are both incidents (the claim is not what is read)", () => {
  assert.equal(incidents([row({ labels: ["ready"] })], [merged()]).length, 1);
  const claimed = row({ labels: ["in-progress", "started", "session:worker-4001"], claimedBranch: "agent/x-4001" });
  assert.equal(incidents([claimed], [merged()]).length, 1);
});

test("a row also named by a still-open pull request is not an incident (twin: that pull request names another row)", () => {
  const second: NamingPr = { repo: CODE, number: 9, body: `Closes ${TRACKER}#4001`, headRefName: "agent/y-4001-b" };
  assert.deepEqual(incidents([row()], [merged()], [second]), []);
  assert.equal(incidents([row()], [merged()], [{ ...second, body: `Closes ${TRACKER}#4002` }]).length, 1);
});

test("a still-open pull request on the CLAIMED BRANCH also holds the row open (twin: another branch)", () => {
  const claimed = row({ claimedBranch: "agent/x-4001" });
  const open: NamingPr = { repo: CODE, number: 9, body: "no declaration", headRefName: "agent/x-4001" };
  assert.deepEqual(incidents([claimed], [merged()], [open]), []);
  assert.equal(incidents([claimed], [merged()], [{ ...open, headRefName: "agent/other-4009" }]).length, 1);
});

test("an epic is not an incident (twin: the same row without the label)", () => {
  assert.deepEqual(incidents([row({ labels: ["epic"] })], [merged()]), []);
  assert.equal(incidents([row({ labels: [] })], [merged()]).length, 1);
});

test("a merged pull request that only REFERS to the row is no incident (twin: the same sentence as a Closes line)", () => {
  for (const body of [`Refs ${TRACKER}#4001`, "Part of #4001", "follow-up to #4001; see also #4001", "Closes: none -- docs only"]) {
    assert.deepEqual(incidents([row()], [merged({ body: `${body}\n`, headRefName: "agent/unrelated-1" })]), [], body);
  }
  assert.equal(incidents([row()], [merged({ body: `Closes ${TRACKER}#4001` })]).length, 1);
});

test("a `Closes: none` line that NAMES the row is the deliverable (twin: one that names another row)", () => {
  const none = (reason: string) => merged({ body: `Closes: none -- ${reason}`, headRefName: "agent/unrelated-1" });
  assert.equal(incidents([row()], [none(`the deliverable of ${TRACKER}#4001`)]).length, 1);
  assert.deepEqual(incidents([row()], [none(`the deliverable of ${TRACKER}#4002`)]), []);
});

test("the claimed branch names the deliverable when the body does not (twin: another branch)", () => {
  const byBranch = merged({ body: "Closes: none -- nothing to close", headRefName: "agent/the-thing-4001" });
  assert.equal(incidents([row({ claimedBranch: "agent/the-thing-4001" })], [byBranch]).length, 1);
  assert.deepEqual(incidents([row({ claimedBranch: "agent/another-4001" })], [byBranch]), []);
  assert.deepEqual(incidents([row({ claimedBranch: null })], [byBranch]), [], "an unread claim record names no branch");
});

test("a bare #n is the pull request's own repository's row, not the tracker's (twin: the qualified form)", () => {
  assert.deepEqual(incidents([row()], [merged({ body: "Closes #4001" })]), []);
  assert.equal(incidents([row()], [merged({ body: `Closes ${TRACKER}#4001` })]).length, 1);
  const home = row({ repo: CODE });
  assert.equal(incidents([home], [merged({ body: "Closes #4001" })]).length, 1);
});

test("the NEWEST naming merge decides: a merge 10 minutes ago is inside the grace even beside an old one (twin: it is 40)", () => {
  const old = merged({ number: 5 }, 3000);
  assert.deepEqual(incidents([row()], [old, merged({ number: 8 }, 10)]), []);
  const found = incidents([row()], [old, merged({ number: 8 }, 40)]);
  assert.deepEqual(found.map((i) => i.ref), ["o/tracker#4001@o/code#8"]);
});

test("a merge time that is absent or does not parse is not a merge (twin: the same pull request with its time)", () => {
  assert.deepEqual(incidents([row()], [merged({ mergedAt: null })]), []);
  assert.deepEqual(incidents([row()], [merged({ mergedAt: "yesterday" })]), []);
  assert.equal(incidents([row()], [merged()]).length, 1);
});

test("one row two merges is ONE incident per reading; two rows are two", () => {
  assert.equal(incidents([row()], [merged({ number: 5 }, 90), merged({ number: 6 }, 60)]).length, 1);
  const two = incidents([row(), row({ number: 4002 })], [merged({ body: `Closes ${TRACKER}#4001, ${TRACKER}#4002` })]);
  assert.deepEqual(two.map((i) => i.row.number), [4001, 4002]);
});

test("events are keyed row-not-finishable with the ref: one line per episode, a later merge on the row is another", () => {
  const dir = mkdtempSync(join(tmpdir(), "merged-row-open-"));
  try {
    const logPath = join(dir, FAILURE_LEDGER_FILE);
    const record = (prs: NamingPr[], now: number) => recordFailures({ logPath, events: mergedRowOpenEvents(mergedRowOpenIncidents({ rows: [row()], mergedPrs: prs, now })), now });
    assert.equal(record([merged()], NOW).appended, 1);
    assert.equal(record([merged()], NOW + 24 * 60 * MIN).appended, 0, "the same merge seen on the next daily pass is one standing event");
    assert.equal(record([merged(), merged({ number: 12, mergedAt: ago(-100) })], NOW + 24 * 60 * MIN + 200 * MIN).appended, 1, "a later merge naming the row is a second episode");
    const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
    assert.deepEqual(entries.map((e) => [e.classKey, e.ref]), [[ROW_NOT_FINISHABLE, "o/tracker#4001@o/code#7"], [ROW_NOT_FINISHABLE, "o/tracker#4001@o/code#12"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the summary is the count and the first three refs; an unread population is null, never 0", () => {
  const many = incidents([1, 2, 3, 4, 5].map((n) => row({ number: 4000 + n })), [merged({ body: [1, 2, 3, 4, 5].map((n) => `Closes ${TRACKER}#${4000 + n}`).join("\n") })]);
  assert.equal(many.length, 5);
  assert.deepEqual(mergedRowOpenSummary(many), { count: 5, first: many.slice(0, 3).map((i) => i.ref) });
  assert.deepEqual(mergedRowOpenSummary([]), { count: 0, first: [] });
  assert.equal(mergedRowOpenSummary(null), null);
  assert.equal(mergedRowOpenSummary(undefined), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// The daily pass: `org-retro.ts` reads the lists, prints the count and records what the detector finds.

const DECLARATION: any = { tracker: [{ key: "", repo: TRACKER }], code: [{ key: "", repo: CODE }, { key: "other", repo: "o/other" }] };
const CLAIM_RECORD = "<!-- row-claim: claim record -->\n**Claim record** -- claimed by `worker-1`.\n\nClaimed-branch: agent/the-thing-4001\nClaimed-worktree: ../wt-1";

/** A `gh` that answers each list from the fixture, keyed by what was asked; `refuse` names a list that comes back null. */
function fakeGh({ refuse = "", mergedIn = CODE, over = {} }: { refuse?: string, mergedIn?: string, over?: Record<string, any[]> } = {}) {
  const lists: Record<string, any[]> = {
    "issue open": [{ number: 4001, labels: [{ name: "in-progress" }] }, { number: 4002, labels: [{ name: "ready" }] }],
    "issue claimed": [{ number: 4001, comments: [{ body: "hello" }, { body: CLAIM_RECORD }] }],
    [`pr merged ${mergedIn}`]: [{ number: 7, body: "Closes: none -- built the thing", headRefName: "agent/the-thing-4001", mergedAt: ago(60) }],
    ...over,
  };
  const asked: string[][] = [];
  const read = (args: string[]): any[] | null => {
    asked.push(args);
    const kind = args[0] === "issue" ? (args.includes("--label") ? "issue claimed" : "issue open") : `pr ${args.includes("merged") ? "merged" : "open"} ${args[args.indexOf("-R") + 1]}`;
    if (kind === refuse) return null;
    return lists[kind] ?? [];
  };
  return { read, asked };
}

test("readMergedRowOpen: the claim record's branch finds the deliverable; the twin is a record that names another branch", () => {
  const found = readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh().read });
  assert.deepEqual(found?.map((i) => i.ref), ["o/tracker#4001@o/code#7"]);
  const other = fakeGh({ over: { "issue claimed": [{ number: 4001, comments: [{ body: CLAIM_RECORD.replace("the-thing-4001", "another-4001") }] }] } });
  assert.deepEqual(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: other.read }), []);
});

test("readMergedRowOpen: a merge in a DECLARED code repository other than the first counts (twin: the same list in none)", () => {
  assert.deepEqual(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh({ mergedIn: "o/other" }).read })?.map((i) => i.ref), ["o/tracker#4001@o/other#7"]);
  assert.deepEqual(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh({ mergedIn: "o/undeclared" }).read }), []);
});

test("readMergedRowOpen: an open pull request that names the row holds it (twin: no open one)", () => {
  const open = fakeGh({ over: { "pr open o/other": [{ number: 9, body: `Closes ${TRACKER}#4001`, headRefName: "agent/more-4001" }] } });
  assert.deepEqual(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: open.read }), []);
});

test("readMergedRowOpen: ANY refused list is null (unknown), never an empty population", () => {
  for (const refuse of ["issue open", "issue claimed", `pr merged ${CODE}`, "pr open o/other", "pr merged o/other"]) {
    assert.equal(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh({ refuse }).read }), null, refuse);
  }
  assert.equal(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh().read })?.length, 1);
});

test("readMergedRowOpen: a list at its ceiling may have stopped short, so it is null (twin: one under)", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ number: 9000 + i, labels: [] }));
  assert.equal(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh({ over: { "issue open": filler(1000) } }).read }), null);
  assert.notEqual(readMergedRowOpen({ now: NOW, declaration: DECLARATION, read: fakeGh({ over: { "issue open": filler(999) } }).read }), null);
});

test("readMergedRowOpen: the merged read looks back past the report's 24 hours, to the day the row was merged", () => {
  const { read, asked } = fakeGh();
  readMergedRowOpen({ now: NOW, declaration: DECLARATION, read });
  const search = asked.find((args) => args.includes("--search"))?.[asked.find((args) => args.includes("--search"))!.indexOf("--search")! + 1] ?? "";
  assert.equal(search, `merged:>=${new Date(NOW - 7 * 24 * 60 * MIN).toISOString()}`);
});

const emptyReads = { merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null };

test("the report prints the count and the first three refs, and unknown when the read was refused or never made", () => {
  const many = incidents([1, 2, 3, 4].map((n) => row({ number: 4000 + n })), [merged({ body: [1, 2, 3, 4].map((n) => `Closes ${TRACKER}#${4000 + n}`).join("\n") })]);
  const text = renderReport(buildReport({ ...emptyReads, mergedRowOpen: many }, NOW));
  assert.match(text, /Rows still open more than 30 minutes after their deliverable merged: 4; first: o\/tracker#4001@\S+, o\/tracker#4002@\S+, o\/tracker#4003@\S+\n/);
  assert.doesNotMatch(text, /#4004/);
  assert.match(renderReport(buildReport({ ...emptyReads, mergedRowOpen: [] }, NOW)), /deliverable merged: 0\n/);
  assert.match(renderReport(buildReport({ ...emptyReads, mergedRowOpen: null }, NOW)), /deliverable merged: unknown /);
  assert.match(renderReport(buildReport(emptyReads, NOW)), /deliverable merged: unknown /);
});

test("the daily tick records the incidents once per episode in the failure ledger, and a pass with none records nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "merged-row-open-tick-"));
  try {
    const inputs = { ...emptyReads, mergedRowOpen: incidents([row()], [merged()]) };
    const tick = (reads: typeof inputs, now: number) => retrospectiveTick({ now, stateDir: dir, log: () => {}, read: () => reads, readLedger: () => "", readUntiered: () => null, record: () => "recorded" });
    assert.equal(tick({ ...inputs, mergedRowOpen: [] }, NOW).length, 1);
    assert.equal(readFileSyncOrEmpty(join(dir, FAILURE_LEDGER_FILE)), "", "nothing found, nothing recorded");
    tick(inputs, NOW);
    tick(inputs, NOW + 5 * MIN);
    const entries = parseFailureLedger(readFileSyncOrEmpty(join(dir, FAILURE_LEDGER_FILE)));
    assert.deepEqual(entries.map((e) => [e.classKey, e.ref]), [[ROW_NOT_FINISHABLE, "o/tracker#4001@o/code#7"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function readFileSyncOrEmpty(path: string): string {
  try { return readFileSync(path, "utf8"); } catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; }
}
