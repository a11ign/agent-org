// no-token: gh -- `unpark-satisfied.ts` reaches GitHub only through the `UnparkIo` it is given; every one this file builds is a fake over an in-memory world, so nothing here writes a row (a11ign/a11ign#4050)
// a11ign/a11ign#4050: a parked row whose EVERY condition is true is un-parked on the tick, to `ready` or to `backlog` + `answer:product-manager`.
//
// THE POSITIVE CONTROL for every "writes nothing" below is the first test: the SAME harness (`world`, `run`) un-parks a row there, so an empty `calls` is a reading of a wired pass and not of
// a pass that cannot write. Each "untouched" case differs from a transitioning one by ONE fact.
import { TSX_IMPORT } from "./tsx-import.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardTruthAudit, QUESTIONS } from "./board-truth-audit.ts";
import { PARKED_LABEL } from "./work-gate.ts";
import { MUTEX_LABELS } from "./ready-label-audit.ts";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import * as unpark from "./unpark-satisfied.ts";
import { COMMENT_MARKER, NOT_PICKABLE_BESIDE_READY, PARKED, commentFor, githubIo, ineligibility, mergedClosersOf, readSatisfaction, reportUnpark, unparkSatisfied, unparkingWaits } from "./unpark-satisfied.ts";

const NOW = Date.parse("2026-10-11T00:05:00Z");
const PASSED = "2026-10-11T00:00:00Z";
const FUTURE = "2026-10-14T00:00:00Z";
const CLOSED_AT = Date.parse("2026-10-08T05:00:00Z");

/** A body the claim rule accepts: Region, Acceptance and Open-check each with content. */
const COMPLETE = "## What it is\n\nthe work\n\n## Region\n\n```\nsrc/thing.mjs\n```\n\n## Acceptance\n\n```bash\nnode --test src/thing.test.mjs\n```\n\n## Open-check\n\n```\n$ ls src/thing.mjs\nls: cannot access\n```\n";

/** @param {number} number @param {string[]} labels @param {Record<string, any>} [more] a row as the tick's open-row read gives it */
const tickRow = (number: number, labels: string[], more: Record<string, any> = {}) => ({ number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: COMPLETE, blockedBy: { nodes: [] }, ...more });
/** @param {Record<string, any>} items */
const factsOf = (items: Record<string, any>) => ({ items });
const closedFact = { state: "closed", labels: [], resolvedAt: CLOSED_AT, changedAt: CLOSED_AT };
const openFact = { state: "open", labels: [], resolvedAt: null, changedAt: null };

/**
 * A GitHub in memory. `labels` is what each row carries; every call is logged in `calls`; `fail` names a call (`readLabels`, `setLabels`, `mergedClosers`, `promote`, `comment`) that throws for a row.
 * @param {{ rows: Record<number, string[]>, merged?: Record<number, { number: number, mergedAt: string }>, refuse?: Record<number, string>, fail?: Record<string, number[]> }} setup
 */
