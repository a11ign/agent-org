// no-token: gh -- no `gh` is run: the tracker's history, the incident items and the label writes are the fake code host's world (A11-160, step 6), the rows are fixtures and the only files written are in a temporary directory
/**
 * #5032 (chairman, 2026-10-11): ONLY THE CHAIRMAN SETS PRIORITY, EXCEPT IN AN EMERGENCY WHERE THE ORG IS BLOCKED -- `priority:emergency`, honoured while an org-blocking incident is open.
 *
 * THE DETECTOR runs the REAL tick path (`offerHierarchyNow` over a temporary state directory, then `decide`) and reads the ledger back through `parseFailureLedger`, the reader the
 * retro and `class-repeat` use. Every "ignored" or "not removed" test has a sibling that differs in the ONE thing that makes the gate act, so none can pass by the gate doing nothing:
 * `honoured` is the positive control for the ordering, `removes the label` for the expiry, and the option-off test counts reads against an option-on run of the same world.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { decide } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { offerHierarchyNow } from "../work-gate/tick.ts";
import { parseEmergencyPriorityOption, readEmergencyPriorityOption, EMERGENCY_PRIORITY_LABEL as EMERGENCY_LABEL, EMERGENCY_PRIORITY_OFF, type EmergencyPriorityOption } from "../work-gate/causes/rows-offer.ts";
import { CHAIRMAN_PRIORITY_LABEL as CHAIRMAN_LABEL } from "../work-gate/vocabulary.ts";
import {
  EMERGENCY_PRIORITY_NOT_HONOURED_KIND, EMERGENCY_PRIORITY_USED_KIND, recordEmergencyPriority,
} from "../failure-recorders.ts";
import { CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, FAILURE_LEDGER_FILE, parseFailureLedger } from "../failure-ledger.ts";
import { REPO } from "../project-identity.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

const CHAIRMAN = "DanBeckDev";
const CEO = "a11ign-managers[bot]";
const AGENT = "a11ign-workers[bot]";
const T0 = Date.parse("2026-10-11T14:00:00Z");
const DECLARATION = { code: [{ key: "", repo: REPO }], dora: [{ repo: REPO, releasablePaths: ["src/"] }] };
const ON: EmergencyPriorityOption = { ...EMERGENCY_PRIORITY_OFF, enabled: true };

type Row = { number: number; title: string; labels: { name: string }[]; body: string };
const BODY = (n: number) => `## Region\n\n\`\`\`\nsrc/row-${n}.ts\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`;
const row = (number: number, labels: string[], extra = ""): Row => ({ number, title: `row ${number}`, labels: ["ready", ...labels].map((name) => ({ name })), body: BODY(number) + extra });
const LINK = (ref: string, reason = "every claim is refused") => `\nIncident: ${ref}\nEmergency-reason: ${reason}\n`;

/**
 * The tracker as the gate asks it: who added each label of each row, each incident item, and what was written. `unreadable` makes every read throw. `reads` and `writes` are the code host's operations the gate called
 * (A11-160, step 6: the gate asks the code host by name, and the fake code host answers from this world); what the plugin sends to GitHub for them is asserted in `plugins/github/rows/gate-reads.test.ts`.
 */
type World = {
  actors: Record<string, Record<number, string>>; // label -> row -> the `labeled` actors, oldest first, one per line
  items: Record<string, { state: "open" | "closed"; labels: string[]; body: string }>; // `#889` or `owner/repo#889`
  unreadable?: boolean;
  reads: unknown[][];
  writes: unknown[][];
};
const world = (actors: World["actors"], items: World["items"] = {}): World => ({ actors, items, reads: [], writes: [] });
const OPEN_BLOCKING = { state: "open" as const, labels: ["incident"], body: "Incident: incident:claim-refusal-storm\n" };

const noGh = (): string => {
  throw new Error("the fake code host acts on its own state: no gh is run");
};

