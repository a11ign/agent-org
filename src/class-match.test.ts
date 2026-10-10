// #4633: which known failure class is an incident? A fake `fetch`, a fake `readKey`, a fixture index and a temp directory only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyChildArgv, classifyIncident, labelUnclassedRows, liveClassRepeatIo, liveMatchIo, parseClassifyArgv, parseFailureClasses, readClassRepeat, type FailureClass, type MatchIo, type UnclassedRow } from "./class-repeat.ts";
import { classOfKind, FLAT_CLASS_LIMIT, incidentState, matchFailureClass, NONE_OF_THESE, NO_GUARD, recordLabelOutcome, type Incident } from "./class-match.ts";
import { decisionLogPathFrom, type DecisionDeps } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { freshState } from "./triage-provider.ts";

const FAKE_KEY = "tsk-FAKE-0123456789-do-not-print";
const KEY_PATH = "/fake/typesafe/key";
const SECRET_BODY = "SECRET-ROW-BODY-never-sent";
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const FLOOR = 0.9;
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: FLOOR };
const ON = { "failure-class-match": true } as const;

const entry = (id: string, guard: string | null = null, extra: Partial<FailureClass> = {}): FailureClass => ({ id, name: `the ${id} failure`, guard, guardNote: null, ...extra });
const INDEX = [entry("main-red"), entry("copy-drift", "copies-drifted check"), entry("owner-unresolved", null, { kinds: ["owner-lookup-failed"] })];
const INCIDENT: Incident = { kind: "defect", title: "Thirteen agent-org copies name originals that moved", cause: `the copies name paths the core renamed\n${SECRET_BODY}` };