function world({ rows, merged = {}, refuse = {}, fail = {} }: { rows: Record<number, string[]>; merged?: Record<number, { number: number; mergedAt: string; }>; refuse?: Record<number, string>; fail?: Record<string, number[]>; }) {
  const labels = Object.fromEntries(Object.entries(rows).map(([n, l]) => [n, [...l]]));
  const calls: string[] = [];
  const comments: Record<number, string[]> = {};
  const maybeFail = (call: string, n: number) => { if (fail[call]?.includes(n)) throw new Error(`HTTP 502 on ${call} #${n}`); };
  const io: import("./unpark-satisfied.ts").UnparkIo = {
    readLabels: (n) => { calls.push(`readLabels ${n}`); maybeFail("readLabels", n); return { labels: [...labels[n]], state: "OPEN" }; },
    setLabels: (n, set) => { calls.push(`setLabels ${n} ${set.join(",")}`); maybeFail("setLabels", n); labels[n] = [...set]; },
    promote: (n) => {
      calls.push(`promote ${n}`); maybeFail("promote", n);
      if (refuse[n]) return { ok: false, refusal: refuse[n] };
      labels[n] = ["ready", ...labels[n].filter((l) => l !== "backlog")];
      return { ok: true };
    },
    mergedClosers: (n) => { calls.push(`mergedClosers ${n}`); maybeFail("mergedClosers", n); return merged[n] ? [merged[n]] : []; },
    closedAt: () => CLOSED_AT,
    comment: (n, body) => { calls.push(`comment ${n}`); maybeFail("comment", n); (comments[n] ??= []).push(body); },
  };
  /** @returns {any[]} the tick's rows as the world stands */
  const tickRows = (more: Record<number, Record<string, any>> = {}): any[] => Object.entries(labels).map(([n, l]) => tickRow(Number(n), l, more[Number(n)] ?? {}));
  return { io, labels, calls, comments, tickRows };
}

/** @param {string[]} labels @returns {string | null} the verdict on a complete row carrying these labels with nothing merged against it */
const ineligibilityOf = (labels: string[]): string | null => ineligibility(tickRow(1, labels), labels, () => []);
/** @param {any} row @param {any} facts */
const satisfied = (row: any, facts: any = factsOf({})) => readSatisfaction(row, facts, NOW);

