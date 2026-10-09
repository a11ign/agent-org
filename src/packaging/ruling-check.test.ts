// no-token: gh -- importing `work-gate.ts` reaches `defaultRun`, and this file never lets it run: `rulingOrdersNow` is handed a fake `run`.
/**
 * `src/ruling-check.ts`, `src/ruling-record.ts` and their wiring in `work-gate.ts`, #2997: A RULING CARRIES ITS OWN CHECK THAT IT TOOK EFFECT, AND THE TICK
 * RE-READS IT UNTIL IT DOES.
 *
 * THE INCIDENT, REPLAYED (the chairman, 2026-10-02): `ceo` ruled the freeze over at 06:50Z, and at 10:40Z three rows still carried a `Not-before: 2026-10-03T18:2x`
 * line, six more named it in prose, and two pull requests were still `hold:ceo`. The fixture below is that state; it is the positive control every "passes" here
 * is worth anything against.
 *
 * MUTATION, run by hand and recorded on the row: `evaluateCheck` returning `pass` for a non-empty population turns the 06:50Z test red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitItemOf } from "../wait-condition.ts";
import { parseCheck, evaluateCheck, evaluateChecks, settleRulings, DEFAULT_GRACE_MINUTES } from "../ruling-check.ts";
import { recordRuling, readRulings, rulingTick, main as recordMain, RULINGS_FILE } from "../ruling-record.ts";
import { rulingOrdersNow } from "../work-gate.ts";

const RECORD_CLI = fileURLToPath(new URL("../ruling-record.ts", import.meta.url));
const ROW_CHECK = 'no-open-row-body-matches "Not-before: 2026-10-03T18:2"';
const PR_CHECK = "no-open-pr-label hold:ceo";
const RULED_AT = "2026-10-02T10:40:00Z";
const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);

const row = (number: number, body: string, labels: string[] = []) => ({ number, body, labels: labels.map((name) => ({ name })) });
/** The 10:40Z state: three rows with the line, six with it in prose, two held PRs, and two bystanders that must NOT be named. */
function staleState() {
  const rows = [
    ...[3001, 3002, 3003].map((n) => row(n, `Not-before: 2026-10-03T18:21:00Z\n\nbody`)),
    ...[3011, 3012, 3013, 3014, 3015, 3016].map((n) => row(n, "The freeze (`Not-before: 2026-10-03T18:2x`) ended at 06:50Z.")),
    row(3090, "an ordinary row"), row(3091, "another"),
  ];
  const prs = [row(40, "", ["hold:ceo"]), row(41, "", ["hold:ceo", "lane:any"]), row(42, "", [])];
  return { rows, prs };
}
const worldOf = ({ rows, prs }: { rows: any[] | null; prs: any[] | null }) => ({
  rows: rows && rows.map((r) => waitItemOf(r, "row")), prs: prs && prs.map((p) => waitItemOf(p, "pr")), facts: { items: {} },
});
const swept = () => ({ rows: staleState().rows.map((r) => ({ ...r, body: "swept" })), prs: staleState().prs.map((p) => ({ ...p, labels: [] })) });

function scratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ruling-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const record = (dir: string, overrides: Record<string, unknown> = {}) =>
  recordRuling({ stateDir: dir, by: "ceo", on: 2988, checks: [ROW_CHECK, PR_CHECK], at: RULED_AT, ...overrides } as any);

test("#2997 POSITIVE CONTROL, the 06:50Z ruling: both checks FAIL over the 10:40Z state and the failing population is NAMED, all of it", () => {
  const reading = evaluateChecks([ROW_CHECK, PR_CHECK], worldOf(staleState()));
  assert.equal(reading.verdict, "fail");
  assert.deepEqual(reading.failing, [3001, 3002, 3003, 3011, 3012, 3013, 3014, 3015, 3016].map((n) => `row #${n}`).concat(["PR #40", "PR #41"]));
});

