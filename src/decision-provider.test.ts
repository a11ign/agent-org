// #4628: the decision seam. A fake `fetch`, a fake `readKey`, a fake diagnostic and a temp directory only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, decisionLogPathFrom, decisionsIn, decisionSwitchesPath, MAX_STATE_BYTES, OUTCOME_ASKED, recordOutcome, type DecisionDeps, type Question } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { freshState, triageOrder } from "./triage-provider.ts";

const FAKE_KEY = "tsk-FAKE-0123456789-do-not-print";
const KEY_PATH = "/fake/typesafe/key";
const SECRET_STATE = "SECRET-STATE-VALUE-never-logged";
const SECRET_FILE_TEXT = "SECRET-FILE-TEXT-never-echoed";
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 };

const LEVELS = ["tiny", "small", "medium", "large", "huge"] as const;
const QUESTIONS: Record<string, Question> = {
  tier: { type: "choice", instructions: "Which tier?", criteria: { haiku: "mechanical", sonnet: "judgment" }, fallback: "sonnet" },
  size: { type: "score", instructions: "How big?", levels: LEVELS, fallback: 3 },
};
const STATE = { row: 4628, title: SECRET_STATE };
/** The API's own shape for a score: the level's POSITION from zero, fractional (`0.04` for level 0), so `size[0]` is the 1-based level and what is sent back is `level - 1 + 0.04`. */
const positionOf = (level: number): number => level - 1 + 0.04;
const reply = (tier: [string, number], size: [number, number]) => ({
  answers: { tier: { type: "choice", choice: tier[0], probabilities: {}, confidence: tier[1] }, size: { type: "score", score: positionOf(size[0]), confidence: size[1] } },
});

type Reply = { status?: number; body?: unknown; throws?: boolean; hangs?: boolean };
function fakeFetch(r: Reply) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (r.throws) throw new Error("connection refused");
    if (r.hangs) return new Promise(() => {});
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A project directory, a host, a fake network and everything one run can leak through. `switches` is the text of `.agent-org/decisions.json`, absent when `undefined`. */
function rig(opts: { triage?: unknown; switches?: string; reply?: Reply; readKey?: (path: string) => string } = {}) {
  const dir = tmpDir("decision-provider-");
  if (opts.switches !== undefined) {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(decisionSwitchesPath(dir), opts.switches);
  }
  const net = fakeFetch(opts.reply ?? { body: reply(["haiku", 0.95], [2, 0.95]) });
  const lines: string[] = [];
  const reads: string[] = [];
  const logPath = decisionLogPathFrom(join(dir, "state", "wake-ledger"));
  const deps: DecisionDeps = {
    host: withTriage(opts.triage), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line) => lines.push(line),
    readKey: opts.readKey ?? ((path) => { reads.push(path); return FAKE_KEY; }),
    switchesPath: decisionSwitchesPath(dir), logPath, id: "row-4628", now: () => 1_000,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { deps, net, lines, reads, log, logPath };
}
const ON = JSON.stringify({ "model-routing": true });
const FALLBACKS = { tier: "sonnet", size: 3 };
const values = (d: { answers: Record<string, { value: unknown }> }) => Object.fromEntries(Object.entries(d.answers).map(([k, a]) => [k, a.value]));

test("provider absent: via none and the fallbacks, fetch zero times, no key read, no log, no diagnostic", async () => {
  const r = rig({ switches: ON });
  const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
  assert.equal(d.via, "none");
  assert.equal(d.reason, "no triage provider is declared");
  assert.deepEqual(values(d), FALLBACKS);
  assert.ok(d.answers.tier.fellBack && d.fellBack);
  assert.equal(r.net.calls.length, 0);
  assert.deepEqual([r.lines, r.reads, r.log()], [[], [], []]);
});

test("provider none, written explicitly: the same", async () => {
  const r = rig({ triage: { provider: "none" }, switches: ON });
  const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
  assert.deepEqual([d.via, values(d), r.net.calls.length], ["none", FALLBACKS, 0]);
});

