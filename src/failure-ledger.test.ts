// no-token: gh -- no `gh` call is made here; the recorders are handed their readings and a scratch directory (a11ign/a11ign#4450)
// #4450 (move 1a of #4437): the failure ledger records EVENTS that never become a closed row, and reads a repeat of one back.
//
// POSITIVE CONTROLS: "the same ref twice is not a repeat" has a twin over the same log with the ref changed, so a reader that never reports a repeat turns the twin red and one that
// always does turns the negative control red. The mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFailureClasses } from "./class-repeat.ts";
import { FAILURE_KINDS, FAILURE_LEDGER_FILE, mainRedEvents, parseFailureLedger, recordFailure, recordFailures, repeatsIn } from "./failure-ledger.ts";
import { handRerouteEvents, recordHandReroutes, type Change } from "./hand-fix-ledger.ts";
import { unresolvedOwnerEvents } from "./pr-ownership.ts";
import { HOME_CHECKOUT } from "./project-config.ts";

const NOW = Date.parse("2026-10-09T10:00:00Z");
const HOUR = 3_600_000;
const scratch = () => mkdtempSync(join(tmpdir(), "failure-ledger-"));

function inScratch(body: (dir: string, logPath: string) => void) {
  const dir = scratch();
  try { body(dir, join(dir, "state", FAILURE_LEDGER_FILE)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("two main-red events with different refs read back as one repeat of main-red", () => {
  inScratch((_dir, logPath) => {
    recordFailure({ logPath, classKey: "main-red", ref: "run/1", now: NOW });
    recordFailure({ logPath, classKey: "main-red", ref: "run/2", now: NOW + HOUR });
    const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
    assert.deepEqual(repeatsIn(entries, { windowMs: 24 * HOUR }), [{ classKey: "main-red", refs: ["run/1", "run/2"] }]);
  });
});

test("the same ref twice is NOT a repeat (negative control for the test above)", () => {
  inScratch((_dir, logPath) => {
    recordFailure({ logPath, classKey: "main-red", ref: "run/1", now: NOW });
    recordFailure({ logPath, classKey: "main-red", ref: "run/1", now: NOW + HOUR });
    const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
    assert.equal(entries.length, 2, "both lines are in the log; only the DISTINCT refs count");
    assert.deepEqual(repeatsIn(entries, { windowMs: 24 * HOUR }), []);
  });
});

test("one ref under two kinds is not a repeat of either, and an event older than the window is not counted", () => {
  const entries = parseFailureLedger("main-red\t1000\ta\nhand-reroute\t2000\ta\nmain-red\t3000\tb\n");
  assert.deepEqual(repeatsIn(entries, { windowMs: 5000 }).map((r) => r.classKey), ["main-red"]);
  assert.deepEqual(repeatsIn(entries, { windowMs: 1500, now: 3000 }), [], "the first main-red is outside the window, so only one ref is left");
});

test("a malformed line throws, naming the line", () => {
  for (const bad of ["main-red\tnot-a-time\tref\n", "main-red\t5\n", "main-red\t5\tref\textra\n", "\t5\tref\n"]) {
    assert.throws(() => parseFailureLedger(bad, "failure-ledger"), /failure-ledger has a line that is not/, JSON.stringify(bad));
  }
  assert.equal(parseFailureLedger("main-red\t5\tref\n\n").length, 1, "the twin: a well-formed line parses, so the throws above are about the line");
});

test("an append to an unwritable path is reported and does not throw out of the recorder", () => {
  inScratch((dir) => {
    writeFileSync(join(dir, "a-file"), "");
    const logPath = join(dir, "a-file", "failure-ledger"); // the parent is a FILE, so mkdir and append both refuse
    const reported: string[] = [];
    const result = recordFailure({ logPath, classKey: "main-red", ref: "run/1", now: NOW, report: (line) => reported.push(line) });
    assert.equal(result.appended, 0);
    assert.ok(result.refused !== null);
    assert.equal(reported.length, 1);
    assert.match(reported[0], /NOT RECORDED main-red run\/1/);
    const batch = recordFailures({ logPath, events: [{ classKey: "main-red", ref: "run/1" }], now: NOW, report: (line) => reported.push(line) });
    assert.equal(batch.appended, 0);
    assert.ok(reported.length > 1, "the batch reports its refusal too");
  });
});

test("a ref that would corrupt the log is refused and reported, not written", () => {
  inScratch((_dir, logPath) => {
    const reported: string[] = [];
    for (const ref of ["", "a\tb", "a\nb"]) recordFailure({ logPath, classKey: "main-red", ref, now: NOW, report: (line) => reported.push(line) });
    assert.equal(reported.length, 3);
    assert.equal(existsSync(logPath), false);
  });
});

test("recordFailures writes an event once however many ticks see it, and dates an event by its source when it has one", () => {
  inScratch((_dir, logPath) => {
    const events = [{ classKey: "main-red", ref: "run/1" }, { classKey: "hand-reroute", ref: "abc", at: NOW - HOUR }];
    assert.deepEqual(recordFailures({ logPath, events, now: NOW }), { appended: 2, skipped: 0, refused: null });
    assert.deepEqual(recordFailures({ logPath, events, now: NOW + HOUR }), { appended: 0, skipped: 2, refused: null }, "the second tick appends nothing");
    assert.deepEqual(recordFailures({ logPath, events: [{ classKey: "main-red", ref: "run/2" }], now: NOW + HOUR }).appended, 1, "twin: a new ref IS written");
    assert.deepEqual(parseFailureLedger(readFileSync(logPath, "utf8")).map((e) => [e.classKey, e.ref, e.at]),
      [["main-red", "run/1", NOW], ["hand-reroute", "abc", NOW - HOUR], ["main-red", "run/2", NOW + HOUR]]);
  });
});

test("a log with a malformed line is reported, and the new event is still written", () => {
  inScratch((_dir, logPath) => {
    recordFailure({ logPath, classKey: "main-red", ref: "run/1", now: NOW });
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}garbage\n`);
    const reported: string[] = [];
    const result = recordFailures({ logPath, events: [{ classKey: "main-red", ref: "run/2" }], now: NOW, report: (line) => reported.push(line) });
    assert.equal(result.appended, 1);
    assert.match(reported.join("\n"), /could not read .* to skip what is logged/);
  });
});

test("the source adapters: a red main, an unowned pull request, a hand fix", () => {
  assert.deepEqual(mainRedEvents({ url: "https://github.com/x/y/actions/runs/9", runId: 9 }), [{ classKey: "main-red", ref: "https://github.com/x/y/actions/runs/9" }]);
  assert.deepEqual(mainRedEvents(null), [], "a green or unreadable main records nothing");
  const sourceOf = (pr: any) => ({ source: pr.labelled ? "label" : "ceo" });
  const prs = [{ number: 1, labelled: true }, { number: 2 }, { number: 3, repo: "a11ign/agent-org" }];
  assert.deepEqual(unresolvedOwnerEvents(prs, sourceOf, "a11ign/a11ign"), [
    { classKey: "owner-unresolved", ref: "a11ign/a11ign#2" }, { classKey: "owner-unresolved", ref: "a11ign/agent-org#3" }]);
  const reading: any = { status: "read", current: { entries: [{ key: "pr-7", at: "2026-10-08T00:00:00Z" }] } };
  assert.deepEqual(handRerouteEvents(reading), [{ classKey: "hand-reroute", ref: "pr-7", at: Date.parse("2026-10-08T00:00:00Z") }]);
  assert.deepEqual(handRerouteEvents({ status: "unknown", current: null } as any), [], "an unread window is not a quiet one");
});

test("the hand-reroute recorder reads at most once a day, reports a refused read, and never throws", () => {
  inScratch((dir, logPath) => {
    const markerPath = join(dir, "state-marker");
    const change: Change = { key: "pr-7", number: 7, title: "t", at: new Date(NOW - 2 * HOUR).toISOString(), author: "DanBeckDev", actors: ["DanBeckDev"], body: null };
    let reads = 0;
    const read = () => { reads += 1; return [change]; };
    assert.equal(recordHandReroutes({ logPath, markerPath, now: NOW, read }), 1);
    assert.equal(recordHandReroutes({ logPath, markerPath, now: NOW + HOUR, read }), 0);
    assert.equal(reads, 1, "the second tick, an hour later, made no read");
    assert.equal(recordHandReroutes({ logPath, markerPath, now: NOW + 25 * HOUR, read }), 0, "a day later it reads again, and the change is already logged");
    assert.equal(reads, 2);
    const reported: string[] = [];
    const refused = () => { throw new Error("gh: HTTP 502"); };
    assert.equal(recordHandReroutes({ logPath, markerPath, now: NOW + 60 * HOUR, read: refused, report: (line) => reported.push(line) }), 0);
    assert.match(reported.join("\n"), /hand fixes not read \(gh: HTTP 502\)/);
  });
});

test("the six event kinds are seeded, and the index that carries them still parses", () => {
  assert.deepEqual([...FAILURE_KINDS], ["main-red", "pr-red", "owner-unresolved", "worker-excluded", "hand-reroute", "chairman-correction"]);
  const fixture = parseFailureClasses(JSON.stringify({ classes: FAILURE_KINDS.map((id) => ({ id, name: id, guard: null, guardNote: "n" })) }));
  assert.deepEqual(fixture?.map((c) => c.id), [...FAILURE_KINDS], "positive control: the parser carries the six when they are there");
  const real = join(HOME_CHECKOUT, ".agent-org/failure-classes.json");
  const index = existsSync(real) ? parseFailureClasses(readFileSync(real, "utf8")) : null;
  const carried = (index ?? []).map((c) => c.id);
  if (!FAILURE_KINDS.every((kind) => carried.includes(kind))) {
    // The index is the PROJECT's file (a11ign/a11ign), merged before this tool's pull request; until the host's checkout has it, only the fixture above is read.
    assert.ok(index === null || !carried.includes("main-red"), `${real} carries some of the six event kinds but not all: ${carried.join(",")}`);
    return;
  }
  for (const c of index!.filter((entry) => FAILURE_KINDS.includes(entry.id))) assert.ok(c.name !== "" && c.guard === null && (c.guardNote ?? "") !== "", `${c.id}: a name, guard null and a guardNote`);
  assert.ok(index!.some((c) => c.id === "unreleased-merge"), "the existing row-defect entries are left as they are");
});
