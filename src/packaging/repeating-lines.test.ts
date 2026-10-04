// no-token: gh -- every `gh` and `journalctl` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/repeating-lines.mjs` and its wiring in `work-gate.mjs`, #2848: A LOG LINE THAT REPEATS ABOUT A FAULT IS A DEFECT,
 * AND THE GATE NOW COUNTS THEM.
 *
 * THE POSITIVE CONTROL IS THE TWO LINES THE ROW WAS FILED ABOUT -- `NOT RELEASED decline of N ...` and `UNDELIVERED claim release not done --
 * decline of N ...`, 944 and 935 times in 24 hours of the real journal. Every "is NOT offered" below (K-1 ticks, an allowlisted line, a line that
 * stopped) is only worth anything because those two ARE offered, through the same entry, in the same file.
 *
 * THE THRESHOLD IS WRITTEN OUT AS 30 AND 29 HERE, NEVER AS `REPEAT_TICKS` AND `REPEAT_TICKS - 1`: a test built from the constant moves with it, so
 * raising K by one would leave it green. The literal is what makes the row's mutation (K + 1, K - 1) go red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPEAT_TICKS, normaliseLine, parseTicks, parseAllowlist, loadAllowlist, repeatingLines, repeatingLineOrders,
  repeatingLinesTick } from "../repeating-lines.mjs";
import { refusalReport } from "../wake.mjs";
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES, AGED_BACKLOG_MS, agedBacklogOrders, decide, readPromotableRows } from "../work-gate.mjs";

const GATE_ENTRY = fileURLToPath(new URL("../work-gate.mjs", import.meta.url));
const STUB_MODE = 0o755;
const TICK_MINUTES = 2;
const HOUR_MS = 3_600_000;

/** The two lines measured on 2026-10-01 at `b47add378`, with the numbers of ONE decline in them; `n` makes each copy a different one. */
const NOT_RELEASED = (n: number) => `NOT RELEASED decline of #${n} as worker-${n} did not land (Refusing rather than ignoring it: an ignored flag runs the default and reports success.)`;
const UNDELIVERED = (n: number) => `UNDELIVERED claim release not done -- decline of #${n} as worker-${n} did not land (Refusing rather than ignoring it: an ignored flag runs the default and reports success.)`;

const pad = (n: number) => String(n).padStart(2, "0");
/** One tick's `journalctl -o short-iso` text: systemd's start line, the lines, systemd's finish line. `finished: false` is the tick still running. */
function tickText(index: number, lines: string[], { finished = true } = {}) {
  const at = `2026-10-01T${pad(Math.floor((index * TICK_MINUTES) / 60))}:${pad((index * TICK_MINUTES) % 60)}:00+01:00`;
  const row = (unit: string, message: string) => `${at} agents ${unit}[1]: ${message}`;
  return [row("systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."),
    ...lines.map((l) => row("node", l)),
    ...(finished ? [row("systemd", "Finished a11ign-work-tick.service - a11ign: ask work-gate whether there is work.")] : [])].join("\n");
}
/** A journal of `perTick` entries, one array of raw lines per tick. */
const journal = (perTick: string[][], opts?: { lastFinished?: boolean }) =>
  perTick.map((lines, i) => tickText(i, lines, { finished: i < perTick.length - 1 || opts?.lastFinished !== false })).join("\n");
