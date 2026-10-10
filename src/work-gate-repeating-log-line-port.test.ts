// no-token: gh -- the ticket port is a fake and the journal is a string handed in; nothing here spawns `gh` or `journalctl`
/**
 * agent-org#492 (Phase 1 of a11ign/a11ign#4505): `repeating-log-line` DOES NOT WAKE `orchestrator` FOR A LINE AN OPEN ROW ALREADY CITES.
 *
 * The row's four named cases are the four tests whose names start with their sentence. Everything runs through `repeatingLinesTick`, the entry the gate
 * calls, with `settleCitedRepeatingLines` as its `settle`, so "no order" is what the detector returns and not what a helper says it would.
 *
 * THE THRESHOLD IS WRITTEN OUT AS 30, 31, 60 HERE, NEVER AS `REPEAT_TICKS`, for the reason `packaging/repeating-lines.test.ts` gives: a test built from the
 * constant moves with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repeatingLinesTick } from "./repeating-lines.ts";
import { CITE_MIN_CHARS, REPEATING_LINE_SWITCH_ENV, isCountMilestone, repoNow, settleCitedRepeatingLines } from "./work-gate.ts";
import type { Decision, ItemRef, TicketItem, TicketPort } from "./ticket-port/port.ts";

const HOME = "a11ign/a11ign";
const KEYED = "a11ign/agent-org";
const LINE = (n: number) => `NOT RELEASED decline of #${n} as worker-${n} did not land (Refusing rather than ignoring it: an ignored flag runs the default and reports success.)`;
const OTHER = (n: number) => `claim-stall: #${n} carries session:orchestrator but no claim record names when or where the claim was made`;

// --- the journal the detector reads ---------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
function tickText(index: number, lines: string[]) {
  const at = `2026-10-01T${pad(Math.floor((index * 2) / 60))}:${pad((index * 2) % 60)}:00+01:00`;
  const row = (unit: string, message: string) => `${at} agents ${unit}[1]: ${message}`;
  return [row("systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."),
    ...lines.map((l) => row("node", l)),
    row("systemd", "Finished a11ign-work-tick.service - a11ign: ask work-gate whether there is work.")].join("\n");
}
/** `count` complete ticks, then the one still running (which the detector does not count), each carrying `make(i)`. */
const journalOf = (count: number, make: (i: number) => string[]) =>
  Array.from({ length: count + 1 }, (_, i) => tickText(i, make(i))).join("\n").replace(/\n[^\n]*Finished a11ign-work-tick[^\n]*$/, "");

// --- the fake port -------------------------------------------------------------------------------------------------------------------

type Row = { number: number; title?: string; body?: string; repo?: string; };
/** What the fake tracker holds, by `scope#id`; an id it does not hold reads `null`, which is "could not ask". */
type Held = Map<string, { item: Partial<TicketItem> & { title: string; body: string; }; }>;
const keyOf = (scope: string, id: number) => `${scope}#${id}`;

function fakePorts(held: Held) {
  const reads: ItemRef[] = [];
  const writes: { ref: ItemRef; decision: Decision; }[] = [];
  const scopesAsked: string[] = [];
  const portFor = (scope: string): TicketPort => {
    scopesAsked.push(scope);
    return {
      readItem(ref) {
        reads.push(ref);
        const found = held.get(keyOf(ref.scope, ref.id));
        return found === undefined ? null : ({ ref, state: "ready", flags: [], relations: { blockedBy: [], parent: null, children: [], linkedChanges: [], notBefore: null, waitingFor: [] }, events: [], ...found.item } as TicketItem);
      },
      postDecision(ref, decision) { writes.push({ ref, decision }); return "1"; },
      changeState() { throw new Error("the cite lookup must not change a row's state"); },
      subscribe() { throw new Error("the cite lookup must not subscribe"); },
    };
  };
  return { portFor, reads, writes, scopesAsked };
}