test("(1) a parked row whose Not-before passed, with a complete body, becomes ready with ONE comment -- the positive control", () => {
  const w = world({ rows: { 10: ["parked", "lane:any"] } });
  const rows = [tickRow(10, ["parked", "lane:any"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` })];
  const result = unparkSatisfied({ rows, facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual(result.unparked, [{ number: 10, to: "ready", why: null }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(w.labels[10], ["ready", "lane:any"], "parked is gone, ready is on, and the lane label is kept");
  assert.equal(w.comments[10].length, 1, "one comment per transition");
  assert.ok(w.comments[10][0].startsWith(COMMENT_MARKER));
  assert.match(w.comments[10][0], /`Not-before: 2026-10-11T00:00:00Z` -- true since 2026-10-11T00:00:00\.000Z/, "it names the condition and the time it became true");
  assert.deepEqual(w.calls, ["readLabels 10", "mergedClosers 10", "setLabels 10 backlog,lane:any", "promote 10", "comment 10"],
    "backlog is written BEFORE the promotion, and the comment LAST");
});

test("(2) a row whose Waiting-for: closed #n is still open is untouched; the twin with #n closed is un-parked", () => {
  const body = `${COMPLETE}\nWaiting-for: closed #50\n`;
  const stand = world({ rows: { 11: ["parked"] } });
  const kept = unparkSatisfied({ rows: [tickRow(11, ["parked"], { body })], facts: factsOf({ "#50": openFact }), now: NOW }, stand.io);
  assert.deepEqual([kept.unparked, kept.errors, stand.calls], [[], [], []], "nothing is read or written");
  const done = world({ rows: { 11: ["parked"] } });
  const moved = unparkSatisfied({ rows: [tickRow(11, ["parked"], { body })], facts: factsOf({ "#50": closedFact }), now: NOW }, done.io);
  assert.deepEqual(moved.unparked.map((u) => u.number), [11], "the twin differs by ONE fact: #50 is closed");
  assert.match(done.comments[11][0], /`Waiting-for: closed #50` -- true since 2026-10-08T05:00:00\.000Z/);
});

test("(3) one true condition and one false are untouched: EVERY condition, not any", () => {
  const cases = [
    ["a passed date and an open Waiting-for", { body: `${COMPLETE}\nNot-before: ${PASSED}\nWaiting-for: closed #50\n` }, { "#50": openFact }],
    ["a closed Waiting-for and a future date", { body: `${COMPLETE}\nNot-before: ${FUTURE}\nWaiting-for: closed #50\n` }, { "#50": closedFact }],
    ["a closed Waiting-for and an OPEN native edge", { body: `${COMPLETE}\nWaiting-for: closed #50\n`, blockedBy: { nodes: [{ number: 7, state: "OPEN" }] } }, { "#50": closedFact }],
    ["a passed date and an answer:<session> label", { body: `${COMPLETE}\nNot-before: ${PASSED}\n`, extra: "answer:ceo" }, {}],
    ["a closed Waiting-for and a hold label", { body: `${COMPLETE}\nWaiting-for: closed #50\n`, extra: "hold:ceo" }, { "#50": closedFact }],
  ];
  for (const [name, more, items] of (cases as [string, any, any][])) {
    const labels = ["parked", ...(more.extra ? [more.extra] : [])];
    const w = world({ rows: { 12: labels } });
    const result = unparkSatisfied({ rows: [tickRow(12, labels, more)], facts: factsOf(items), now: NOW }, w.io);
    assert.deepEqual([result.unparked, w.calls], [[], []], name);
  }
});

test("(4) a satisfied row that fails the eligibility check becomes backlog + answer:product-manager with the failing check named", () => {
  const w = world({ rows: { 13: ["parked", "lane:any"] } });
  const thin = tickRow(13, ["parked", "lane:any"], { body: `## What it is\n\nnothing to build yet\n\nNot-before: ${PASSED}\n` });
  const result = unparkSatisfied({ rows: [thin], facts: factsOf({}), now: NOW }, w.io);
  assert.equal(result.unparked[0].to, "backlog");
  assert.deepEqual(w.labels[13], ["backlog", "answer:product-manager", "lane:any"]);
  assert.match(result.unparked[0].why ?? "", /#13 is missing Region, Acceptance, Open-check/);
  assert.match(w.comments[13][0], /does NOT pass the check[\s\S]*missing Region, Acceptance, Open-check/);
  assert.ok(!w.calls.includes("promote 13"), "a row that fails the in-process check is never promoted");
});

test("(4b) each check of a ready row is its own failure: a blocking label, a merged closing PR, and the promotion's own refusal", () => {
  const body = `${COMPLETE}\nNot-before: ${PASSED}\n`;
  const mutex = world({ rows: { 14: ["parked", "decision"] } });
  const m = unparkSatisfied({ rows: [tickRow(14, ["parked", "decision"], { body })], facts: factsOf({}), now: NOW }, mutex.io);
  assert.match(m.unparked[0].why ?? "", /`decision`, which already mean "not pickable"/);
  const merged = world({ rows: { 15: ["parked"] }, merged: { 15: { number: 99, mergedAt: "2026-10-01T00:00:00Z" } } });
  const g = unparkSatisfied({ rows: [tickRow(15, ["parked"], { body })], facts: factsOf({}), now: NOW }, merged.io);
  assert.match(g.unparked[0].why ?? "", /PR #99 .* already names it/, "the #2905 shape: closed edges alone, nothing left to build");
  const refused = world({ rows: { 16: ["parked"] }, refuse: { 16: "the Acceptance names the whole suite" } });
  const r = unparkSatisfied({ rows: [tickRow(16, ["parked"], { body })], facts: factsOf({}), now: NOW }, refused.io);
  assert.deepEqual([r.unparked[0].to, refused.labels[16]], ["backlog", ["backlog", "answer:product-manager"]]);
  assert.match(refused.comments[16][0], /whole suite/, "the promotion's refusal is the named check");
  assert.deepEqual(refused.calls.filter((c) => c.startsWith("setLabels")), ["setLabels 16 backlog", "setLabels 16 backlog,answer:product-manager"]);
});

test("(5) a second pass over the result writes nothing", () => {
  const w = world({ rows: { 10: ["parked"], 13: ["parked"] } });
  const more = { 10: { body: `${COMPLETE}\nNot-before: ${PASSED}\n` }, 13: { body: `thin\nNot-before: ${PASSED}\n` } };
  const rows = w.tickRows(more);
  const first = unparkSatisfied({ rows, facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual(first.unparked.map((u) => u.to), ["ready", "backlog"]);
  const written = w.calls.length;
  const again = unparkSatisfied({ rows, facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual([again.unparked, again.errors, w.calls.length], [[], [], written], "the tick's own objects were updated, so nothing is parked");
  const reread = unparkSatisfied({ rows: w.tickRows(more), facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual([reread.unparked, w.calls.length], [[], written], "and so is a fresh read of the world");
});

test("(6) a parked row with NO condition, and one carrying needs:chairman, are untouched; so are a claimed row and a row that is not parked", () => {
  const bare = world({ rows: { 20: ["parked"], 21: ["parked", "needs:chairman"], 22: ["parked", "in-progress"], 23: ["backlog"] } });
  const rows = [tickRow(20, ["parked"]), tickRow(21, ["parked", "needs:chairman"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` }),
    tickRow(22, ["parked", "in-progress"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` }), tickRow(23, ["backlog"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` })];
  const result = unparkSatisfied({ rows, facts: factsOf({}), now: NOW }, bare.io);
  assert.deepEqual([result.unparked, result.errors, bare.calls], [[], [], []]);
  assert.match(JSON.stringify(satisfied(rows[0])), /declares no condition/);
  assert.match(JSON.stringify(satisfied(rows[1])), /needs:chairman/);
});

test("(7) GitHub failing on a read is an error naming the row, not a silent skip -- and the other rows still go", () => {
  const body = `${COMPLETE}\nNot-before: ${PASSED}\n`;
  for (const call of ["readLabels", "mergedClosers"]) {
    const w = world({ rows: { 30: ["parked"], 31: ["parked"] }, fail: { [call]: [30] } });
    const result = unparkSatisfied({ rows: [tickRow(30, ["parked"], { body }), tickRow(31, ["parked"], { body })], facts: factsOf({}), now: NOW }, w.io);
    assert.equal(result.errors.length, 1, call);
    assert.equal(result.errors[0].number, 30);
    assert.match(result.errors[0].message, new RegExp(`HTTP 502 on ${call} #30`));
    assert.deepEqual(w.labels[30], ["parked"], "the row whose read failed is still parked, and will be asked again");
    assert.deepEqual(result.unparked.map((u) => u.number), [31], "one row's failure does not stop the next");
    const lines: any[] = [];
    reportUnpark(result, (line) => lines.push(line));
    assert.ok(lines.some((l) => /COULD NOT unpark #30: HTTP 502/.test(l)), "and it is said where the tick's log is");
  }
});

test("(7b) a condition the tick could not READ is listed as unread and never read as true", () => {
  const w = world({ rows: { 32: ["parked"] } });
  const row = tickRow(32, ["parked"], { body: `${COMPLETE}\nWaiting-for: closed #999\n` });
  const result = unparkSatisfied({ rows: [row], facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual([result.unparked, w.calls], [[], []]);
  assert.match(result.unread[0].reason, /closed #999.*could not be read/);
  const manual = satisfied(tickRow(33, ["parked"], { body: `${COMPLETE}\nWaiting-for: manual\n` }));
  assert.equal(manual.verdict, "untouched", "a manual wait is not a condition that came true");
});

test("native edges: all closed is a condition, dated by the blocker's close; an unreadable Not-before keeps the row parked", () => {
  const edges = { nodes: [{ number: 3410, state: "CLOSED" }, { number: 3418, state: "CLOSED" }] };
  const w = world({ rows: { 40: ["parked"] } });
  const result = unparkSatisfied({ rows: [tickRow(40, ["parked"], { blockedBy: edges })], facts: factsOf({}), now: NOW }, w.io);
  assert.equal(result.unparked[0].to, "ready");
  assert.match(w.comments[40][0], /`blockedBy #3410 \(closed\)` -- true since 2026-10-08T05:00:00\.000Z/);
  const unreadable = satisfied(tickRow(41, ["parked"], { body: `${COMPLETE}\nNot-before: 2026-02-30\nWaiting-for: closed #50\n` }), factsOf({ "#50": closedFact }));
  assert.equal(unreadable.verdict, "untouched");
});

test("the row changed under the tick: a fresh read that no longer says parked is left alone", () => {
  const w = world({ rows: { 50: ["backlog"] } });
  const stale = tickRow(50, ["parked"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` });
  const result = unparkSatisfied({ rows: [stale], facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual([result.unparked, w.calls], [[], ["readLabels 50"]]);
});

test("the tick's seam: waits are read once, acted on, and returned unchanged; a refused read un-parks nothing", () => {
  const w = world({ rows: { 60: ["parked"] } });
  const rows = [tickRow(60, ["parked"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n` })];
  const said: string[] = [];
  const waits = { facts: factsOf({}), stale: [], bare: [], manual: 0, umbrella: [] };
  const wrapped = unparkingWaits(() => waits, { run: () => "", io: w.io, log: (line) => said.push(line) });
  assert.equal(wrapped({ prsRead: [], openRowsRead: rows, now: NOW }), waits);
  assert.deepEqual(w.labels[60], ["ready"]);
  assert.match(said[0], /DID unpark #60 -> ready/);
  const refused = world({ rows: { 61: ["parked"] } });
  const none = unparkingWaits(() => null, { run: () => "", io: refused.io, log: () => {} });
  assert.equal(none({ prsRead: null, openRowsRead: [tickRow(61, ["parked"])], now: NOW }), null);
  assert.deepEqual(refused.calls, []);
});

test("the board audit, later in the SAME tick, no longer counts the row that was just un-parked", () => {
  const w = world({ rows: { 70: ["parked"] } });
  const rows = [tickRow(70, ["parked"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n`, state: "OPEN" })];
  const audit = () => boardTruthAudit({ now: NOW, openRows: rows, closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: factsOf({}) }).findings.filter((f) => f.question === QUESTIONS.WAIT_TRUE);
  assert.equal(audit().length, 1, "positive control: before the pass the audit finds the row");
  unparkSatisfied({ rows, facts: factsOf({}), now: NOW }, w.io);
  assert.deepEqual(audit(), []);
});

test("the comment says why, in each shape", () => {
  const conditions = [{ text: "Waiting-for: published a11ign@latest", since: null }];
  assert.match(commentFor({ to: "ready", conditions, why: null, now: NOW }), /not dated \(read true at this tick\)[\s\S]*`parked` -> `ready`/);
  assert.match(commentFor({ to: "backlog", conditions, why: "it has no Region", now: NOW }), /it has no Region[\s\S]*`backlog` with `answer:product-manager`/);
});

test("pins: the parked label is the gate's, and the gate wires the pass into the wait read", () => {
  assert.equal(PARKED, PARKED_LABEL);
  assert.match(readFileSync(new URL("./work-gate.ts", import.meta.url), "utf8"), /readWaits: unparkingWaits\(waitTickFacts, \{ run: defaultRun \}\)/, "the call site that makes the pass run every tick");
});

test("pin: the labels that block a ready row are the audit's own, one by one", () => {
  assert.deepEqual([...NOT_PICKABLE_BESIDE_READY], [...MUTEX_LABELS], "restated in the gate's closure because ready-label-audit.ts cannot be imported there; this is what keeps the copy honest");
  assert.ok(NOT_PICKABLE_BESIDE_READY.length > 0, "positive control for the loop below");
  for (const label of NOT_PICKABLE_BESIDE_READY) {
    assert.match(String(ineligibilityOf([label])), new RegExp(`\\\`${label}\\\``), `${label} fails the check`);
  }
  assert.equal(ineligibilityOf(["lane:any"]), null, "and a row with none of them passes it");
});

test("the merged-closer read: only MERGED pull requests count, and a refused or malformed answer throws rather than reading as none", () => {
  const answer = (nodes: any) => () => JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } });
  assert.deepEqual(mergedClosersOf(5, answer([{ number: 9, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" }, { number: 10, state: "OPEN", mergedAt: null }, { number: 11, state: "CLOSED", mergedAt: null }])),
    [{ number: 9, mergedAt: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(mergedClosersOf(5, answer([])), [], "none is a reading when the shape is right");
  assert.throws(() => mergedClosersOf(5, () => "{}"), /#5 could not be read/);
  assert.throws(() => mergedClosersOf(5, () => { throw new Error("HTTP 502"); }), /HTTP 502/);
});

// --- a11ign/a11ign#4202: THE PROMOTION RUNS FROM A LINKED WORKTREE THE TICK OWNS ---
//
// THE REAL SHAPE, not a stub that returns the refusal: a PRIMARY-checkout fixture (`git init`, so its `.git` is a directory, as the tool checkout's is) is the tick's working directory, and the
// REAL `row-file.ts` is spawned. `gh` on the PATH is a fake that fails every call, so a launch that gets past the guard stops at its first read and writes nothing to GitHub.
/** @param {string[]} args @param {string} cwd */
const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: sandboxGitEnv() }).trim();

/** @returns {{ root: string, primary: string, fakeBin: string }} a primary checkout with one commit, and a `gh` that always fails */
function fixture(): { root: string; primary: string; fakeBin: string; } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unpark-4202-")));
  const primary = join(root, "agent-org");
  mkdirSync(primary);
  git(["init", "-q", "-b", "main"], primary);
  writeFileSync(join(primary, "f.txt"), "x\n");
  git(["add", "f.txt"], primary);
  git(["commit", "-q", "-m", "one"], primary);
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\necho 'fake gh: refused' >&2\nexit 1\n");
  chmodSync(join(fakeBin, "gh"), 0o755);
  return { root, primary, fakeBin };
}

/**
 * The tick's promotion of row 1 with `launchDir` as the tick's working directory. Returns what the promotion said and what the process wrote to stderr (the which-worktree log line).
 * @param {{ primary: string, fakeBin: string }} fx @param {{ worktree?: () => any }} [deps]
 */
function promoteFromPrimary(fx: { primary: string; fakeBin: string; }, deps?: { worktree?: () => any; }) {
  const was = { cwd: process.cwd(), path: process.env.PATH, write: process.stderr.write };
  const logged: string[] = [];
  process.chdir(fx.primary);
  process.env.PATH = `${fx.fakeBin}:${was.path}`;
  process.stderr.write = (((chunk: string) => { logged.push(String(chunk)); return true; }) as any);
  try {
    const answer = githubIo(() => "", deps).promote(1);
    return { answer, logged: logged.join("") };
  } catch (error) {
    return { answer: { thrown: error instanceof Error ? error.message : String(error) }, logged: logged.join("") };
  } finally {
    process.stderr.write = was.write;
    process.env.PATH = was.path;
    process.chdir(was.cwd);
  }
}

test("(#4202) CONTROL: row-file launched from a checkout whose .git is a directory is refused -- the guard stays, and the refusal is what the tick met", () => {
  const fx = fixture();
  try {
    const ran = (() => { try { execFileSync(process.execPath, [...TSX_IMPORT, new URL("./row-file.ts", import.meta.url).pathname, "--promote=1", "--session=work-gate"], { cwd: fx.primary, encoding: "utf8", stdio: "pipe" }); return ""; } catch (error) { return String((error as any).stderr); } })();
    assert.match(ran, /REFUSED -- launched from .*which is not a linked worktree: its \.git is a directory/, "the primary-checkout fixture is the real refused shape");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("(#4202) the tick's promotion, launched from a primary checkout, is run from a linked worktree it owns -- and is not refused for where it ran", () => {
  const fx = fixture();
  try {
    const { answer, logged } = promoteFromPrimary(fx, { worktree: () => (unpark.tickWorktree?.({ codeDir: fx.primary }) ?? { refusal: "tickWorktree is not exported" }) });
    const said = JSON.stringify(answer);
    assert.doesNotMatch(said, /not a linked worktree/, `the promotion was refused for the place it ran: ${said}`);
    const owned = join(fx.root, "role-work-gate");
    assert.ok(logged.includes(`runs from the tick's worktree ${owned}`), `the log names the worktree that ran the script: ${logged}`);
    assert.equal(git(["rev-parse", "--git-dir"], owned).includes("worktrees"), true, "the owned tree is a LINKED worktree (its .git is a file pointing into the primary)");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("(#4202) the owned worktree is created once, reused, moved to HEAD, and a directory that is not a worktree is never touched", () => {
  const fx = fixture();
  try {
    const first = unpark.tickWorktree({ codeDir: fx.primary });
    assert.deepEqual(first, { dir: join(fx.root, "role-work-gate") });
    assert.deepEqual(unpark.tickWorktree({ codeDir: fx.primary }), first, "a second call reuses it");
    writeFileSync(join(fx.primary, "g.txt"), "y\n");
    git(["add", "g.txt"], fx.primary);
    git(["commit", "-q", "-m", "two"], fx.primary);
    unpark.tickWorktree({ codeDir: fx.primary });
    assert.equal(git(["rev-parse", "HEAD"], first.dir), git(["rev-parse", "HEAD"], fx.primary), "a detached clean tree follows the checkout's HEAD");
    rmSync(first.dir, { recursive: true });
    assert.deepEqual(unpark.tickWorktree({ codeDir: fx.primary }), first, "STALE: a registration whose directory is gone is pruned and the tree made again");
    rmSync(first.dir, { recursive: true });
    git(["worktree", "prune"], fx.primary);
    mkdirSync(first.dir);
    writeFileSync(join(first.dir, "mine.txt"), "not yours\n");
    const refused = unpark.tickWorktree({ codeDir: fx.primary });
    assert.match((refused as any).refusal, /exists and is not a worktree of/);
    assert.equal(readFileSync(join(first.dir, "mine.txt"), "utf8"), "not yours\n", "the foreign directory was left alone");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("(#4202) no tree to run from is a refusal the row is routed with, never a throw that leaves a plain backlog row", () => {
  assert.deepEqual(unpark.promoteViaModule(7, () => ({ refusal: "disk full" })), { ok: false, refusal: "the tick has no linked worktree to run `row-file --promote=7` from: disk full" });
});

test("(#4202) PIN: every script the gate starts that carries a launch guard is run with a working directory of its own -- the list, from the source", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  const spawned = (f: string) => [...read(f).matchAll(/new URL\("\.\/([a-z-]+\.mjs)", import\.meta\.url\)/g)].map((m) => m[1]);
  const children = [...new Set(["./work-gate.ts", "./unpark-satisfied.ts"].flatMap(spawned))].sort();
  const guarded = children.filter((c) => /\blaunchGate\(/.test(read(`./${c}`)));
  // The positive control: the scan finds the children (update-primary, host-units, row-file) and finds row-file guarded.
  assert.deepEqual(children, ["host-units.ts", "row-file.ts", "update-primary.ts"]);
  assert.deepEqual(guarded, ["row-file.ts"], "a new guarded child needs the owned worktree too: add it here and run it from tickWorktree()");
  assert.match(read("./unpark-satisfied.ts"), /spawnSync\(process\.execPath, \[ROW_FILE_ENTRY[^\n]*cwd: launch\.dir/, "row-file is spawned from the owned worktree");
});