const ticksOf = (perTick: string[][]) => parseTicks(journal(perTick));
/** `count` ticks each carrying `make(i)`, so every copy of the line has different numbers in it. */
const run = (count: number, make: (i: number) => string[]) => Array.from({ length: count }, (_, i) => make(i));
const OWN_ALLOW = [{ pattern: /^SHELVED row #N: /, reason: "expected" }];

// --- the row's Acceptance, one test per sentence ----------------------------------------------------------------

test("#2848 THE POSITIVE CONTROL: the two measured lines, repeating 30 ticks with a different number each tick, are BOTH offered", () => {
  const ticks = ticksOf(run(30, (i) => [NOT_RELEASED(2600 + i), UNDELIVERED(2600 + i)]));
  const [group] = repeatingLines({ ticks, allow: loadAllowlist() });
  assert.deepEqual(group.lines, [NOT_RELEASED(2629), UNDELIVERED(2629)], "both lines, as the newest tick wrote them, in the order it wrote them");
  const orders = repeatingLineOrders(repeatingLines({ ticks, allow: loadAllowlist() }));
  assert.equal(orders.length, 1, "one fault, written as two lines that started together: ONE order, not two");
  assert.match(orders[0].prompt, /NOT RELEASED decline of #2629/);
  assert.match(orders[0].prompt, /UNDELIVERED claim release not done/);
});

test("#2848: the threshold is 30 consecutive ticks, about an hour at the 2-minute tick", () => {
  assert.equal(REPEAT_TICKS, 30);
});

test("#2848: a line repeated K=30 consecutive ticks is offered ONCE with its count and first-seen time; 29 is not", () => {
  const at30 = repeatingLines({ ticks: ticksOf(run(30, () => ["a fault line"])) });
  assert.equal(at30.length, 1);
  assert.equal(at30[0].count, 30);
  assert.equal(at30[0].since, "2026-10-01T00:00:00+01:00", "first-seen is the START of the run's first tick");
  assert.equal(at30[0].atLeast, true, "the run reaches the edge of the read, so the count is a floor");
  const orders = repeatingLineOrders(at30);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /AT LEAST 30 CONSECUTIVE TICKS/);
  assert.match(orders[0].prompt, /first seen 2026-10-01T00:00:00\+01:00/);
  assert.deepEqual(repeatingLines({ ticks: ticksOf(run(29, () => ["a fault line"])) }), [], "K-1 is the weather, not a fault");
});

test("#2848: a run that began INSIDE the read has an exact count and is not marked 'at least'", () => {
  const ticks = ticksOf([...run(5, () => ["unrelated"]), ...run(31, () => ["a fault line", "unrelated"])]);
  const [group] = repeatingLines({ ticks, allow: [{ pattern: /^unrelated$/, reason: "x" }] });
  assert.deepEqual([group.count, group.atLeast, group.since], [31, false, "2026-10-01T00:10:00+01:00"]);
});

test("#2848: an ALLOWLISTED line is never offered, however long it repeats -- and the same line unlisted IS", () => {
  const perTick = run(200, (i) => [`SHELVED row #${i}: blocked by #${i + 1} -- declared on the row, and it clears itself`]);
  assert.deepEqual(repeatingLines({ ticks: ticksOf(perTick), allow: OWN_ALLOW }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(perTick), allow: [] }).length, 1, "the control: without the entry it is a repeating line");
  assert.deepEqual(repeatingLines({ ticks: ticksOf(perTick), allow: loadAllowlist() }), [], "and the SHIPPED allowlist carries the row's own example");
});

test("#2848: a line that STOPS and restarts resets its count -- 29 ticks, one without it, then 29 more is not 58", () => {
  const withLine = ["a fault line"];
  const perTick = [...run(29, () => withLine), [], ...run(29, () => withLine)];
  assert.deepEqual(repeatingLines({ ticks: ticksOf(perTick) }), []);
  const long = [...run(29, () => withLine), [], ...run(30, () => withLine)];
  const [group] = repeatingLines({ ticks: ticksOf(long) });
  assert.deepEqual([group.count, group.atLeast], [30, false], "counted from the restart, and the gap proves the run began inside the read");
});

test("#2848: a line that stopped BEFORE the newest tick is not offered -- a repetition is something still happening", () => {
  assert.deepEqual(repeatingLines({ ticks: ticksOf([...run(40, () => ["a fault line"]), []]) }), []);
});

test("#2848: a NUMERIC or TIMESTAMP difference between two copies does not make them two lines (the normaliser the measurement used)", () => {
  assert.equal(normaliseLine(NOT_RELEASED(2623)), normaliseLine(NOT_RELEASED(2624)));
  assert.equal(normaliseLine("at 2026-10-01T06:50:37.123Z the row 7 failed"), normaliseLine("at 2026-09-30T01:02:03+01:00 the row 99 failed"));
  assert.equal(normaliseLine("primary checkout detached at origin/main (b264df33e16942447911ad499bac3bfa1eaf1964)"),
    normaliseLine("primary checkout detached at origin/main (a52bfdd9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5)"), "a commit sha is one line too");
  assert.notEqual(normaliseLine("defaced the row"), normaliseLine("N the row"), "an English word made of hex letters is not a sha");
  assert.notEqual(normaliseLine(NOT_RELEASED(1)), normaliseLine(UNDELIVERED(1)), "two different lines stay two");
  const [group] = repeatingLines({ ticks: ticksOf(run(30, (i) => [`order ${i} had nowhere to go at 2026-10-01T0${i % 10}:00:00Z`])) });
  assert.equal(group.count, 30, "thirty different spellings of one line are one run of thirty");
});

test("#2848: the offer names `orchestrator`, quotes the line, and its key does NOT move with the count", () => {
  const groups = (n: number) => repeatingLines({ ticks: ticksOf(run(n, (i) => [NOT_RELEASED(i)])) });
  const [early] = repeatingLineOrders(groups(30));
  const [later] = repeatingLineOrders(groups(300));
  assert.equal(early.session, "orchestrator");
  assert.equal(early.cause, "repeating-log-line");
  assert.match(early.prompt, /NOT RELEASED decline of #29 as worker-29/);
  assert.match(early.causeKey, /^orchestrator\/repeating-log-line\/[0-9a-f]{10}$/);
  assert.equal(early.causeKey, later.causeKey, "a key that moved with the count would re-ask every two minutes instead of once per window");
});

test("#2848: several faults are several orders, each carrying the others, capped at five", () => {
  // Four distinct start ticks, so four groups: each begins one tick later than the last.
  const perTick = run(40, (i) => ["fault A", ...(i >= 1 ? ["fault B"] : []), ...(i >= 2 ? ["fault C"] : []), ...(i >= 3 ? ["fault D"] : [])]);
  const orders = repeatingLineOrders(repeatingLines({ ticks: ticksOf(perTick) }));
  assert.equal(orders.length, 4);
  assert.match(orders[0].prompt, /ALSO REPEATING \(3\): "fault B"; "fault C"; "fault D"/);
  const many = run(60, (i) => Array.from({ length: 8 }, (_, f) => (i >= f ? `fault ${"ABCDEFGH"[f]}` : "")).filter(Boolean));
  assert.equal(repeatingLineOrders(repeatingLines({ ticks: ticksOf(many) })).length, 5, "a cap on the report");
});

// --- the reader: what a tick is, and what is not one -------------------------------------------------------------

test("#2848: the NEWEST tick is dropped when it has not finished -- the gate runs inside it, and a half-written tick must not break a run", () => {
  const perTick = run(31, () => ["a fault line"]);
  const running = parseTicks(journal([...perTick, ["only the first lines of this tick so far"]], { lastFinished: false }));
  assert.equal(running.length, 31, "the unfinished tick is not counted");
  assert.equal(repeatingLines({ ticks: running })[0].count, 31, "and its absence of the line does not reset the run");
});

test("#2848: systemd's own lines and the detector's OWN output are never lines; a detector must not count its report", () => {
  const ticks = ticksOf(run(40, () => ["repeating-lines: >=40 ticks since X: a fault line", "a fault line"]));
  assert.deepEqual(repeatingLines({ ticks }).map((g) => g.lines), [["a fault line"]]);
  assert.ok(![...ticks[0].lines.keys()].some((l) => /Starting|Finished/.test(l)), "the start and finish markers are not lines");
});

// --- the allowlist file ------------------------------------------------------------------------------------------

test("#2848: the SHIPPED allowlist loads, every entry has a reason, and it names the row's own SHELVED example", () => {
  const allow = loadAllowlist();
  assert.ok(allow.length >= 4, "a count that is not zero: the positive control for the emptiness below");
  assert.ok(allow.every((a) => a.reason.length > 40), "a reason is a sentence, not a word");
  assert.ok(allow.some((a) => a.pattern.test(normaliseLine("SHELVED row #2705: blocked by #2701 -- declared on the row, and it clears itself"))));
  // THE TWO FAULTS THE ROW EXISTS FOR ARE NOT ALLOWLISTED -- the guard the other way: an allowlist that swallowed them is the defect again.
  for (const fault of [NOT_RELEASED(1), UNDELIVERED(1), "2 order(s) had nowhere to go. A derived cause is NOT in the ledger"]) {
    assert.ok(!allow.some((a) => a.pattern.test(normaliseLine(fault))), `${fault.slice(0, 40)} must not be allowlisted`);
  }
});

test("#3497: the tick's version banner repeating 30 ticks is NOT offered, in both forms and across a release; the banner's FAULT forms still are", () => {
  const allow = loadAllowlist();
  const banner = (i: number) => [`agent-org v0.17.${i < 15 ? 1 : 2} (051edcc71f622bb3c2b4bbed3055fd4add32ed59)`, `agent-org v0.17.${i < 15 ? 1 : 2}`];
  assert.equal(repeatingLines({ ticks: ticksOf(run(30, banner)), allow: [] }).length, 1, "POSITIVE CONTROL: unlisted, the same 30 ticks ARE offered");
  assert.deepEqual(repeatingLines({ ticks: ticksOf(run(30, banner)), allow }), [], "listed, they are not");
  for (const fault of ["agent-org (version unreadable: boom)", "agent-org (at no release tag: 9f8e7d6)"]) {
    assert.equal(repeatingLines({ ticks: ticksOf(run(30, () => [fault])), allow }).length, 1, `${fault} still offered`);
  }
});

// --- #3029: the lines `wake.mjs` writes for a refusal, run through the detector as the journal would hold them ------

/** The stderr lines `finishTick` writes for these refusals at this wait, which is what the journal carries. */
const refusalLines = (refused: string[], waitMinutes: number) => {
  const report = refusalReport(refused, (keys) => new Map(keys.map((k) => [k, waitMinutes * 60_000])));
  return [...report.deferred.map((l) => `DEFERRED ${l}`), ...report.undelivered.map((l) => `UNDELIVERED ${l}`), ...(report.summary === null ? [] : [report.summary.trim()])];
};
const BUSY_CEO = `handoff/ceo/07ed9f53: "ceo" is working`;
const NOT_STARTED = `reviewer-agent-org-16/pr-review-due/pr-16/0a1b2c3d: herdr refused to start "reviewer-agent-org-16" (the workspace it opened was closed)`;

test("#3029: 30 ticks of a busy seat WAITING ITS TURN produce no repeating group, while the SAME 30 ticks of a refused-to-start order still do", () => {
  const allow = loadAllowlist();
  // The wait differs per copy (it cycles 2..14 minutes, under the 15-minute bound of #3448, past which the line is an UNDELIVERED fault, the next test) -- the normaliser must make them one line, or this proves nothing.
  const busy = ticksOf(run(30, (i) => refusalLines([BUSY_CEO], 2 * (1 + (i % 7)))));
  assert.equal([...(busy.at(-1)?.lines.values() ?? [])].filter((l) => l.startsWith("DEFERRED ")).length, 1, "the control: the lines are there, and the detector reads them");
  assert.deepEqual(repeatingLines({ ticks: busy, allow }), [], "waiting its turn is the queue working as designed");
  const stuck = repeatingLines({ ticks: ticksOf(run(30, (i) => refusalLines([NOT_STARTED], 2 * i))), allow });
  assert.equal(stuck.length, 1, "POSITIVE CONTROL: a dead end repeating 30 ticks is still a repeating group");
  assert.ok(stuck[0].lines.some((l) => /^\d+ order\(s\) had nowhere to go\./.test(l)), "and the summary line is in it");
});

test("#3029: a busy seat that stays busy PAST THE LIMIT is a fault again -- its UNDELIVERED line and the summary are not allowlisted", () => {
  const allow = loadAllowlist();
  const groups = repeatingLines({ ticks: ticksOf(run(30, (i) => refusalLines([BUSY_CEO], 16 + 2 * i))), allow });
  assert.equal(groups.length, 1);
  assert.ok(groups[0].lines.some((l) => l.startsWith("UNDELIVERED handoff/ceo/")), groups[0].lines.join(" | "));
  assert.ok(allow.some((a) => a.pattern.test(normaliseLine(`DEFERRED ${BUSY_CEO} (waiting 12 min; retried next tick)`))), "the DEFERRED line IS the allowlisted one");
  assert.ok(!allow.some((a) => a.pattern.test(normaliseLine(`UNDELIVERED ${BUSY_CEO} (deferred 16 min, over the 15-minute limit for a seat mid-turn)`))));
});

test("#2848: an allowlist entry with NO REASON, or no pattern, is refused at load: an exemption nobody explained is a silence", () => {
  assert.throws(() => parseAllowlist({ allow: [{ pattern: "^x" }] }), /no `reason`/);
  assert.throws(() => parseAllowlist({ allow: [{ pattern: "^x", reason: "  " }] }), /no `reason`/);
  assert.throws(() => parseAllowlist({ allow: [{ reason: "why" }] }), /no `pattern`/);
  assert.throws(() => parseAllowlist({}), /must be an array/);
  assert.equal(parseAllowlist({ allow: [{ pattern: "^x", reason: "because" }] }).length, 1, "the control: a complete entry loads");
});

// --- the tick: never throws, says what it found on stderr ----------------------------------------------------------

test("#2848: the tick reads the unit's journal, says each group on stderr, returns the orders, and says nothing when quiet", () => {
  const said: string[] = [];
  const asked: string[][] = [];
  const run30 = journal(run(31, (i) => [NOT_RELEASED(i), UNDELIVERED(i)]));
  const orders = repeatingLinesTick({ run: (args) => (asked.push(args), run30), log: (l) => said.push(l) });
  assert.equal(orders.length, 1);
  assert.deepEqual(asked[0].slice(0, 3), ["--user", "-u", "a11ign-work-tick"]);
  assert.equal(said.length, 1);
  assert.match(said[0], /^repeating-lines: >=31 ticks since 2026-10-01T00:00:00\+01:00: NOT RELEASED decline of #30/);

  const quiet: string[] = [];
  assert.deepEqual(repeatingLinesTick({ run: () => journal(run(5, () => ["x"])), log: (l) => quiet.push(l) }), []);
  assert.deepEqual(quiet, []);
});

test("#2848: a journal that cannot be read is SAID and yields no order -- and the line it says is not itself counted as a repetition", () => {
  const said: string[] = [];
  const orders = repeatingLinesTick({ run: () => { throw new Error("journalctl: not found\nstack"); }, log: (l) => said.push(l) });
  assert.deepEqual(orders, []);
  assert.match(said[0], /^repeating-lines: could not run \(journalctl: not found\) -- no order this tick\./);
  const ticks = ticksOf(run(40, () => [said[0].trim()]));
  assert.deepEqual(repeatingLines({ ticks }), [], "its own failure line, repeated for ever, is excluded in code");
});

// --- the causes exist, are judgment causes, and the gate runs the question ------------------------------------------

test("#2848: both causes are declared as JUDGMENT causes and neither is a START cause", () => {
  for (const cause of ["repeating-log-line", "backlog-aged-unpromoted"]) {
    assert.ok(CAUSES.includes(cause), `${cause} is declared`);
    assert.ok(JUDGMENT_CAUSES.includes(cause), `${cause} is re-asked on the judgment window, not every tick`);
    assert.ok(!START_CAUSES.includes(cause), `${cause} starts no work, so a drain does not withhold it`);
  }
});

/** The real gate as a process, with `gh` returning empty lists and `journalctl` printing `journalText`. */
function gateWithJournal(journalText: string) {
  const dir = mkdtempSync(join(tmpdir(), "repeating-gate-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"pr list\"*|\"issue list\"*) printf '%s' '[]' ;;\n  *) exit 1 ;;\nesac\n");
    writeFileSync(join(dir, "journal.txt"), journalText);
    writeFileSync(join(dir, "journalctl"), `#!/bin/sh\ncat "${join(dir, "journal.txt")}"\n`);
    chmodSync(join(dir, "gh"), STUB_MODE);
    chmodSync(join(dir, "journalctl"), STUB_MODE);
    const ran = spawnSync(process.execPath, [GATE_ENTRY], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const orders = ran.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cause: string; session: string; prompt: string });
    return { ran, orders };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2848: THE GATE AS A PROCESS wakes `orchestrator` with the two measured lines in the prompt, and stays silent about them at 29 ticks", () => {
  const live = gateWithJournal(journal(run(31, (i) => [NOT_RELEASED(2600 + i), UNDELIVERED(2600 + i)])));
  const offered = live.orders.filter((o) => o.cause === "repeating-log-line");
  assert.equal(offered.length, 1, live.ran.stderr);
  assert.equal(offered[0].session, "orchestrator");
  assert.match(offered[0].prompt, /NOT RELEASED decline of #2630/);
  assert.match(live.ran.stderr, /repeating-lines: >=31 ticks since/);
  const short = gateWithJournal(journal(run(29, (i) => [NOT_RELEASED(2600 + i), UNDELIVERED(2600 + i)])));
  assert.deepEqual(short.orders.filter((o) => o.cause === "repeating-log-line"), [], "the control: 29 ticks, same gate, same stubs");
});

// --- the second question: backlog rows older than 24 hours with no promotion decision ------------------------------------

const NOW = Date.parse("2026-10-01T12:00:00Z");
const backlogRow = (number: number, ageHours: number, extra: object = {}) =>
  ({ number, title: `row ${number}`, createdAt: new Date(NOW - ageHours * HOUR_MS).toISOString(), labels: [{ name: "backlog" }, { name: "lane:any" }], ...extra });

test("#2848: a promotable backlog row older than 24 h is offered to `product-manager`; one at 23 h is not", () => {
  assert.equal(AGED_BACKLOG_MS, 24 * HOUR_MS);
  const orders = agedBacklogOrders([backlogRow(2701, 25), backlogRow(2702, 23)], NOW);
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.subject]), [["product-manager", "backlog-aged-unpromoted", "row-2701"]]);
  assert.match(orders[0].prompt, /#2701 \(row 2701\) HAS BEEN IN BACKLOG 25h WITH NO PROMOTION DECISION/);
  assert.equal(orders[0].causeKey, "product-manager/backlog-aged-unpromoted/row-2701");
});

test("#2848: aged rows are oldest first, each carries the others, and a row with no readable date is not guessed at", () => {
  const orders = agedBacklogOrders([backlogRow(1, 30), backlogRow(2, 90), { number: 3, labels: [{ name: "backlog" }] }, backlogRow(4, 50)], NOW);
  assert.deepEqual(orders.map((o) => o.subject), ["row-2", "row-4", "row-1"]);
  assert.match(orders[0].prompt, /ALSO AGED \(2\): .*#4.*; .*#1/);
  assert.deepEqual(agedBacklogOrders([], NOW), []);
});

test("#2848: `decide` carries the aged question, `readPromotableRows` asks for the date it needs, and a row WITH a declared wait is never aged", () => {
  const aged = backlogRow(2701, 40);
  const waiting = backlogRow(2702, 40, { body: "Not-before: 2099-01-01" });
  const asked: string[][] = [];
  const read = readPromotableRows((args) => (asked.push(args), JSON.stringify([aged, waiting])));
  assert.deepEqual(read?.map((r) => r.number), [2701], "the row waiting on a date is not promotable stock, so it is not aged either");
  assert.match(asked[0].join(" "), /number,title,createdAt,labels,body,blockedBy/);
  const decided = decide({ prs: [], readyRows: [], promotableRows: read ?? [] });
  assert.deepEqual(decided.filter((o: { cause: string }) => o.cause === "backlog-aged-unpromoted").map((o: { subject: string }) => o.subject), ["row-2701"]);
});