/** The fake code host that holds `w` as it stands now, substituted for the tick: the label history, the incident items, and a record of the reads and writes the gate makes of it. */
function holdWorld(w: World): void {
  const host = createFakeCodeHost();
  const fake = host.rowsWorld;
  let minute = 0;
  for (const [label, byRow] of Object.entries(w.actors)) {
    for (const [row, lines] of Object.entries(byRow)) {
      const events = fake.gate.events.get(Number(row));
      const kept = events instanceof Error || events === undefined ? [] : events;
      for (const actor of lines.split("\n").filter((line) => line !== "")) {
        minute += 1;
        kept.push({ event: "labeled", label, actor: actor === "null" ? null : actor, at: new Date(T0 - 60 * 60_000 + minute * 60_000).toISOString() });
      }
      fake.gate.events.set(Number(row), kept);
    }
  }
  for (const [ref, item] of Object.entries(w.items)) {
    const [repo, number] = ref.split("#");
    const incident = fakeRow(fake, Number(number), { state: item.state === "open" ? "OPEN" : "CLOSED", labels: item.labels, body: item.body });
    if (repo === "") fake.rows.set(Number(number), incident);
    else fake.foreignRows.set(`${repo}#${number}`, incident);
  }
  const rows = host.rows!;
  for (const name of ["newestLabellerOf", "incidentItemOf", "rowBodyOf"] as const) {
    const read = rows[name] as (request: never) => unknown;
    rows[name] = ((request: never) => { w.reads.push([name, request]); if (w.unreadable) throw new Error("rate limited"); return read(request); }) as never;
  }
  const remove = rows.removeLabelFromRow;
  rows.removeLabelFromRow = (request) => { w.writes.push(["removeLabelFromRow", request.number, request.label]); remove(request); };
  substituteCodeHost(host);
}

afterEach(() => forgetActivation());

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "work-gate-emergency-priority-"));
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write; // the gate says IGNORED on stderr every tick, and that is not what is under test
  try { return body(dir); } finally { process.stderr.write = write; rmSync(dir, { recursive: true, force: true }); }
}

function tick(rows: Row[], { dir, w, emergency = ON, minutes = 0 }: { dir: string; w: World; emergency?: EmergencyPriorityOption; minutes?: number }) {
  holdWorld(w);
  const hierarchy = offerHierarchyNow(rows, rows, { run: noGh, stateDir: dir, now: T0 + minutes * 60_000, emergency });
  const orders = decide({ prs: [], readyRows: rows, engineerStarts: [], projectDeclaration: DECLARATION, shareLog: () => {}, offerHierarchy: hierarchy } as Parameters<typeof decide>[0]);
  return {
    hierarchy,
    offered: orders.filter((order) => order.cause === "ready-row-unclaimed"),
    told: orders.filter((order) => order.causeKey.startsWith("ceo/emergency-priority-ignored/")),
    chairmanTold: orders.filter((order) => order.causeKey.startsWith("ceo/chairman-label-ignored/")),
  };
}
const entriesIn = (dir: string) => existsSync(join(dir, FAILURE_LEDGER_FILE)) ? parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8")) : [];
const numbersOf = (orders: { subject: string }[]) => orders.map((order) => order.subject);