test("the key missing: fallbacks, no throw, fetch zero times, ONE diagnostic across 50 decisions, nothing logged", async () => {
  const r = rig({ triage: JEV, switches: ON, readKey: () => { throw new Error(`ENOENT: no such file ${KEY_PATH}`); } });
  for (let i = 0; i < 50; i += 1) {
    const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
    assert.deepEqual([d.via, d.reason, values(d)], ["none", "triage-unavailable", FALLBACKS]);
  }
  assert.equal(r.net.calls.length, 0);
  assert.equal(r.lines.length, 1);
  assert.ok(!r.lines[0].includes(KEY_PATH));
  assert.deepEqual(r.log(), [], "a decision that asked nobody writes no line");
});

test("the use switched off: no file, a false, or another use's true all fall back with fetch zero times and no key read", async () => {
  for (const switches of [undefined, JSON.stringify({ "model-routing": false }), JSON.stringify({ "review-depth": true }), "{}"]) {
    const r = rig({ triage: JEV, switches });
    const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
    assert.deepEqual([d.via, d.reason, values(d)], ["none", "the use is switched off", FALLBACKS], String(switches));
    assert.deepEqual([r.net.calls.length, r.reads, r.lines, r.log()], [0, [], [], []], String(switches));
  }
});

test("a malformed switch file turns every use off with ONE diagnostic naming the file and never its content", async () => {
  for (const text of ["{ not json " + SECRET_FILE_TEXT, JSON.stringify([SECRET_FILE_TEXT]), JSON.stringify({ "model-routing": SECRET_FILE_TEXT })]) {
    const r = rig({ triage: JEV, switches: text });
    for (let i = 0; i < 5; i += 1) assert.deepEqual([(await decide("model-routing", STATE, QUESTIONS, r.deps)).via, r.net.calls.length], ["none", 0]);
    assert.equal(r.lines.length, 1, "one line per process, not one per decision");
    assert.ok(r.lines[0].includes(r.deps.switchesPath!), "names the file");
    assert.ok(!r.lines[0].includes(SECRET_FILE_TEXT), "does not echo it");
    const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
    assert.equal(d.reason, "the use is switched off: the switches file could not be used", "the reason is not the plain `switched off` of a file that said so");
    assert.ok(!JSON.stringify(d).includes(SECRET_FILE_TEXT));
  }
});

