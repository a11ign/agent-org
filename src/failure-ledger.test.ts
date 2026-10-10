// no-token: gh -- no `gh` call is made here; the recorders are handed their readings and a scratch directory (a11ign/a11ign#4450)
// #4450 (move 1a of #4437): the failure ledger records EVENTS that never become a closed row, and reads a repeat of one back.
//
// POSITIVE CONTROLS: "the same ref twice is not a repeat" has a twin over the same log with the ref changed, so a reader that never reports a repeat turns the twin red and one that
// always does turns the negative control red. The mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFailureClasses } from "./class-repeat.ts";
import { FAILURE_KINDS, FAILURE_LEDGER_FILE, mainRedEpisodesPath, mainRedEvents, parseFailureLedger, recordFailure, recordFailures, repeatsIn } from "./failure-ledger.ts";
import { recordTickFailures } from "./failure-recorders.ts";
import { handRerouteEvents, recordHandReroutes, type Change } from "./hand-fix-ledger.ts";
import { unresolvedOwnerEvents } from "./pr-ownership.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { readLanes, scopesOf, scopeTick } from "./work-gate.ts";

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
  assert.deepEqual(mainRedEvents({ url: "https://github.com/x/y/actions/runs/9", runId: 9 }).events, [{ classKey: "main-red", ref: "https://github.com/x/y/actions/runs/9" }]);
  assert.deepEqual(mainRedEvents(null).events, [], "a green main records nothing");
  assert.deepEqual(mainRedEvents(undefined).events, [], "an unreadable main records nothing");
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
  // A kind is seeded with `guard: null` and a `guardNote`, and a guard is the intended end of that (a11ign#4833 wrote `main-red`'s): a name, and either a guard that says what it is or the note that says why there is none.
  for (const c of index!.filter((entry) => FAILURE_KINDS.includes(entry.id))) {
    assert.ok(c.name !== "" && (c.guard === null ? (c.guardNote ?? "") !== "" : String(c.guard).trim() !== ""), `${c.id}: a name, and a guard or a guardNote`);
  }
  assert.ok(index!.some((c) => c.id === "unreleased-merge"), "the existing row-defect entries are left as they are");
});

// #4475: a keyed repository's red `main` is recorded beside the primary's. Each test has its negative control in the same body (the twin the comment names).
const LEG = "checks (cross-repo)";
const redRun = (repo: string, runId: number, keyed = true, failedJobs: string[] = []) => ({ runId, url: `https://github.com/${repo}/actions/runs/${runId}`, sha: "a1b2c3d4e5f6789012345678901234567890abcd", failedJobs, failingTests: null, recheck: "unknown" as const, parentFailingTests: null, originPr: null, ...(keyed ? { repo, repoKey: repo.split("/")[1] } : {}) });
/** A keyed scope's reading as the tick hands it over: the repository it is of, and what `readTrunkRed` said (`null` a green, `undefined` not read). */
const keyedReading = (repo: string, red: ReturnType<typeof redRun> | null | undefined) => ({ repo, red });
const keyedRed = (repo: string, runId: number, failedJobs: string[] = []) => keyedReading(repo, redRun(repo, runId, true, failedJobs));
function ledgerAfter(dir: string, seen: { trunkRed?: any; keyedTrunkReds?: { repo: string | undefined, red: any }[]; now?: number }): string[] {
  const stateDir = join(dir, "state");
  // The hand-fix recorder reads `gh`; the marker makes it think it ran a moment ago, so it makes no read here.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${FAILURE_LEDGER_FILE}-hand-read`), String(NOW));
  recordTickFailures({ trunkRed: "trunkRed" in seen ? seen.trunkRed : null, keyedTrunkReds: seen.keyedTrunkReds ?? [], prs: [], stateDir, now: seen.now ?? NOW, ownerOf: () => ({ source: "label" }), homeRepo: "a11ign/a11ign" });
  const path = join(stateDir, FAILURE_LEDGER_FILE);
  return existsSync(path) ? parseFailureLedger(readFileSync(path, "utf8")).map((e) => `${e.classKey} ${e.ref}`) : [];
}