test("ceo's priority:emergency on a row linked to an open org-blocking incident is ordered FIRST, ahead of the chairman's row and of a lower-numbered plain one", () => withDir((dir) => {
  const rows = [row(100, []), row(200, [CHAIRMAN_LABEL]), row(300, [EMERGENCY_LABEL], LINK("a11ign/agent-org#889"))];
  const w = world({ [CHAIRMAN_LABEL]: { 200: `${CHAIRMAN}\n` }, [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "a11ign/agent-org#889": OPEN_BLOCKING });
  const { offered, hierarchy } = tick(rows, { dir, w });
  assert.deepEqual([...hierarchy.emergencyRows ?? []], [300]);
  assert.deepEqual(numbersOf(offered), ["row-300", "row-200", "row-100"], "emergency, then chairman, then plain: it outranks priority:chairman while it holds");
  assert.match(offered[0].prompt, /EMERGENCY PRIORITY/);
  assert.equal((offered[0] as { startFresh?: boolean }).startFresh, true, "a fresh instance, as for the chairman's row");
  assert.doesNotMatch(offered[1].prompt, /EMERGENCY PRIORITY/, "control: the chairman's own row keeps its own banner");
  assert.match(offered[1].prompt, /CHAIRMAN PRIORITY/);
  assert.deepEqual(w.writes, [], "an honoured label is not touched");
}));

test("an honoured use is ONE `emergency-priority-used` line across ticks, with the reason's row and the incident in its ref, and `fresh` only the first time", () => withDir((dir) => {
  const rows = [row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": OPEN_BLOCKING });
  const first = tick(rows, { dir, w, minutes: 0 });
  tick(rows, { dir, w, minutes: 5 });
  assert.deepEqual(entriesIn(dir), [{ classKey: EMERGENCY_PRIORITY_USED_KIND, at: T0, ref: `${REPO}#300:${REPO}#889` }]);
  assert.equal(first.hierarchy.emergencyRows?.has(300), true);
  const again = recordEmergencyPriority({ ignored: [], honoured: [{ number: 300, incident: `${REPO}#889` }], repo: REPO, stateDir: dir, now: T0 });
  assert.deepEqual(again.honoured.map((entry) => [entry.fresh, entry.recorded]), [[false, true]], "already in the ledger: not fresh, so nobody is told twice");
  const other = recordEmergencyPriority({ ignored: [], honoured: [{ number: 301, incident: `${REPO}#889` }], repo: REPO, stateDir: dir, now: T0 });
  assert.deepEqual(other.honoured.map((entry) => entry.fresh), [true], "control: a different row is a new use");
}));

test("the same label with NO open org-blocking incident is ignored, recorded once, and told to ceo -- for each way of having none", () => {
  const cases: [string, Row, World["items"], string][] = [
    ["its body names no incident", row(300, [EMERGENCY_LABEL]), {}, "no-incident-link"],
    ["the incident it names is open but is not an org-blocking kind", row(300, [EMERGENCY_LABEL], LINK("#889")),
      { "#889": { state: "open", labels: ["incident"], body: "Incident: incident:fleet-down\n" } }, "no-open-org-blocking-incident"],
    ["the item it names is open but is not labelled `incident`", row(300, [EMERGENCY_LABEL], LINK("#889")),
      { "#889": { state: "open", labels: [], body: "Incident: incident:claim-refusal-storm\n" } }, "no-open-org-blocking-incident"],
  ];
  for (const [what, labelled, items, why] of cases) {
    withDir((dir) => {
      const w = world({ [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, items);
      const first = tick([row(100, []), labelled], { dir, w, minutes: 0 });
      tick([row(100, []), labelled], { dir, w, minutes: 5 });
      assert.deepEqual([...first.hierarchy.emergencyRows ?? []], [], what);
      assert.deepEqual(numbersOf(first.offered), ["row-100", "row-300"], `${what}: ordered as its other labels say`);
      assert.deepEqual(entriesIn(dir).map((entry) => [entry.classKey, entry.ref]), [[EMERGENCY_PRIORITY_NOT_HONOURED_KIND, `${REPO}#300:${CEO}:${why}`]], `${what}: one line over two ticks`);
      assert.deepEqual(first.told.map((order) => [order.session, order.causeKey]), [["ceo", `ceo/emergency-priority-ignored/300-${CEO}-${why}`]], what);
      assert.match(first.told[0].prompt, /ALREADY RECORDED/);
      assert.deepEqual(w.writes, [], `${what}: an open incident that does not qualify is misuse, not an expiry: the label is left for ceo`);
    });
  }
});

test("a label put on by anybody but the managers App or the leads login is ignored and recorded, and the row is NOT honoured even with an open incident", () => withDir((dir) => {
  const rows = [row(100, []), row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [EMERGENCY_LABEL]: { 300: `${AGENT}\n` } }, { "#889": OPEN_BLOCKING });
  const { offered, told, hierarchy } = tick(rows, { dir, w });
  assert.deepEqual([...hierarchy.emergencyRows ?? []], []);
  assert.deepEqual(numbersOf(offered), ["row-100", "row-300"]);
  assert.deepEqual(entriesIn(dir).map((entry) => entry.ref), [`${REPO}#300:${AGENT}:actor`]);
  assert.match(told[0].prompt, new RegExp(`${AGENT.replace(/[[\]]/g, "\\$&")} added it`));
  assert.equal(w.reads.some(([name]) => name === "incidentItemOf"), false, "the actor is refused BEFORE the incident is read: a forger learns nothing and costs nothing");
}));

test("a label whose history names no actor is ignored under `unknown`", () => withDir((dir) => {
  const w = world({ [EMERGENCY_LABEL]: { 300: "null\n" } }, { "#889": OPEN_BLOCKING });
  const { hierarchy } = tick([row(300, [EMERGENCY_LABEL], LINK("#889"))], { dir, w });
  assert.deepEqual([...hierarchy.emergencyRows ?? []], []);
  assert.deepEqual(entriesIn(dir).map((entry) => entry.ref), [`${REPO}#300:unknown:actor`]);
}));

test("THE EXPIRY: the incident closing takes the label off the row, once the item reads closed -- and an open one does not", () => withDir((dir) => {
  const rows = [row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": OPEN_BLOCKING });
  const open = tick(rows, { dir, w, minutes: 0 });
  assert.deepEqual(w.writes, [], "control: while the incident is open nothing is removed");
  assert.deepEqual([...open.hierarchy.emergencyRows ?? []], [300]);
  w.items["#889"] = { ...OPEN_BLOCKING, state: "closed" };
  const closed = tick(rows, { dir, w, minutes: 10 });
  assert.deepEqual(w.writes, [["removeLabelFromRow", 300, EMERGENCY_LABEL]], "the gate itself removes the label");
  assert.deepEqual([...closed.hierarchy.emergencyRows ?? []], [], "and the row is not honoured on the tick the incident closed");
  assert.deepEqual(closed.told, [], "an expiry is not misuse: ceo is not told, and no misuse line is written");
  assert.deepEqual(entriesIn(dir).map((entry) => entry.classKey), [EMERGENCY_PRIORITY_USED_KIND]);
}));

test("an incident or history that cannot be READ fails closed: not honoured, and the label is NOT removed (an outage neither grants nor takes away)", () => withDir((dir) => {
  const rows = [row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": OPEN_BLOCKING });
  w.unreadable = true;
  const down = tick(rows, { dir, w });
  assert.deepEqual([...down.hierarchy.emergencyRows ?? []], []);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(entriesIn(dir), [], "and no incident is forged from an outage");
  assert.deepEqual(down.told, []);
  w.unreadable = false;
  assert.deepEqual([...tick(rows, { dir, w, minutes: 5 }).hierarchy.emergencyRows ?? []], [300], "control: the same world, readable, honours it");
  delete w.items["#889"]; // the history reads, the incident item does not
  const half = tick(rows, { dir, w, minutes: 10 });
  assert.deepEqual([...half.hierarchy.emergencyRows ?? []], []);
  assert.deepEqual(w.writes, [], "an item that cannot be read is not a closed one");
}));

test("an agent's priority:chairman is STILL ignored and recorded, beside an honoured emergency, and the emergency label changes nothing about it", () => withDir((dir) => {
  const rows = [row(200, [CHAIRMAN_LABEL]), row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [CHAIRMAN_LABEL]: { 200: `${CEO}\n` }, [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": OPEN_BLOCKING });
  const { hierarchy, chairmanTold, offered } = tick(rows, { dir, w });
  assert.deepEqual([...hierarchy.chairmanRows ?? []], [], "the chairman's label by an agent never makes a chairman row, whoever the agent is");
  assert.deepEqual([...hierarchy.emergencyRows ?? []], [300]);
  assert.deepEqual(chairmanTold.map((order) => order.causeKey), [`ceo/chairman-label-ignored/200-${CEO}`]);
  assert.deepEqual(entriesIn(dir).map((entry) => entry.classKey).sort(), [CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, EMERGENCY_PRIORITY_USED_KIND]);
  assert.deepEqual(numbersOf(offered), ["row-300", "row-200"]);
}));

test("a row carrying BOTH labels is an emergency row, offered ahead of another chairman row", () => withDir((dir) => {
  const rows = [row(150, [CHAIRMAN_LABEL]), row(300, [CHAIRMAN_LABEL, EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [CHAIRMAN_LABEL]: { 150: `${CHAIRMAN}\n`, 300: `${CHAIRMAN}\n` }, [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": OPEN_BLOCKING });
  const { offered } = tick(rows, { dir, w });
  assert.deepEqual(numbersOf(offered), ["row-300", "row-150"]);
  assert.match(offered[0].prompt, /EMERGENCY PRIORITY/);
}));

test("THE OPTION IS OFF BY DEFAULT: with it off the label is an ordinary label -- nothing read, nothing ordered first, nothing recorded or removed", () => withDir((dir) => {
  const rows = [row(100, []), row(300, [EMERGENCY_LABEL], LINK("#889"))];
  const w = world({ [EMERGENCY_LABEL]: { 300: `${CEO}\n` } }, { "#889": { ...OPEN_BLOCKING, state: "closed" } });
  const off = tick(rows, { dir, w, emergency: EMERGENCY_PRIORITY_OFF });
  assert.deepEqual(numbersOf(off.offered), ["row-100", "row-300"]);
  assert.deepEqual(w.reads, [], "no read at all");
  assert.deepEqual(w.writes, []);
  assert.deepEqual(entriesIn(dir), []);
  assert.equal(off.hierarchy.emergencyRows, undefined);
  const on = tick(rows, { dir, w });
  assert.notEqual(w.reads.length, 0, "control: the SAME world with the option on is read");
  assert.deepEqual(w.writes.length, 1, "and, the incident being closed, its label is removed");
  assert.equal(on.hierarchy.emergencyRows?.size, 0);
}));

test("the option's reader: absent or not enabled is OFF, `enabled: true` is ON with the defaults, and a malformed list falls back to them", () => withDir((dir) => {
  const parse = (value: unknown) => parseEmergencyPriorityOption(JSON.stringify(value));
  assert.equal(parse({ schema: 1 }).enabled, false, "no block");
  assert.equal(parse({ emergencyPriority: { enabled: false } }).enabled, false);
  assert.equal(parse({ emergencyPriority: { enabled: "true" } }).enabled, false, "only the boolean true turns it on");
  assert.equal(parse({ emergencyPriority: [] }).enabled, false, "a block that is not an object");
  assert.equal(parseEmergencyPriorityOption("{not json").enabled, false);
  const on = parse({ emergencyPriority: { enabled: true } });
  assert.deepEqual([on.enabled, on.setters, on.incidentKeys], [true, EMERGENCY_PRIORITY_OFF.setters, EMERGENCY_PRIORITY_OFF.incidentKeys]);
  assert.deepEqual(parse({ emergencyPriority: { enabled: true, setters: ["somebody"] } }).setters, ["somebody"]);
  assert.deepEqual(parse({ emergencyPriority: { enabled: true, setters: [] } }).setters, EMERGENCY_PRIORITY_OFF.setters, "an empty list does not mean nobody is refused");
  assert.equal(readEmergencyPriorityOption(join(dir, "no-such-host.json")).enabled, false, "an absent file is off");
}));