test("CONTROL: provider on, use on: one request carrying the key, both questions and the state; answers come back with their confidence", async () => {
  const r = rig({ triage: JEV, switches: ON });
  const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
  assert.deepEqual([d.via, d.fellBack, values(d)], ["jev", false, { tier: "haiku", size: 2 }]);
  assert.deepEqual([d.answers.tier.confidence, d.answers.size.confidence], [0.95, 0.95]);
  assert.equal(r.net.calls.length, 1);
  assert.equal(r.net.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  const sent = JSON.parse(r.net.calls[0].init.body);
  assert.deepEqual(sent.state, STATE);
  assert.deepEqual(sent.questions.tier, { type: "choice", instructions: "Which tier?", criteria: QUESTIONS.tier.type === "choice" ? QUESTIONS.tier.criteria : {} });
  assert.deepEqual(sent.questions.size, { type: "score", instructions: "How big?", criteria: [...LEVELS] }, "a score's levels go as `criteria`, an ordered array, and no `fallback`");
  assert.ok(!("fallback" in sent.questions.tier) && !("minConfidence" in sent.questions.tier), "the fallback is the caller's and is not sent");
});

test("a confidence under the floor replaces THAT answer with its fallback and says so; the other answer stands", async () => {
  const r = rig({ triage: JEV, switches: ON, reply: { body: reply(["haiku", 0.89], [4, 0.95]) } });
  const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
  assert.deepEqual(values(d), { tier: "sonnet", size: 4 });
  assert.deepEqual([d.via, d.fellBack, d.answers.tier.fellBack, d.answers.size.fellBack], ["jev", true, true, false]);
  assert.equal(d.answers.tier.asked, "haiku");
  assert.match(d.answers.tier.reason!, /haiku at 0\.89, under the floor 0\.9/);
});

test("a score is read from the provider's zero-based fractional position: ROUNDED to the nearest level and moved to 1..5; a position outside the five levels is malformed", async () => {
  const asked = async (score: unknown) => {
    const body = { answers: { tier: { type: "choice", choice: "haiku", probabilities: {}, confidence: 0.99 }, size: { type: "score", score, confidence: 0.99 } } };
    const d = await decide("model-routing", STATE, QUESTIONS, rig({ triage: JEV, switches: ON, reply: { body } }).deps);
    return d.answers.size.fellBack ? "fallback" : d.answers.size.value;
  };
  const cases: [unknown, unknown][] = [[0, 1], [0.04, 1], [0.49, 1], [0.5, 2], [1.6, 3], [2, 3], [3.4, 4], [4, 5], [4.4, 5], [4.6, "fallback"], [5, "fallback"], [-0.4, 1], [-0.6, "fallback"], ["2", "fallback"], [null, "fallback"]];
  for (const [position, level] of cases) assert.equal(await asked(position), level, `position ${String(position)}`);
});

test("a question's own floor beats the host's: 0.8 passes a 0.9 host floor when the question says 0.7, and fails when it says 0.85", async () => {
  const r = rig({ triage: JEV, switches: ON, reply: { body: reply(["haiku", 0.8], [4, 0.8]) } });
  const low = { ...QUESTIONS, tier: { ...QUESTIONS.tier, minConfidence: 0.7 } as Question, size: { ...QUESTIONS.size, minConfidence: 0.85 } as Question };
  const d = await decide("model-routing", STATE, low, r.deps);
  assert.deepEqual([d.answers.tier.fellBack, d.answers.size.fellBack], [false, true]);
});

test("an answer the question does not allow falls back to its fallback: a choice outside the criteria, a score of 6, a confidence of 2, a missing answer", async () => {
  for (const body of [reply(["gpt", 0.99], [2, 0.99]), reply(["haiku", 0.99], [6, 0.99]), reply(["haiku", 2], [2, 2]), { answers: {} }, { answers: { tier: "haiku", size: 5 } }]) {
    const r = rig({ triage: JEV, switches: ON, reply: { body } });
    const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
    assert.ok(Object.values(d.answers).some((a) => a.fellBack), JSON.stringify(body));
    for (const a of Object.values(d.answers)) if (a.fellBack) assert.ok([...Object.values(FALLBACKS)].includes(a.value as never));
  }
  const r = rig({ triage: JEV, switches: ON, reply: { body: reply(["gpt", 0.99], [6, 0.99]) } });
  const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
  assert.deepEqual([d.via, d.reason, values(d)], ["none", "the API's answer was not a choice with a confidence", FALLBACKS]);
});

test("a failing API takes the fallbacks and never throws: HTTP 500, a thrown fetch, a timeout", async () => {
  for (const failing of [{ status: 500 }, { throws: true }, { hangs: true }]) {
    const r = rig({ triage: JEV, switches: ON, reply: failing });
    const d = await decide("model-routing", STATE, QUESTIONS, r.deps);
    assert.deepEqual([d.via, values(d), r.net.calls.length], ["none", FALLBACKS, 1], JSON.stringify(failing));
    assert.equal(r.log().length, 1, "a request went out, so the failure is logged");
  }
});

test("a state over the cap is not sent; a use this tool does not know is not asked; no question is no request", async () => {
  const r = rig({ triage: JEV, switches: ON });
  const big = { body: "x".repeat(MAX_STATE_BYTES) };
  assert.equal((await decide("model-routing", big, QUESTIONS, r.deps)).reason, "the state is too large to send");
  assert.equal((await decide("nonsense" as never, STATE, QUESTIONS, r.deps)).reason, "the use is not one this tool knows");
  assert.equal((await decide("model-routing", STATE, {}, r.deps)).reason, "no question was asked");
  assert.equal(r.net.calls.length, 0);
});

test("a deps that throws is a decision that failed, not a throw: the fallbacks, one line, no error text", async () => {
  const r = rig({ triage: JEV, switches: ON });
  const d = await decide("model-routing", STATE, QUESTIONS, { ...r.deps, switches: new Proxy({}, { get() { throw new Error(`boom ${KEY_PATH}`); } }) });
  assert.deepEqual([d.via, d.reason, values(d)], ["none", "the decision read failed", FALLBACKS]);
  assert.equal(r.lines.length, 1);
  assert.ok(!r.lines[0].includes(KEY_PATH));
});

test("the log: one line per asked decision with use, questions, answers, via, fellBack, outcome asked, at and the state's FIELD NAMES; no state value and no key", async () => {
  const r = rig({ triage: JEV, switches: ON, reply: { body: reply(["haiku", 0.89], [4, 0.95]) } });
  await decide("model-routing", STATE, QUESTIONS, r.deps);
  await decide("model-routing", STATE, QUESTIONS, r.deps);
  const lines = r.log();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    use: "model-routing", id: "row-4628", fields: ["row", "title"], questions: ["tier", "size"], via: "jev", fellBack: true, outcome: "asked", at: 1_000,
    answers: {
      tier: { value: "sonnet", confidence: 0.89, fellBack: true, asked: "haiku", reason: "haiku at 0.89, under the floor 0.9" },
      size: { value: 4, confidence: 0.95, fellBack: false },
    },
  });
  const raw = readFileSync(r.logPath, "utf8");
  assert.ok(!raw.includes(SECRET_STATE) && !raw.includes(FAKE_KEY), "neither the state's values nor the key reach the log");
});