test("a keyed scope's red main appends one main-red line whose ref names that repository", () => {
  inScratch((dir) => {
    assert.deepEqual(ledgerAfter(dir, { keyedTrunkReds: [keyedRed("a11ign/agent-org", 77)] }), ["main-red https://github.com/a11ign/agent-org/actions/runs/77"]);
  });
  inScratch((dir) => assert.deepEqual(ledgerAfter(dir, { keyedTrunkReds: [] }), [], "twin: no keyed scope, no line"));
});

test("two repositories' reds with the same run number are two refs, and the same red read on two ticks is one line", () => {
  inScratch((dir) => {
    const reds = [keyedRed("a11ign/agent-org", 5), keyedRed("a11ign/lab", 5)];
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: reds }).length, 2, "same run id, two repositories");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: reds, now: NOW + HOUR }).length, 2, "the second tick appends nothing");
    // agent-org#674: a later red RUN of a red still standing is not a new line; the same red after a green is (the twin of this, with the green, is the standing-red tests below)
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed("a11ign/agent-org", 6)], now: NOW + 2 * HOUR }).length, 2, "a later run of the red still standing is no new line");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedReading("a11ign/agent-org", null)], now: NOW + 3 * HOUR }).length, 2, "a green appends nothing");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed("a11ign/agent-org", 7)], now: NOW + 4 * HOUR }).length, 3, "twin: a red after a green IS a new line");
  });
});

test("a green or unreadable main and a scope with no code repository append nothing", () => {
  inScratch((dir) => assert.deepEqual(ledgerAfter(dir, { keyedTrunkReds: [keyedReading("a11ign/lab", null), keyedReading("a11ign/agent-org", undefined), { repo: undefined, red: undefined }] }), []));
  inScratch((dir) => assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedReading("a11ign/lab", null), { repo: undefined, red: undefined }, keyedRed("a11ign/lab2", 1)] }).length, 1, "twin: the red one among them is recorded"));
});

test("the primary's recorded line is unchanged by the keyed readings beside it", () => {
  inScratch((dir) => {
    const primary = redRun("a11ign/a11ign", 9, false);
    assert.deepEqual(ledgerAfter(dir, { trunkRed: primary }), ["main-red https://github.com/a11ign/a11ign/actions/runs/9"]);
  });
  inScratch((dir) => {
    const lines = ledgerAfter(dir, { trunkRed: redRun("a11ign/a11ign", 9, false), keyedTrunkReds: [keyedRed("a11ign/agent-org", 9)] });
    assert.deepEqual(lines, ["main-red https://github.com/a11ign/a11ign/actions/runs/9", "main-red https://github.com/a11ign/agent-org/actions/runs/9"], "twin: the keyed line is added after it, the primary's is the same");
  });
});

test("a keyed red with no url is still named by its repository", () => {
  assert.deepEqual(mainRedEvents({ runId: 3, repo: "a11ign/lab" }).events, [{ classKey: "main-red", ref: "a11ign/lab/runs/3" }]);
  assert.deepEqual(mainRedEvents({ runId: 3 }).events, [{ classKey: "main-red", ref: "primary/runs/3" }], "twin: the primary's fallback is unchanged");
  assert.deepEqual(mainRedEvents({ failedJobs: [LEG] }, null), { events: [], open: null }, "a red that names no run is no event");
});

/**
 * agent-org#674: A STANDING RED IS COUNTED ONCE, NOT ONCE PER RUN. The refs are lab's own, measured 2026-10-10: the nightly of 10:38Z (38045596539) and the pushes of lab#62 and
 * lab#63 (38055200478, 38056110285) were one failed job, `checks (cross-repo)`, three refs, and `class-repeat` read its own counter as a failed guard.
 * Each case below drives the tick itself (`recordTickFailures`, two ticks or more, over one state directory) and reads the ledger back, and each carries its negative control.
 */