test("#2997: swept, the same ruling PASSES and the tick marks it took-effect, once", () => scratch((dir) => {
  const { id } = record(dir) as { id: string };
  const comments: string[] = [];
  const failing = rulingTick({ stateDir: dir, world: worldOf(swept()), now: at("2026-10-02T10:45:00Z"), comment: (_i, line) => comments.push(line) });
  assert.deepEqual(failing, []);
  assert.deepEqual(readRulings(dir).rulings.map((r) => [r.id, r.resolved]), [[id, true]]);
  assert.equal(readFileSync(join(dir, RULINGS_FILE), "utf8").split("\n").filter((l) => l.includes("took-effect")).length, 1);
  rulingTick({ stateDir: dir, world: worldOf(swept()), now: at("2026-10-02T10:50:00Z"), comment: () => assert.fail("a resolved ruling is not read") });
  assert.equal(readFileSync(join(dir, RULINGS_FILE), "utf8").split("\n").filter((l) => l.includes("took-effect")).length, 1);
}));

test("#2997 AN EMPTINESS THAT CAN BE NON-EMPTY: the same predicates over an empty population pass, and the failing fixture is NOT empty (the control)", () => {
  assert.equal(evaluateChecks([ROW_CHECK, PR_CHECK], worldOf({ rows: [], prs: [] })).verdict, "pass");
  const control = staleState();
  assert.ok(control.rows.length > 0 && control.prs.length > 0, "the failing fixture must be a population, or the pass above proves nothing");
  assert.equal(evaluateChecks([ROW_CHECK, PR_CHECK], worldOf(control)).verdict, "fail");
});