test("recordOutcome appends the eventual outcome under the same id; without a logPath it writes nothing and does not throw", async () => {
  const r = rig({ triage: JEV, switches: ON });
  await decide("model-routing", STATE, QUESTIONS, r.deps);
  recordOutcome("model-routing", "row-4628", "merged", { logPath: r.logPath, now: () => 2_000 });
  const lines = r.log();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { use: "model-routing", id: "row-4628", outcome: "merged", at: 2_000 });
  recordOutcome("model-routing", "row-4628", "route sonnet/high via fallback", { logPath: r.logPath, now: () => 3_000 }, "the use is switched off");
  assert.deepEqual(r.log().at(-1), { use: "model-routing", id: "row-4628", outcome: "route sonnet/high via fallback", reason: "the use is switched off", at: 3_000 });
  assert.equal(r.log().length, 3);
  recordOutcome("model-routing", "row-4628", "merged", {});
  assert.equal(r.log().length, 3);
  const lost: string[] = [];
  recordOutcome("model-routing", "x", "merged", { logPath: join(r.logPath, "inside-a-file"), diagnostic: (l) => lost.push(l) });
  assert.equal(lost.length, 1);
});

// --- one counted decision per routing (#4754) ---

/** The REQUEST line as `decide` wrote it before #4754: the same line with no `outcome`, which is what a reader saw as None. */
const asBeforeTheChange = (lines: any[]) => lines.map(({ outcome, ...rest }) => (rest.answers === undefined ? { outcome, ...rest } : rest));
const withoutOutcome = (lines: any[]) => lines.filter((l) => l.outcome === undefined);

test("a routing is ONE counted decision and no line of it reads outcome None: the request line says asked, and the outcome beside it closes it", async () => {
  const r = rig({ triage: JEV, switches: ON });
  await decide("model-routing", STATE, QUESTIONS, r.deps);
  recordOutcome("model-routing", "row-4628", "route haiku/high via jev", { logPath: r.logPath, now: () => 2_000 }, "the provider answered");
  const lines = r.log();
  assert.equal(lines.length, 2, "two lines are written, as before");
  assert.deepEqual(lines.map((l) => l.outcome), [OUTCOME_ASKED, "route haiku/high via jev"]);
  assert.deepEqual(withoutOutcome(lines), [], "no line reads outcome None");
  assert.deepEqual(decisionsIn(lines), [{ use: "model-routing", id: "row-4628", at: 1_000, asked: true, outcome: "route haiku/high via jev", reason: "the provider answered" }]);
});

test("the control: the writer as it was leaves two lines per routing and one of them None, and the same reading still counts one", async () => {
  const r = rig({ triage: JEV, switches: ON });
  await decide("model-routing", STATE, QUESTIONS, r.deps);
  recordOutcome("model-routing", "row-4628", "route haiku/high via jev", { logPath: r.logPath, now: () => 2_000 });
  const before = asBeforeTheChange(r.log());
  assert.equal(before.length, 2, "counted by line it is two decisions");
  assert.equal(withoutOutcome(before).length, 1, "and one of them reads None: this is the defect, and the check above is what notices it gone");
  assert.equal(decisionsIn(before).length, 1);
  assert.deepEqual(decisionsIn(before), decisionsIn(r.log()), "the old shape and the new read as the same decision");
});