const NIGHTLY = 38045596539;
const PUSH_62 = 38055200478;
const PUSH_63 = 38056110285;
const LAB_REPO = "a11ign/lab";

test("a standing red is ONE ref: two red runs of the same failed job, with different run ids, record the first run only", () => {
  inScratch((dir) => {
    assert.deepEqual(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, NIGHTLY, [LEG])] }), [`main-red https://github.com/a11ign/lab/actions/runs/${NIGHTLY}`]);
    const second = ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])], now: NOW + HOUR });
    assert.deepEqual(second, [`main-red https://github.com/a11ign/lab/actions/runs/${NIGHTLY}`], "the push is the same red: still one line, and it points at the run that opened it");
    const third = ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + 2 * HOUR });
    assert.equal(third.length, 1, "and so is the next one");
    assert.equal(repeatsIn(parseFailureLedger(readFileSync(join(dir, "state", FAILURE_LEDGER_FILE), "utf8")), { windowMs: 7 * 24 * HOUR }).length, 0, "which is no repeat for class-repeat to read");
  });
  // NEGATIVE CONTROL: the same two runs of two DIFFERENT repositories are two reds -- the rule is per repository, and a standing red of one hides nothing of another.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, NIGHTLY, [LEG])] });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed("a11ign/agent-org", PUSH_62, [LEG])], now: NOW + HOUR }).length, 2);
  });
  // The primary's own `main` is read the same way: a red with no `repo` of its own is the home repository's.
  inScratch((dir) => {
    ledgerAfter(dir, { trunkRed: redRun("a11ign/a11ign", 1, false, ["trunkBuildTest / run"]) });
    assert.equal(ledgerAfter(dir, { trunkRed: redRun("a11ign/a11ign", 2, false, ["trunkBuildTest / run"]), now: NOW + HOUR }).length, 1);
  });
});

test("a standing red that went green in between is TWO refs: a green reading ends it, and the next red is a new one", () => {
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    ledgerAfter(dir, { keyedTrunkReds: [keyedReading(LAB_REPO, null)], now: NOW + HOUR });
    const lines = ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + 2 * HOUR });
    assert.deepEqual(lines, [`main-red https://github.com/a11ign/lab/actions/runs/${PUSH_62}`, `main-red https://github.com/a11ign/lab/actions/runs/${PUSH_63}`], "the same job again after a green is a second red");
  });
  // NEGATIVE CONTROL: the same sequence with no green between records one.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + 2 * HOUR }).length, 1);
  });
  // A green of ANOTHER repository does not end this one's.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    ledgerAfter(dir, { keyedTrunkReds: [keyedReading("a11ign/agent-org", null), keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + HOUR });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, 38056840774, [LEG])], now: NOW + 2 * HOUR }).length, 1);
  });
});

test("a standing red does not hide a second red: a different failed job, while the first is still red, is a new ref", () => {
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    const lines = ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG, "checks (own)"])], now: NOW + HOUR });
    assert.deepEqual(lines, [`main-red https://github.com/a11ign/lab/actions/runs/${PUSH_62}`, `main-red https://github.com/a11ign/lab/actions/runs/${PUSH_63}`], "an added job is a second red");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, 38056840774, [LEG, "checks (own)"])], now: NOW + 2 * HOUR }).length, 2, "and it is then standing in its turn");
  });
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, ["checks (own)"])], now: NOW + HOUR }).length, 2, "a different job in place of the first is a second red too");
  });
  // NEGATIVE CONTROL: the same job again, and fewer jobs than before (something was fixed), are the same red.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG, "checks (own)"])] });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + HOUR }).length, 1, "one job fixed: the same red, no new ref");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, 38056840774, [LEG, "checks (own)"])], now: NOW + 2 * HOUR }).length, 2, "the fixed job failing again is a new red");
  });
});