type Reply = { status?: number; body?: unknown; throws?: boolean; hangs?: boolean };
const choice = (value: string, confidence: number) => ({ answers: { class: { type: "choice", choice: value, probabilities: {}, confidence } } });
function fakeFetch(replies: Reply | Reply[]) {
  const calls: { url: string; init: any }[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = queue === null ? (replies as Reply) : (queue.shift() ?? {});
    if (r.throws) throw new Error("connection refused");
    if (r.hangs) return new Promise(() => {});
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const sent = (call: { init: any }) => JSON.parse(call.init.body);

function rig(opts: { triage?: unknown, switches?: DecisionDeps["switches"], reply?: Reply | Reply[], readKey?: (path: string) => string } = {}) {
  const dir = tmpDir("class-match-");
  const net = fakeFetch(opts.reply ?? { body: choice("copy-drift", 0.95) });
  const lines: string[] = [];
  const reads: string[] = [];
  const logPath = decisionLogPathFrom(join(dir, "state", "wake-ledger"));
  const deps: DecisionDeps = {
    host: withTriage(opts.triage), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line) => lines.push(line),
    readKey: opts.readKey ?? ((path) => { reads.push(path); return FAKE_KEY; }),
    switches: "switches" in opts ? opts.switches : ON, logPath, id: "incident-1", now: () => 1_000,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { deps, net, lines, reads, log };
}

const KIND_MATCH: Incident = { ...INCIDENT, kind: "main-red" };

test("provider absent: the exact kind names its class, an unplaceable kind is none-of-these, and nothing is asked, read, logged or said", async () => {
  const r = rig();
  const hit = await matchFailureClass(KIND_MATCH, INDEX, r.deps);
  const miss = await matchFailureClass(INCIDENT, INDEX, r.deps);
  assert.deepEqual([hit.classId, hit.via, miss.classId, miss.via], ["main-red", "none", null, "none"]);
  assert.deepEqual([r.net.calls.length, r.reads, r.lines, r.log()], [0, [], [], []]);
});

test("provider none, written explicitly: the same", async () => {
  const r = rig({ triage: { provider: "none" } });
  assert.equal((await matchFailureClass(KIND_MATCH, INDEX, r.deps)).classId, "main-red");
  assert.equal(r.net.calls.length, 0);
});

test("the key missing: the kind rule, no throw, fetch zero times, ONE diagnostic across many incidents, nothing logged", async () => {
  const r = rig({ triage: JEV, readKey: () => { throw new Error(`ENOENT: no such file ${KEY_PATH}`); } });
  for (let i = 0; i < 20; i += 1) assert.equal((await matchFailureClass(KIND_MATCH, INDEX, r.deps)).classId, "main-red");
  assert.equal((await matchFailureClass(INCIDENT, INDEX, r.deps)).classId, null);
  assert.deepEqual([r.net.calls.length, r.lines.length, r.log()], [0, 1, []]);
  assert.ok(!r.lines.join("\n").includes(KEY_PATH));
});

test("the use switched off (absent, or false): the provider is not asked even with a key, and a kind still places", async () => {
  for (const switches of [{}, { "failure-class-match": false }] as const) {
    const r = rig({ triage: JEV, switches });
    const m = await matchFailureClass(KIND_MATCH, INDEX, r.deps);
    assert.deepEqual([m.classId, m.via, m.reason, r.net.calls.length, r.reads, r.log()], ["main-red", "none", "the use is switched off", 0, [], []]);
  }
});

test("provider on: a confident answer classes an incident whose kind places nowhere, with one request carrying only the trimmed state and the class choices", async () => {
  const r = rig({ triage: JEV });
  const m = await matchFailureClass(INCIDENT, INDEX, r.deps);
  assert.deepEqual([m.classId, m.via, m.reason], ["copy-drift", "jev", undefined]);
  assert.equal(r.net.calls.length, 1);
  const body = sent(r.net.calls[0]);
  assert.deepEqual(body.state, { kind: "defect", title: INCIDENT.title, cause: "the copies name paths the core renamed" });
  assert.ok(!r.net.calls[0].init.body.includes(SECRET_BODY), "only the first line of the cause is sent");
  assert.deepEqual(Object.keys(body.questions.class.criteria).sort(), [...INDEX.map((c) => c.id), NONE_OF_THESE].sort());
  assert.match(body.questions.class.criteria["copy-drift"], /the copy-drift failure \[guard: copies-drifted check\]/);
  assert.match(body.questions.class.criteria["main-red"], /\[guard: none\]/);
  assert.ok(!r.net.calls[0].init.body.includes(FAKE_KEY), "the key is a header, never the body");
});

test("provider on, answering none-of-these at the floor: no class and no label", async () => {
  const r = rig({ triage: JEV, reply: { body: choice(NONE_OF_THESE, 0.97) } });
  const m = await classifyIncident(INCIDENT, INDEX, r.deps);
  assert.deepEqual([m.classId, m.label, m.via], [null, null, "jev"]);
});

test("a label is named only for a class: classifyIncident adds `class:<id>` and nothing for none-of-these", async () => {
  const hit = await classifyIncident(INCIDENT, INDEX, rig({ triage: JEV }).deps);
  assert.deepEqual([hit.classId, hit.label], ["copy-drift", "class:copy-drift"]);
  assert.equal((await classifyIncident(INCIDENT, INDEX, rig().deps)).label, null);
});

test("a confidence under the floor is the rule's answer: none-of-these for an unplaceable kind (no label), the kind's class for a placeable one", async () => {
  const under = { body: choice("copy-drift", FLOOR - 0.01) };
  const miss = await matchFailureClass(INCIDENT, INDEX, rig({ triage: JEV, reply: under }).deps);
  assert.deepEqual([miss.classId, miss.via], [null, "jev"]);
  assert.match(String(miss.reason), /under the floor/);
  const hit = await matchFailureClass(KIND_MATCH, INDEX, rig({ triage: JEV, reply: under }).deps);
  assert.equal(hit.classId, "main-red");
  // ...and at exactly the floor the provider's answer stands, so the floor test is not vacuous.
  assert.equal((await matchFailureClass(INCIDENT, INDEX, rig({ triage: JEV, reply: { body: choice("copy-drift", FLOOR) } }).deps)).classId, "copy-drift");
});

test("a refusal, a timeout, a thrown fetch and a malformed or invented answer all take the rule, with no throw", async () => {
  const replies: Reply[] = [
    { status: 401 }, { status: 503 }, { hangs: true }, { throws: true }, { body: null }, { body: { answers: {} } },
    { body: choice("not-a-class", 0.99) }, { body: { answers: { class: { type: "choice", choice: "copy-drift" } } } }, { body: choice("copy-drift", 7) },
  ];
  for (const reply of replies) {
    const r = rig({ triage: JEV, reply });
    const miss = await matchFailureClass(INCIDENT, INDEX, r.deps);
    const hit = await matchFailureClass(KIND_MATCH, INDEX, r.deps);
    assert.deepEqual([miss.classId, hit.classId, r.net.calls.length], [null, "main-red", 2], JSON.stringify(reply));
  }
});

test("the rule: the class id, or any declared kind, matches exactly; a near miss, an empty kind and a class named none-of-these do not", () => {
  assert.equal(classOfKind("owner-lookup-failed", INDEX)?.id, "owner-unresolved");
  assert.equal(classOfKind("owner-unresolved", INDEX)?.id, "owner-unresolved");
  assert.equal(classOfKind(" main-red ", INDEX)?.id, "main-red");
  for (const kind of ["main-re", "Main-Red", "", "  ", "main-red-again"]) assert.equal(classOfKind(kind, INDEX), undefined, kind);
  assert.equal(classOfKind(NONE_OF_THESE, [entry(NONE_OF_THESE)]), undefined);
});

test("a class named none-of-these is not offered, so the answer that names none cannot be mistaken for it", async () => {
  const r = rig({ triage: JEV, reply: { body: choice(NONE_OF_THESE, 0.99) } });
  const m = await matchFailureClass(INCIDENT, [...INDEX, entry(NONE_OF_THESE)], r.deps);
  assert.equal(m.classId, null);
  assert.equal(Object.keys(sent(r.net.calls[0]).questions.class.criteria).filter((k) => k === NONE_OF_THESE).length, 1);
});

test("the state is three short fields: a long title and cause are cut, a blank-first-line cause reads its first non-blank line, and no other field is carried", () => {
  const long = "x".repeat(5000);
  const state = incidentState({ kind: "defect", title: long, cause: `\n\n  the cause line  \n${long}` });
  assert.deepEqual(Object.keys(state), ["kind", "title", "cause"]);
  assert.equal(state.cause, "the cause line");
  assert.ok(state.title.length <= 200);
  assert.equal(incidentState({ kind: "k", title: "t", cause: "" }).cause, "");
});

// ---- more than 12 classes: guard first, then id ----

const MANY = [
  ...Array.from({ length: FLAT_CLASS_LIMIT }, (_, i) => entry(`unguarded-${i}`)),
  entry("copy-drift", "copies-drifted check"),
];
const stepReply = (group: string, id: string, confidence = 0.95): Reply[] => [{ body: choice(group, confidence) }, { body: choice(id, confidence) }];

test("exactly 12 classes are one flat question; 13 are two, guard group then id, and each question carries a short list", async () => {
  const twelve = rig({ triage: JEV });
  await matchFailureClass(INCIDENT, MANY.slice(0, FLAT_CLASS_LIMIT), twelve.deps);
  assert.equal(twelve.net.calls.length, 1);
  assert.equal(Object.keys(sent(twelve.net.calls[0]).questions.class.criteria).length, FLAT_CLASS_LIMIT + 1);

  const thirteen = rig({ triage: JEV, reply: stepReply("copies-drifted check", "copy-drift") });
  const m = await matchFailureClass(INCIDENT, MANY, thirteen.deps);
  assert.deepEqual([m.classId, m.via, thirteen.net.calls.length], ["copy-drift", "jev", 2]);
  assert.deepEqual(Object.keys(sent(thirteen.net.calls[0]).questions.class.criteria).sort(), [NO_GUARD, "copies-drifted check", NONE_OF_THESE].sort());
  assert.deepEqual(Object.keys(sent(thirteen.net.calls[1]).questions.class.criteria), ["copy-drift", NONE_OF_THESE]);
});

test("two steps: a group answered none-of-these ends the match with one request; an id under the floor is the rule's, and a group the provider invents is none", async () => {
  const none = rig({ triage: JEV, reply: stepReply(NONE_OF_THESE, "copy-drift") });
  assert.deepEqual([(await matchFailureClass(INCIDENT, MANY, none.deps)).classId, none.net.calls.length], [null, 1]);

  const under = rig({ triage: JEV, reply: stepReply("copies-drifted check", "copy-drift", FLOOR - 0.01) });
  assert.equal((await matchFailureClass(INCIDENT, MANY, under.deps)).classId, null);
  const underHit = rig({ triage: JEV, reply: stepReply(NO_GUARD, "unguarded-3", FLOOR - 0.01) });
  const m = await matchFailureClass({ ...INCIDENT, kind: "unguarded-3" }, MANY, underHit.deps);
  assert.deepEqual([m.classId, m.via], ["unguarded-3", "none"]);
});

test("two steps with no provider: the rule places a kind in either group and asks nobody", async () => {
  const r = rig();
  assert.equal((await matchFailureClass({ ...INCIDENT, kind: "copy-drift" }, MANY, r.deps)).classId, "copy-drift");
  assert.equal((await matchFailureClass({ ...INCIDENT, kind: "unguarded-7" }, MANY, r.deps)).classId, "unguarded-7");
  assert.equal((await matchFailureClass(INCIDENT, MANY, r.deps)).classId, null);
  assert.equal(r.net.calls.length, 0);
});

// ---- the decision log and its outcome ----

test("a provider-classed incident is a decision-log line (fields named, values never) and its eventual outcome is a second line", async () => {
  const r = rig({ triage: JEV });
  await matchFailureClass(INCIDENT, INDEX, r.deps);
  const [decision] = r.log();
  assert.deepEqual([decision.use, decision.id, decision.via, decision.answers.class.value], ["failure-class-match", "incident-1", "jev", "copy-drift"]);
  assert.deepEqual(decision.fields, ["kind", "title", "cause"]);
  assert.ok(!JSON.stringify(decision).includes(INCIDENT.title));
  recordLabelOutcome("incident-1", true, r.deps);
  recordLabelOutcome("incident-1", false, r.deps);
  assert.deepEqual(r.log().slice(1).map((l) => [l.use, l.id, l.outcome]), [["failure-class-match", "incident-1", "kept"], ["failure-class-match", "incident-1", "removed"]]);
});

test("an incident the provider was never asked about writes no decision line; recording an outcome without a log path writes nothing and does not throw", async () => {
  const r = rig();
  await matchFailureClass(KIND_MATCH, INDEX, r.deps);
  assert.deepEqual(r.log(), []);
  recordLabelOutcome("incident-1", true, { diagnostic: () => {} });
});

test("a fallback taken after the provider answered under the floor is logged as a fallback, with the class it declined", async () => {
  const r = rig({ triage: JEV, reply: { body: choice("copy-drift", 0.5) } });
  await matchFailureClass(INCIDENT, INDEX, r.deps);
  const [line] = r.log();
  assert.deepEqual([line.fellBack, line.answers.class.asked, line.answers.class.value], [true, "copy-drift", NONE_OF_THESE]);
});

// ---- the index file ----

test("the index parser carries a declared `kinds` and leaves an entry without one exactly as it was", () => {
  const parsed = parseFailureClasses(JSON.stringify({ classes: [{ id: "a", name: "A", guard: null }, { id: "b", name: "B", kinds: ["k1", 3, ""] }, { id: "c", name: "C", kinds: [] }] }));
  assert.deepEqual(parsed, [
    { id: "a", name: "A", guard: null, guardNote: null },
    { id: "b", name: "B", guard: null, guardNote: null, kinds: ["k1"] },
    { id: "c", name: "C", guard: null, guardNote: null },
  ]);
});

// ---- replay: the 2026-10-09 copy-drift incidents ----

const COPY_DRIFT_ROWS: [number, string][] = [
  [4370, "agent-org: the two drifted copies say what they changed (fixture-symbols 2 lines, sandbox-exhaustion 15), so copies-drifted clears"],
  [4371, "agent-org: two copy headers follow the originals a11ign#4273 renames (sandbox-exhaustion, tree-wide-guard)"],
  [4515, "agent-org's copies of product-home and fixture-symbols name originals the core renamed to .ts"],
  [4557, "The agent-org copies of git-sandbox and tree-wide-guard carry the originals' renamed paths and headers, so copies-drifted clears (org-health, 2026-10-09)"],
  [4569, "The lab's CI lays the core at a commit before a11ign#4393's renames, so agent-org's synced copies read as drifted there and agent-org-wiring [36] and [37] fail"],
  [4582, "Thirteen agent-org copies name originals that moved or became .ts, so copies-drifted reads unknown (mirror of agent-org#505)"],
  [4607, "Stuck pr-checks-failing: lab#52 (the lab status page, a11ign#4567) is red and nothing has fixed it"],
];

test("replay of the 2026-10-09 copy-drift rows: the kind rule groups none of them, a fake answer groups the six that are copy drift and not #4607", async () => {
  // The fake provider answers copy-drift for a title that speaks of copies, standing in for the real model; the test is that the answer REACHES the label, not that a model is right.
  const answering = (async (_url: string, init: any) => {
    const title: string = JSON.parse(init.body).state.title;
    const value = /cop(y|ies)/.test(title) ? "copy-drift" : NONE_OF_THESE;
    return { ok: true, status: 200, json: async () => choice(value, 0.95) };
  }) as unknown as typeof fetch;
  const grouped = new Map<string, number[]>();
  const ruleOnly = new Map<string, number[]>();
  for (const [number, title] of COPY_DRIFT_ROWS) {
    const incident: Incident = { kind: "defect", title, cause: "" };
    const on = rig({ triage: JEV }).deps;
    const viaProvider = await classifyIncident(incident, INDEX, { ...on, fetch: answering });
    const viaRule = await classifyIncident(incident, INDEX, rig().deps);
    if (viaProvider.label !== null) grouped.set(viaProvider.label, [...(grouped.get(viaProvider.label) ?? []), number]);
    if (viaRule.label !== null) ruleOnly.set(viaRule.label, [...(ruleOnly.get(viaRule.label) ?? []), number]);
  }
  assert.deepEqual([...ruleOnly], []);
  assert.deepEqual([...grouped], [["class:copy-drift", [4370, 4371, 4515, 4557, 4569, 4582]]]);
});

// ---- the production path: the gate's tick lists and remembers, a child asks and labels ----

const CLASS_INDEX = JSON.stringify({ classes: [{ id: "copy-drift", name: "the copy-drift failure", guard: null }] });
const listing = (rows: { number: number; title?: string; labels?: string[]; state?: string; pr?: boolean }[]) => JSON.stringify(rows.map((r) => ({
  number: r.number, state: r.state ?? "closed", closed_at: "2026-10-09T10:00:00Z", pull_request: r.pr ?? false, title: r.title ?? `row ${r.number}`, labels: r.labels ?? ["defect"],
})));

/** A fake `gh`: answers the one listing it is given and records every other call. */
function fakeGh(rows: string) {
  const writes: string[][] = [];
  const reads: string[][] = [];
  const run = (args: string[]): string => {
    if (args[0] === "api") { reads.push(args); return rows; }
    writes.push(args);
    return "";
  };
  return { run, writes, reads };
}

function tick(rows: Parameters<typeof listing>[0], opts: { match?: Partial<MatchIo>; asked?: object; now?: number } = {}) {
  const dir = tmpDir("class-match-tick-");
  const statePath = join(dir, "asked.json");
  if (opts.asked !== undefined) writeFileSync(statePath, JSON.stringify(opts.asked));
  const gh = fakeGh(listing(rows));
  const asks: { repo: string; rows: UnclassedRow[] }[] = [];
  const outcomes: [number, boolean][] = [];
  const match: MatchIo = { statePath, ask: (repo, rs) => asks.push({ repo, rows: rs }), outcome: (row, kept) => outcomes.push([row, kept]), ...opts.match };
  const logs: string[] = [];
  const read = () => readClassRepeat(gh.run, "o/r", {
    root: dir, read: (p) => (p.endsWith("failure-classes.json") ? CLASS_INDEX : readFileSync(p, "utf8")), now: opts.now ?? Date.parse("2026-10-09T10:30:00Z"), match, log: (l) => logs.push(l),
  });
  const memory = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
  return { gh, asks, outcomes, read, memory, logs, statePath };
}

test("the tick asks about a closed, unlabelled defect row once: it is remembered before anything is asked, and the next tick asks nobody", () => {
  const t = tick([{ number: 10, title: "copies drifted" }, { number: 11, labels: ["defect", "class:copy-drift"] }, { number: 12, labels: ["enhancement"] }, { number: 13, pr: true }, { number: 14, state: "open" }]);
  t.read();
  assert.deepEqual(t.asks, [{ repo: "o/r", rows: [{ number: 10, title: "copies drifted" }] }]);
  assert.deepEqual(Object.keys(t.memory()), ["10"]);
  t.read();
  assert.equal(t.asks.length, 1, "a remembered row is not asked again");
});

test("the tick asks about at most three rows, newest first, and takes the rest on later ticks", () => {
  const t = tick([10, 11, 12, 13, 14].map((number) => ({ number })));
  t.read();
  assert.deepEqual(t.asks[0].rows.map((r) => r.number), [10, 11, 12]);
  t.read();
  assert.deepEqual(t.asks[1].rows.map((r) => r.number), [13, 14]);
});

test("a caller that gives no match io reads no listing and asks nobody, so a host without the provider is as it was", () => {
  const asks: unknown[] = [];
  const reads = (match?: MatchIo): number => {
    const gh = fakeGh("[]");
    readClassRepeat(gh.run, "o/r", { root: "/nowhere", read: () => CLASS_INDEX, now: 0, log: () => {}, ...(match === undefined ? {} : { match }) });
    return gh.reads.length;
  };
  const without = reads();
  const withMatch = reads({ statePath: join(tmpDir("class-match-off-"), "asked.json"), ask: (...a) => asks.push(a), outcome: () => {} });
  assert.equal(withMatch, without + 1, "the listing is the one read `match` adds");
  assert.deepEqual(asks, [], "and an empty listing asks nobody");
});

test("a refused or malformed listing is logged, nothing is remembered and nothing is asked", () => {
  const t = tick([{ number: 10 }], { match: {} });
  // the match listing is the one that projects a title and no close time: the closed-row listing projects both (#570), so "title" alone no longer names it
  const matchListing = (args: string[]) => args.some((a) => String(a).includes("title") && !String(a).includes("closed_at"));
  const bad = readClassRepeat((args) => { if (matchListing(args)) throw new Error("HTTP 403 rate limited"); return "[]"; }, "o/r", {
    root: "/nowhere", read: () => CLASS_INDEX, match: { statePath: t.statePath, ask: () => assert.fail("asked"), outcome: () => {} }, log: (l) => t.logs.push(l),
  });
  assert.ok("index" in bad);
  assert.match(t.logs.join(""), /failed \(HTTP 403 rate limited\)/);
  assert.deepEqual(t.memory(), {});
});

test("an applied label is `removed` the tick a human takes it off, `kept` after a day, and recorded once", () => {
  const at = Date.parse("2026-10-08T10:00:00Z");
  const asked = { "10": { at, label: "class:copy-drift" }, "11": { at, label: "class:copy-drift" }, "12": { at: at + 20 * 3_600_000, label: "class:copy-drift" }, "13": { at, label: null } };
  const t = tick([{ number: 10, labels: ["defect"] }, { number: 11, labels: ["defect", "class:copy-drift"] }, { number: 12, labels: ["defect", "class:copy-drift"] }, { number: 13, labels: ["defect"] }], { asked });
  t.read();
  assert.deepEqual(t.outcomes, [[10, false], [11, true]], "10 lost it, 11 held it a day, 12 is only 14 hours old, 13 was never labelled");
  t.read();
  assert.equal(t.outcomes.length, 2, "each is recorded once");
});

test("the child applies the label the provider names, creating it first, and writes nothing for none-of-these", async () => {
  const r = rig({ triage: JEV, reply: [{ body: choice("copy-drift", 0.95) }, { body: choice(NONE_OF_THESE, 0.95) }] });
  const gh = fakeGh("[]");
  const dir = tmpDir("class-match-child-");
  const statePath = join(dir, "asked.json");
  const index = parseFailureClasses(CLASS_INDEX)!;
  const applied = await labelUnclassedRows([{ number: 10, title: "copies drifted" }, { number: 11, title: "a red PR" }], { run: gh.run, repo: "o/r", index, deps: r.deps, statePath, now: () => 5 });
  assert.deepEqual(applied, { 10: "class:copy-drift", 11: null });
  assert.deepEqual(gh.writes.map((w) => w.slice(0, 3).join(" ")), ["label create class:copy-drift", "issue edit 10"]);
  assert.deepEqual(gh.writes[1], ["issue", "edit", "10", "--repo", "o/r", "--add-label", "class:copy-drift"]);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { 10: { at: 5, label: "class:copy-drift" }, 11: { at: 5, label: null } });
  assert.deepEqual(r.log().map((l) => l.id), ["row-10", "row-11"]);
});

test("the child with no provider labels nothing and a refused label call does not stop the next row", async () => {
  const none = rig();
  const gh = fakeGh("[]");
  const index = parseFailureClasses(CLASS_INDEX)!;
  const statePath = join(tmpDir("class-match-child-"), "asked.json");
  assert.deepEqual(await labelUnclassedRows([{ number: 10, title: "copies drifted" }], { run: gh.run, repo: "o/r", index, deps: none.deps, statePath }), { 10: null });
  assert.deepEqual(gh.writes, []);

  const refusing = rig({ triage: JEV });
  const lines: string[] = [];
  const run = (args: string[]): string => { if (args[0] === "issue" && args[2] === "10") throw new Error("HTTP 422"); return ""; };
  const applied = await labelUnclassedRows([{ number: 10, title: "a" }, { number: 11, title: "b" }], { run, repo: "o/r", index, deps: refusing.deps, statePath, log: (l) => lines.push(l) });
  assert.deepEqual(applied, { 10: null, 11: "class:copy-drift" });
  assert.match(lines.join(""), /could not label #10 as class:copy-drift \(HTTP 422\)/);
});

test("the whole path, on the 2026-10-09 rows: the tick queues three at a time, the child labels the six copy-drift rows and not #4607", async () => {
  const rows = COPY_DRIFT_ROWS.map(([number, title]) => ({ number, title }));
  const dir = tmpDir("class-match-e2e-");
  const gh = fakeGh(listing(rows));
  const answering = (async (_u: string, init: any) => {
    const title: string = JSON.parse(init.body).state.title;
    return { ok: true, status: 200, json: async () => choice(/cop(y|ies)/.test(title) ? "copy-drift" : NONE_OF_THESE, 0.95) };
  }) as unknown as typeof fetch;
  const deps = { ...rig({ triage: JEV }).deps, fetch: answering };
  const index = parseFailureClasses(CLASS_INDEX)!;
  const statePath = join(dir, "asked.json");
  const labelled: number[] = [];
  const match: MatchIo = {
    statePath, outcome: () => {},
    ask: (repo, batch) => { void labelUnclassedRows(batch, { run: gh.run, repo, index, deps, statePath, now: () => 1 }).then((a) => labelled.push(...Object.entries(a).filter(([, l]) => l !== null).map(([n]) => Number(n)))); },
  };
  const read = () => readClassRepeat(gh.run, "o/r", { root: dir, read: () => CLASS_INDEX, match, log: () => {}, now: 0 });
  for (let i = 0; i < 4; i += 1) { read(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.deepEqual(labelled.sort(), [4370, 4371, 4515, 4557, 4569, 4582]);
  const edited = gh.writes.filter((w) => w[0] === "issue").map((w) => Number(w[2])).sort();
  assert.deepEqual(edited, labelled);
  assert.ok(!edited.includes(4607));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8"))).map(Number).sort(), [...COPY_DRIFT_ROWS.map(([n]) => n)].sort());
});

test("liveMatchIo exists only for a jev host with the use switched on, and its ask spawns this file detached", () => {
  const jev = withTriage(JEV);
  const base = { statePath: "/s" };
  assert.equal(liveMatchIo({ host: withTriage(), switches: ON, ...base }), undefined);
  assert.equal(liveMatchIo({ host: withTriage({ provider: "none" }), switches: ON, ...base }), undefined);
  assert.equal(liveMatchIo({ host: jev, switches: {}, ...base }), undefined);
  assert.equal(liveMatchIo({ host: jev, switches: { "failure-class-match": false }, ...base }), undefined);
  const spawned: { command: string; args: string[]; options: any }[] = [];
  let unreffed = false;
  const io = liveMatchIo({ host: jev, switches: ON, ...base, spawnChild: ((command: string, args: string[], options: any) => { spawned.push({ command, args, options }); return { unref: () => { unreffed = true; } }; }) as any });
  io!.ask("o/r", [{ number: 10, title: "t" }]);
  assert.deepEqual([spawned.length, unreffed, spawned[0].options.detached, spawned[0].options.stdio], [1, true, true, "ignore"]);
  assert.deepEqual(parseClassifyArgv(spawned[0].args), { repo: "o/r", rows: [{ number: 10, title: "t" }] });
});

test("the child's argv round-trips, and an argv that is not one is refused", () => {
  const rows = [{ number: 10, title: 'a "quoted" title; rm -rf $HOME' }];
  assert.deepEqual(parseClassifyArgv(classifyChildArgv("o/r", rows)), { repo: "o/r", rows });
  for (const argv of [[], ["--classify-unclassed"], ["--classify-unclassed", "o/r", "not json"], ["--classify-unclassed", "o/r", '[{"number":"x","title":1}]']]) assert.equal(parseClassifyArgv(argv), null);
});

test("the live gate's io carries the match io (undefined on a host without the provider, which is why the key is what is pinned)", () => {
  const io = liveClassRepeatIo();
  assert.ok("match" in io, "liveClassRepeatIo() names `match`, so the gate's readClassRepeat reaches the labelling");
  assert.ok(io.match === undefined || typeof io.match.ask === "function");
  assert.ok(io.match === undefined || io.match.statePath.endsWith("class-match-asked.json"));
});