test("decisionsIn over a mixed log: old requests, new requests, outcome-only routings, a repeated id and an open request each count once; lines it cannot read are skipped", () => {
  const request = (id: string, at: number, outcome?: string) => ({ use: "model-routing", id, fields: ["row"], questions: ["tier"], answers: { tier: { value: "sonnet", fellBack: true } }, via: "jev", fellBack: false, ...(outcome === undefined ? {} : { outcome }), at });
  const done = (id: string, outcome: string, at: number, reason?: string) => ({ use: "model-routing", id, outcome, ...(reason === undefined ? {} : { reason }), at });
  const log = [
    request("row-1", 10),                       // before #4754: no outcome
    done("row-1", "route haiku/high via jev", 11),
    done("row-2", "route haiku/high via override", 12), // nobody was asked: an outcome line alone
    request("row-3", 20, "asked"),              // since #4754
    done("row-3", "route sonnet/high via fallback", 21, "under the floor"),
    request("row-1", 30, "asked"),              // the same row routed again: its own decision
    done("row-1", "route sonnet/high via jev", 31),
    request("row-4", 40, "asked"),              // asked, and nothing has come of it yet
    request("row-5", 41, "asked"),              // two open at once: each outcome closes ITS request, not the earliest
    request("row-6", 42, "asked"),
    done("row-6", "route haiku/high via jev", 43),
    done("row-5", "route sonnet/high via jev", 44),
    { use: "wake-triage", via: "none", answers: {}, at: 50 }, // a request with no id can be counted and never paired
    null, "not an object", { outcome: "no use" }, { use: "model-routing", at: 60 }, // unreadable or neither shape
  ];
  assert.deepEqual(decisionsIn(log).map((d) => [d.id, d.at, d.asked, d.outcome]), [
    ["row-1", 10, true, "route haiku/high via jev"],
    ["row-2", 12, false, "route haiku/high via override"],
    ["row-3", 20, true, "route sonnet/high via fallback"],
    ["row-1", 30, true, "route sonnet/high via jev"],
    ["row-4", 40, true, OUTCOME_ASKED],
    ["row-5", 41, true, "route sonnet/high via jev"],
    ["row-6", 42, true, "route haiku/high via jev"],
    [undefined, 50, true, OUTCOME_ASKED],
  ]);
  assert.equal(decisionsIn(log).find((d) => d.id === "row-3")?.reason, "under the floor");
  assert.deepEqual(decisionsIn([]), []);
});

test("a log that cannot be written does not take the decision with it", async () => {
  const r = rig({ triage: JEV, switches: ON });
  mkdirSync(join(r.logPath, ".."), { recursive: true });
  writeFileSync(r.logPath, "a file where the log's directory would have to be");
  const d = await decide("model-routing", STATE, QUESTIONS, { ...r.deps, logPath: join(r.logPath, "decisions") });
  assert.deepEqual([d.via, values(d)], ["jev", { tier: "haiku", size: 2 }]);
  assert.equal(r.lines.filter((l) => /could not be written/.test(l)).length, 1);
});

test("triageOrder is a caller: a host's own `triage` declaration is its switch (no decisions.json needed), and it asks five atomic questions over the order's facts and writes no log (#4631)", async () => {
  const answer = (choice: string) => ({ type: "choice", choice, probabilities: {}, confidence: 0.95 });
  const names = ["asks-this-seat", "repeat", "names-red-main", "names-chairman-direction", "informational-only"];
  const body = { answers: Object.fromEntries(names.map((n) => [n, answer(n === "informational-only" ? "yes" : "no")])) };
  const r = rig({ triage: JEV, reply: { body } });
  const order = { cause: "answer-owed", causeKey: "product-manager/answer-owed/row-1", session: "product-manager" };
  const { logPath: _omitted, ...asTriageCaller } = r.deps;
  const t = await triageOrder(order, asTriageCaller);
  assert.deepEqual([t.route, t.via, t.confidence], ["digest", "jev", 0.95]);
  const { questions, ...rest } = JSON.parse(r.net.calls[0].init.body);
  assert.deepEqual(rest, { state: order, model: "jev-latest" });
  assert.deepEqual(Object.keys(questions), names);
  assert.deepEqual(Object.keys(questions["repeat"]), ["type", "instructions", "criteria"]);
  assert.deepEqual(r.log(), [], "triageOrder passes no logPath, so it writes nothing it did not write before");
});