test("a standing red is not ended by an unreadable reading: a reading that was not read between two reds records one ref", () => {
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    ledgerAfter(dir, { keyedTrunkReds: [keyedReading(LAB_REPO, undefined)], now: NOW + HOUR });
    ledgerAfter(dir, { keyedTrunkReds: [keyedReading(LAB_REPO, undefined)], now: NOW + 2 * HOUR });
    const lines = ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + 3 * HOUR });
    assert.deepEqual(lines, [`main-red https://github.com/a11ign/lab/actions/runs/${PUSH_62}`], "an API blip is no green");
  });
  // NEGATIVE CONTROL: the same sequence with a GREEN where the unreadable one was is two. This is the pair the reading must keep apart.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    ledgerAfter(dir, { keyedTrunkReds: [keyedReading(LAB_REPO, null)], now: NOW + HOUR });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + 3 * HOUR }).length, 2);
  });
  // A red whose jobs could not be read (no job names) is still the same red, and names its jobs when they are read again.
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [])], now: NOW + HOUR }).length, 1, "no job named: not a different job");
  });
});

test("a standing red is kept in its own file, so the ledger's format is as it was, and a file that cannot be read costs a ref and no more", () => {
  inScratch((dir) => {
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])] });
    const state = join(dir, "state");
    assert.deepEqual(JSON.parse(readFileSync(join(state, mainRedEpisodesPath(FAILURE_LEDGER_FILE)), "utf8")), { [LAB_REPO]: { ref: `https://github.com/a11ign/lab/actions/runs/${PUSH_62}`, jobs: [LEG] } });
    assert.match(readFileSync(join(state, FAILURE_LEDGER_FILE), "utf8"), /^main-red\t\d+\thttps:\/\/github\.com\/a11ign\/lab\/actions\/runs\/\d+\n$/, "one `<classKey>\\t<ts>\\t<ref>` line");
    ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_63, [LEG])], now: NOW + HOUR });
    assert.equal(JSON.parse(readFileSync(join(state, mainRedEpisodesPath(FAILURE_LEDGER_FILE)), "utf8"))[LAB_REPO].ref, `https://github.com/a11ign/lab/actions/runs/${PUSH_62}`, "a later run of it leaves the ref at the run that opened it");
    writeFileSync(join(state, mainRedEpisodesPath(FAILURE_LEDGER_FILE)), "{ not json");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, 38056840774, [LEG])], now: NOW + 2 * HOUR }).length, 2, "an unreadable file reads as no standing red: the next run is a new ref");
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, 38056840775, [LEG])], now: NOW + 3 * HOUR }).length, 2, "and the file is written again, so the one after is standing");
  });
});

test("the standing red is saved only when the ledger took the line, so a refused append is retried", () => {
  inScratch((dir) => {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const episodes = join(stateDir, mainRedEpisodesPath(FAILURE_LEDGER_FILE));
    const logPath = join(stateDir, FAILURE_LEDGER_FILE);
    mkdirSync(logPath); // a directory where the ledger should be: every append is refused
    writeFileSync(join(stateDir, `${FAILURE_LEDGER_FILE}-hand-read`), String(NOW));
    const reported: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((line: string) => { reported.push(String(line)); return true; }) as typeof process.stderr.write;
    try {
      recordTickFailures({ trunkRed: null, keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])], prs: [], stateDir, now: NOW, ownerOf: () => ({ source: "label" }), homeRepo: "a11ign/a11ign", say: () => {} });
    } finally {
      process.stderr.write = stderr;
    }
    assert.equal(existsSync(episodes), false, "nothing was recorded, so nothing is standing");
    assert.match(reported.join(""), /NOT RECORDED main-red/);
    rmSync(logPath, { recursive: true });
    assert.equal(ledgerAfter(dir, { keyedTrunkReds: [keyedRed(LAB_REPO, PUSH_62, [LEG])], now: NOW + HOUR }).length, 1, "the next tick records it");
    assert.equal(existsSync(episodes), true);
  });
});