test("#2997 GRACE: a failing check inside its grace offers nothing and posts nothing; past it, one order per tick-HOUR and one comment ever", () => scratch((dir) => {
  const { id } = record(dir) as { id: string };
  const comments: [number, string][] = [];
  const tick = (iso: string) => rulingTick({ stateDir: dir, world: worldOf(staleState()), now: at(iso), comment: (i, l) => comments.push([i, l]) });
  assert.equal(DEFAULT_GRACE_MINUTES, 20);
  assert.deepEqual(tick("2026-10-02T10:59:00Z"), [], "19 minutes in: inside the grace");
  assert.deepEqual(comments, []);
  const first = tick("2026-10-02T11:01:00Z");
  assert.equal(first.length, 1);
  assert.equal(first[0].session, "ceo");
  assert.match(first[0].prompt, /row #3001/);
  assert.match(first[0].prompt, /PR #41/);
  assert.equal(comments.length, 1);
  assert.equal(comments[0][0], 2988);
  const sameHour = tick("2026-10-02T11:02:00Z");
  assert.equal(sameHour[0].causeKey, first[0].causeKey, "the next tick of the SAME hour is the same offer, which the ledger dedupes");
  assert.equal(comments.length, 1, "one line on the issue, not one per tick");
  const nextHour = tick("2026-10-02T12:05:00Z");
  assert.notEqual(nextHour[0].causeKey, first[0].causeKey, "an hour later is a new offer");
  assert.equal(first[0].causeKey, `ceo/org-health/ruling-not-taken@${id}@2026-10-02T11`);
}));

test("#2997: a comment that cannot be posted is retried next tick, and the order still goes out", () => scratch((dir) => {
  record(dir);
  const lines: string[] = [];
  let calls = 0;
  const tick = (iso: string) => rulingTick({ stateDir: dir, world: worldOf(staleState()), now: at(iso), log: (l) => lines.push(l),
    comment: () => { if (++calls === 1) throw new Error("HTTP 502"); } });
  assert.equal(tick("2026-10-02T11:01:00Z").length, 1);
  assert.match(lines.join("\n"), /could not post on #2988/);
  assert.equal(tick("2026-10-02T11:02:00Z").length, 1);
  assert.equal(calls, 2, "the second tick posted again, because the first was never marked");
  tick("2026-10-02T11:03:00Z");
  assert.equal(calls, 2, "and a posted line is posted once");
}));

test("#2997 REFUSED: a ruling with no check, a predicate outside the vocabulary, an uncompilable regex, no recorder", () => scratch((dir) => {
  const none = record(dir, { checks: [] });
  assert.equal(none.ok, false);
  assert.match((none as any).why, /a ruling is a claim about state; name the state/);
  const outside = record(dir, { checks: ["the freeze is over"] });
  assert.equal(outside.ok, false);
  assert.match((outside as any).why, /not in the vocabulary: closed #n, merged #n/);
  assert.match((record(dir, { checks: ["no-open-row-body-matches (unclosed"] }) as any).why, /does not compile/);
  assert.match((record(dir, { by: undefined }) as any).why, /--session=<name> is required/);
  assert.match((record(dir, { checks: ["manual"] }) as any).why, /not in the vocabulary/);
  assert.equal(existsSync(join(dir, RULINGS_FILE)), false, "a refusal writes nothing");
}));

test("#2997 RESOLVED STAYS RESOLVED: a ruling that passed and later fails is not reopened", () => scratch((dir) => {
  record(dir);
  rulingTick({ stateDir: dir, world: worldOf(swept()), now: at("2026-10-02T10:45:00Z"), comment: () => {} });
  const later = rulingTick({ stateDir: dir, world: worldOf(staleState()), now: at("2026-10-02T15:00:00Z"), comment: () => assert.fail("reopened") });
  assert.deepEqual(later, []);
}));

test("#2997 UNKNOWN IS NEVER A PASS: a refused list neither resolves a ruling nor offers one", () => scratch((dir) => {
  record(dir);
  assert.equal(evaluateChecks([ROW_CHECK], worldOf({ rows: null, prs: [] })).verdict, "unknown");
  const out = rulingTick({ stateDir: dir, world: worldOf({ rows: null, prs: null }), now: at("2026-10-02T13:00:00Z"), comment: () => assert.fail("posted") });
  assert.deepEqual(out, []);
  assert.deepEqual(readRulings(dir).rulings.map((r) => r.resolved), [false]);
  assert.equal(evaluateChecks([ROW_CHECK, PR_CHECK], worldOf({ rows: [], prs: staleState().prs })).verdict, "fail", "one failing check fails the ruling past an unknown one");
}));

test("#2997: the single-reference kinds are #2996's own, and a reference the tick could not read is unknown", () => {
  const closed = parseCheck("closed #2867");
  assert.ok(closed.ok);
  const read = (state: string | null) => evaluateCheck((closed as any).check, { rows: [], prs: [], facts: { items: state ? { "#2867": { state, labels: [], resolvedAt: null, changedAt: null } } : {} } } as any);
  assert.deepEqual([read("closed").verdict, read("open").verdict, read(null).verdict], ["pass", "fail", "unknown"]);
  assert.equal(parseCheck("unlabelled hold:ceo #40").ok, true);
});

test("#2997: a row-body regex is MULTILINE, so `^Not-before:` finds the field and not the row that merely quotes it", () => {
  const parsed = parseCheck("no-open-row-body-matches ^Not-before: 2026-10-03T18:2");
  assert.ok(parsed.ok);
  const rows = [row(1, "intro\nNot-before: 2026-10-03T18:21:00Z\nmore"), row(2, "the check `no-open-row-body-matches Not-before: 2026-10-03T18:2` quotes it"), row(3, "no line at all")];
  assert.deepEqual(evaluateCheck((parsed as any).check, worldOf({ rows, prs: [] })).failing, ["row #1"]);
});

test("#2997: `no-open-row-label <label> except #n ...` names every holder but the excepted", () => {
  const parsed = parseCheck("no-open-row-label hold:ceo except #3001 #3002");
  assert.ok(parsed.ok);
  const rows = [3001, 3002, 3003].map((n) => row(n, "", ["hold:ceo"]));
  assert.deepEqual(evaluateCheck((parsed as any).check, worldOf({ rows, prs: [] })).failing, ["row #3003"]);
  assert.equal(parseCheck("no-open-row-label hold:ceo except").ok, false);
});

test("#2997: recording is idempotent, and a record that cannot be read is said so and reads NOTHING (never 'no rulings')", () => scratch((dir) => {
  assert.equal((record(dir) as any).fresh, true);
  assert.equal((record(dir) as any).fresh, false);
  assert.equal(readFileSync(join(dir, RULINGS_FILE), "utf8").split("\n").filter(Boolean).length, 1);
  appendFileSync(join(dir, RULINGS_FILE), "{not json\n");
  const lines: string[] = [];
  assert.deepEqual(rulingTick({ stateDir: dir, world: worldOf(staleState()), now: at("2026-10-02T15:00:00Z"), comment: () => {}, log: (l) => lines.push(l) }), []);
  assert.match(lines.join("\n"), /could not be read, so no ruling was checked/);
  assert.equal(readRulings(dir).status, "unreadable");
}));

test("#2997 THE GATE: no unresolved ruling is NO read; a pending one reads its references and posts through `gh issue comment`", () => scratch((dir) => {
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return args[0] === "api" ? JSON.stringify({ state: "open", closed_at: null, updated_at: null, merged_at: null, labels: [] }) : ""; };
  assert.deepEqual(rulingOrdersNow({ prsRead: [], openRowsRead: [], now: at("2026-10-02T12:00:00Z") }, { stateDir: dir, run }), []);
  assert.deepEqual<string[][]>(calls, [], "an empty record costs the tick nothing"); // typed, or the assertion narrows `calls` to `never[]` for the pushes that follow
  recordRuling({ stateDir: dir, by: "ceo", on: 2988, checks: ["closed #2867"], at: RULED_AT });
  const orders = rulingOrdersNow({ prsRead: [], openRowsRead: [], now: at("2026-10-02T12:00:00Z") }, { stateDir: dir, run });
  assert.equal(orders.length, 1);
  assert.equal(calls[0][0], "api");
  assert.match(calls[0][1], /^repos\/.+\/issues\/2867$/);
  assert.deepEqual(calls[1].slice(0, 2), ["issue", "comment"]);
  assert.equal(calls[1][2], "2988");
}));

test("#2997 THE GATE: a rulings.jsonl it cannot read is SAID (through `rulingOrdersNow`), reads no reference and posts nothing -- never 'no rulings'", () => scratch((dir) => {
  recordRuling({ stateDir: dir, by: "ceo", on: 2988, checks: ["closed #2867"], at: RULED_AT });
  appendFileSync(join(dir, RULINGS_FILE), "{not json\n");
  const calls: string[][] = [];
  const lines: string[] = [];
  const run = (args: string[]) => { calls.push(args); return ""; };
  assert.deepEqual(rulingOrdersNow({ prsRead: [], openRowsRead: [], now: at("2026-10-02T12:00:00Z") }, { stateDir: dir, run, log: (l) => lines.push(l) }), []);
  assert.match(lines.join("\n"), /could not be read, so no ruling was checked/);
  assert.deepEqual(calls, []);
}));

test("#2997 THE CLI: `--on 2988 --check ...` records; no check is refused with exit 1 and nothing written", () => scratch((home) => {
  const env = { PATH: process.env.PATH ?? "", HOME: home, ...(process.env.AGENT_ORG_HOST && { AGENT_ORG_HOST: process.env.AGENT_ORG_HOST }) };
  const state = join(home, ".cache", "a11ign");
  const refused = spawnSync(process.execPath, [RECORD_CLI, "--session=ceo", "--on", "2988"], { encoding: "utf8", env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /name the state/);
  assert.equal(existsSync(join(state, RULINGS_FILE)), false);
  const out = execFileSync(process.execPath, [RECORD_CLI, "--session=ceo", "--on", "2988", "--check", PR_CHECK, "--check=closed #2867", "--at=2026-10-02T06:50:00Z"], { encoding: "utf8", env });
  assert.match(out, /^RECORDED r2988-/);
  const [only] = readRulings(state).rulings;
  assert.deepEqual([only.on, only.by, only.checks, only.grace], [2988, "ceo", [PR_CHECK, "closed #2867"], 20]);
  assert.equal(recordMain(["--session=ceo", "--on=2988", "--check", PR_CHECK, "--check=closed #2867", "--at=2026-10-02T06:50:00Z"], { stateDir: state }), 0);
  assert.equal(readFileSync(join(state, RULINGS_FILE), "utf8").split("\n").filter(Boolean).length, 1, "the same ruling twice is one line");
}));

test("#2997: settleRulings reads only the unresolved, and says what to do with each", () => {
  const base = { on: 1, by: "ceo", at: at(RULED_AT), checks: [PR_CHECK], grace: 20, offeredAt: null };
  const out = settleRulings([{ ...base, id: "a", resolved: true }, { ...base, id: "b", resolved: false }], worldOf(staleState()), at("2026-10-02T12:00:00Z"));
  assert.deepEqual(out.map((o) => [o.ruling.id, o.action]), [["b", "offer"]]);
});