/** A row that cites LINE with different numbers, as a row filed by `orchestrator` quotes it. */
const CITING_BODY = `The gate repeats this line:\n\n    ${LINE(2500)}\n\nFix: the flag guard rejects the gate's own flag.`;
const heldRow = (id: number, item: { title?: string; body?: string; state?: TicketItem["state"]; } = {}, scope = HOME): [string, { item: any; }] =>
  [keyOf(scope, id), { item: { title: `a row about #${id}`, body: CITING_BODY, ...item } }];

/** One tick of the detector: the journal has `count` complete ticks of `lines`, the open rows are `openRows`, and the port is the fake. */
function tick({ count = 30, lines = LINE, rows, held, env = {} }: { count?: number; lines?: (n: number) => string; rows: Row[]; held: Held; env?: Record<string, string | undefined>; }) {
  const ports = fakePorts(held);
  const said: string[] = [];
  const orders = repeatingLinesTick({
    run: () => journalOf(count, (i) => [lines(2600 + i)]), allow: [], log: (l) => said.push(l),
    settle: (groups) => settleCitedRepeatingLines(groups, { openRows: rows, portFor: ports.portFor, env, log: (l) => said.push(l), now: 1_790_000_000_000 }),
  });
  return { orders, said, ...ports };
}

const CITING: Row[] = [{ number: 4001, title: "a row about #4001", body: CITING_BODY, repo: HOME }];
const NOT_CITING: Row[] = [{ number: 4002, title: "an unrelated row", body: "Nothing about any log line.", repo: HOME }];

// --- the row's Acceptance, one test per named case ------------------------------------------------------------------------------------

test("a repeating line cited by an open row produces no order and one row write", () => {
  const { orders, writes, said } = tick({ count: 30, rows: CITING, held: new Map([heldRow(4001)]) });
  assert.deepEqual(orders, [], "the cited line wakes nobody");
  assert.equal(writes.length, 1, "and the count is written to the row once");
  assert.deepEqual(writes[0].ref, { tracker: "github", scope: HOME, id: 4001 });
  assert.equal(writes[0].decision.role, "work-gate");
  assert.equal(writes[0].decision.kind, "repeating-line-count");
  assert.match(writes[0].decision.text, /repeated at least 30 consecutive ticks/);
  assert.match(writes[0].decision.text, /NOT RELEASED decline of #2629 as worker-2629/, "the line is quoted as the newest tick wrote it");
  assert.ok(said.some((l) => /^repeating-lines: 30 ticks, cited by open row a11ign\/a11ign#4001 -- no order, count written to the row/.test(l)), said.join(""));
});

test("a line no open row cites produces the order as today", () => {
  const { orders, writes, reads } = tick({ count: 30, rows: NOT_CITING, held: new Map([heldRow(4002, { body: "Nothing about any log line." })]) });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "orchestrator");
  assert.equal(orders[0].cause, "repeating-log-line");
  assert.match(orders[0].prompt, /NOT RELEASED decline of #2629/);
  assert.deepEqual([reads.length, writes.length], [0, 0], "no row is a candidate, so no read is paid and nothing is written");
  // the same order the detector made before this row, to the byte: the unsettled tick is the control.
  const before = repeatingLinesTick({ run: () => journalOf(30, (i) => [LINE(2600 + i)]), allow: [], log: () => {} });
  assert.deepEqual(orders, before);
});

test("the lookup goes through a fake port, not a direct gh spawn", () => {
  const { orders, reads, writes, scopesAsked } = tick({ count: 30, rows: [...CITING, { ...CITING[0], number: 4003, repo: KEYED }], held: new Map([heldRow(4001)]) });
  assert.deepEqual(orders, []);
  assert.deepEqual(reads, [{ tracker: "github", scope: HOME, id: 4001 }], "the lowest-numbered candidate was read through the port, and it held, so the other was not asked");
  assert.equal(writes.length, 1);
  assert.deepEqual(scopesAsked, [HOME], "a port per scope, asked for by the row's own repository");
  // a row of a scope the gate holds no repository for is asked of THAT scope's port, never of the home one.
  const keyed = tick({ count: 30, rows: [{ ...CITING[0], number: 4003, repo: KEYED }], held: new Map([heldRow(4003, {}, KEYED)]) });
  assert.deepEqual(keyed.orders, []);
  assert.deepEqual(keyed.reads, [{ tracker: "github", scope: KEYED, id: 4003 }]);
  // a row that names no repository is the checkout's own.
  const bare = tick({ count: 30, rows: [{ number: 4004, title: "t", body: CITING_BODY }], held: new Map([heldRow(4004, {}, repoNow())]) });
  assert.deepEqual(bare.orders, []);
  assert.equal(bare.reads[0].scope, repoNow());
});

test("the function that looks up a cite spawns nothing, and the scan that says so sees a spawn when there is one (its positive control)", () => {
  const source = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export function settleCitedRepeatingLines");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const spawns = (text: string) => /execFileSync|execSync|spawnSync|spawn\(|defaultRun|runBatch|\bgh\b/.test(text);
  assert.ok(start > 0 && body.length > 500, "the scan found the function it is about");
  assert.equal(spawns(body), false, "the lookup reaches a tracker only through the `portFor` it is handed");
  // the spawn's name is assembled so that THIS file does not itself hold the `// no-token:` shape it declares absent.
  const spawner = ["exec", "File", "Sync"].join("");
  assert.equal(spawns(`${body}\n  ${spawner}("gh", ["issue", "view"]);`), true, "the scan notices a direct spawn");
});

test("negative control: with the switch off, the cited line produces today's order", () => {
  const off = tick({ count: 30, rows: CITING, held: new Map([heldRow(4001)]), env: { [REPEATING_LINE_SWITCH_ENV]: "off" } });
  assert.equal(off.orders.length, 1, "the same line, the same row, and now the seat is woken");
  assert.equal(off.orders[0].cause, "repeating-log-line");
  assert.deepEqual([off.reads.length, off.writes.length, off.scopesAsked.length], [0, 0, 0], "off is off: no read, no write, no port");
  const on = tick({ count: 30, rows: CITING, held: new Map([heldRow(4001)]), env: {} });
  assert.deepEqual(on.orders, [], "and the switch is the only difference");
  const unrelated = tick({ count: 30, rows: CITING, held: new Map([heldRow(4001)]), env: { [REPEATING_LINE_SWITCH_ENV]: "on" } });
  assert.deepEqual(unrelated.orders, [], "only `off` turns it off");
});

// --- what makes the suppression safe: every doubt is a wake ---------------------------------------------------------------------------

test("a candidate the port cannot read, or reads closed, or reads without the line, does not suppress", () => {
  const unreadable = tick({ rows: CITING, held: new Map() });
  assert.equal(unreadable.orders.length, 1, "`readItem` null is COULD NOT ASK, and a seat is woken as today");
  const closed = tick({ rows: CITING, held: new Map([heldRow(4001, { state: "done" })]) });
  assert.equal(closed.orders.length, 1, "a closed row holds nobody's attention");
  const edited = tick({ rows: CITING, held: new Map([heldRow(4001, { body: "The line was removed from this row." })]) });
  assert.equal(edited.orders.length, 1, "the row in hand said it cited, the port's answer is the fresher one and it does not");
  for (const t of [unreadable, closed, edited]) assert.equal(t.writes.length, 0, "nothing is written to a row that did not hold the line");
});

test("a line whose normalised prefix is too short to be a citation is never matched", () => {
  const short = "ok: N";
  assert.ok(short.length < CITE_MIN_CHARS);
  const { orders, reads } = tick({ lines: () => short, rows: [{ number: 4001, title: "t", body: `${short} appears in every row ${short}`, repo: HOME }], held: new Map([heldRow(4001, { body: short })]) });
  assert.equal(orders.length, 1);
  assert.equal(reads.length, 0);
});

test("the count is written at 30, 60 and 120 and at no tick between them", () => {
  assert.deepEqual([29, 30, 31, 45, 59, 60, 61, 90, 120, 240, 480, 360].map(isCountMilestone), [false, true, false, false, false, true, false, false, true, true, true, false]);
  const wrote = (count: number) => tick({ count, rows: CITING, held: new Map([heldRow(4001)]) });
  assert.deepEqual([wrote(30), wrote(31), wrote(59), wrote(60)].map((t) => [t.orders.length, t.writes.length]), [[0, 1], [0, 0], [0, 0], [0, 1]],
    "suppressed at every count, written at the milestones only");
  assert.match(wrote(60).writes[0].decision.text, /repeated at least 60 consecutive ticks/);
});

test("a write that fails is said and the cite still holds; a lookup that throws offers every line", () => {
  const held: Held = new Map([heldRow(4001)]);
  const ports = fakePorts(held);
  const failing = (scope: string): TicketPort => ({ ...ports.portFor(scope), postDecision() { throw new Error("HTTP 502\nbad gateway"); } });
  const said: string[] = [];
  const orders = repeatingLinesTick({ run: () => journalOf(30, (i) => [LINE(2600 + i)]), allow: [], log: (l) => said.push(l),
    settle: (groups) => settleCitedRepeatingLines(groups, { openRows: CITING, portFor: failing, env: {}, log: (l) => said.push(l) }) });
  assert.deepEqual(orders, []);
  assert.ok(said.some((l) => /cited by open row a11ign\/a11ign#4001 -- no order, COULD NOT WRITE THE COUNT \(HTTP 502\)/.test(l)), said.join(""));
  // the detector fails OPEN when the lookup itself throws, so a defect here is a wake and never a silence.
  const thrown: string[] = [];
  const offered = repeatingLinesTick({ run: () => journalOf(30, (i) => [LINE(2600 + i)]), allow: [], log: (l) => thrown.push(l),
    settle: () => { throw new Error("port exploded"); } });
  assert.equal(offered.length, 1);
  assert.ok(thrown.some((l) => /^repeating-lines: could not look for rows citing these lines \(port exploded\) -- every line is offered\./.test(l)), thrown.join(""));
});

test("two lines, one cited: the cited one is settled and the other is still offered, without it in its `ALSO REPEATING`", () => {
  const { orders, writes } = tick({ rows: CITING, held: new Map([heldRow(4001)]), lines: LINE, count: 30 });
  assert.deepEqual([orders.length, writes.length], [0, 1]);
  const ports = fakePorts(new Map([heldRow(4001)]));
  const both = repeatingLinesTick({ run: () => journalOf(30, (i) => [LINE(2600 + i), OTHER(2600 + i)]), allow: [], log: () => {},
    settle: (groups) => settleCitedRepeatingLines(groups, { openRows: CITING, portFor: ports.portFor, env: {}, log: () => {} }) });
  // both lines began on the same tick, so they are ONE group whose headline is the first: it is cited, so the group is settled whole.
  assert.deepEqual(both, []);
  const second = repeatingLinesTick({ run: () => journalOf(31, (i) => [i >= 1 ? LINE(2600 + i) : "", OTHER(2600 + i)].filter(Boolean)), allow: [], log: () => {},
    settle: (groups) => settleCitedRepeatingLines(groups, { openRows: CITING, portFor: ports.portFor, env: {}, log: () => {} }) });
  assert.equal(second.length, 1, "the group the cited line is not in is still offered");
  assert.match(second[0].prompt, /claim-stall: #2630 carries session:orchestrator/);
  assert.doesNotMatch(second[0].prompt, /ALSO REPEATING/, "the settled line is not listed as still repeating");
});
