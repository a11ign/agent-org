// #4629: the engineer route. A fake `fetch`, a fake key, a fixture row and a temp directory only: no network, no real key, no corpus.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the route beside the row one answer away from it, and the provider-on case beside the four ways the provider is not asked.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { decide, decisionLogPathFrom, decisionSwitchesPath, MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import {
  composeRoute, fallbackRoute, GUARD_DECISIONS, recordRouteOutcome, routeCostEvents, routeCostReading, ROUTE_COSTLIER_THAN_FALLBACK, routeEngineer, routeState, QUESTIONS,
  SCORE_LEVEL_DATA, SUBSYSTEMS_DATA, type Answers, type Route, type RouteRow,
} from "./engineer-route.ts";
import { parseHostConfig } from "./host-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { freshState } from "./triage-provider.ts";
import { ROUTE_AHEAD, routesForStarts, spawnClaimer } from "./wake.ts";
import { AUTOCOMPACT_WINDOW_TOKENS, HAIKU_AUTOCOMPACT_WINDOW_TOKENS, HAIKU_MODEL_ID } from "./worker-profile.ts";

const SECRET_BODY_TEXT = "SECRET-BODY-TEXT-never-sent";
const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };

const bodyOf = ({ region = ["src/a.ts", "src/a.test.ts"], acceptance = "pnpm test", doneWhen = ["1. The Acceptance passes."], extra = "" }: { region?: string[]; acceptance?: string | null; doneWhen?: string[]; extra?: string } = {}) =>
  `${extra}## Region\n\n\`\`\`\n${region.join("\n")}\n\`\`\`\n\n## Acceptance\n\n${acceptance === null ? "Acceptance: none -- a docs row" : `\`\`\`bash\n${acceptance}\n\`\`\``}\n\n## Done-when\n\n${doneWhen.join("\n")}\n`;
const rowOf = (over: Partial<RouteRow> = {}): RouteRow => ({ number: 4999, title: "Rename a helper", labels: ["ready"], body: bodyOf(), ...over });

type Given = Partial<Record<keyof Answers, string | number>> & { confidence?: number; low?: keyof Answers };
const CLEAN_HAIKU = { mechanical: "yes", subsystems: "no", debugging: "no", score: 2 };
/** The API's score is the level's POSITION from zero and fractional (agent-org#564): level 2 comes back `1.04`, not `2`. `score` in a {@link Given} is the 1-based level. */
const positionOf = (level: number): number => level - 1 + 0.04;
/** The provider's reply for a set of answers; `low` names the one question answered under the floor. */
function reply(given: Given) {
  const base = { ...CLEAN_HAIKU, ...given };
  const answers = Object.fromEntries((Object.keys(QUESTIONS) as (keyof Answers)[]).map((name) => {
    const confidence = name === given.low ? 0.5 : given.confidence ?? 0.95;
    return [name, name === "score" ? { type: "score", score: positionOf(base.score as number), confidence, probabilities: {} } : { type: "choice", choice: base[name], probabilities: {}, confidence }];
  }));
  return { answers };
}

/**
 * What the API's OpenAPI document (`components.schemas`, 2026-10-09) requires of a request: a `score` question carries `criteria`, an ORDERED ARRAY of level descriptions, and a
 * `choice` question carries `criteria`, an OBJECT of descriptions by choice. One invalid question rejects the whole request, so this returns the first violation, or `null`.
 */
function violation(sent: unknown): string | null {
  const questions = (sent as { questions?: Record<string, { type?: string; instructions?: unknown; criteria?: unknown }> } | null)?.questions;
  if (typeof questions !== "object" || questions === null) return "questions: required";
  for (const [name, q] of Object.entries(questions)) {
    if (typeof q?.instructions !== "string") return `${name}.instructions: required`;
    if (q.type === "score" && !(Array.isArray(q.criteria) && q.criteria.length === 5 && q.criteria.every((l) => typeof l === "string" && l !== ""))) return `${name}.criteria: a score needs an array of five level descriptions`;
    if (q.type === "choice" && !(typeof q.criteria === "object" && q.criteria !== null && !Array.isArray(q.criteria) && Object.values(q.criteria).length >= 2)) return `${name}.criteria: a choice needs an object`;
    if (q.type !== "score" && q.type !== "choice") return `${name}.type: not a question type`;
  }
  return null;
}

function rig(opts: { triage?: unknown; switches?: string; body?: unknown; haikuSwitch?: string; throws?: boolean; validates?: boolean } = {}) {
  const dir = tmpDir("engineer-route-");
  if (opts.switches !== undefined) {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(decisionSwitchesPath(dir), opts.switches);
  }
  const haikuSwitch = join(dir, "haiku-tier.json");
  writeFileSync(haikuSwitch, opts.haikuSwitch ?? '{ "enabled": true }');
  let calls = 0;
  const sent: unknown[] = [];
  const fn = (async (_url: string, init: { body: string }) => {
    calls += 1;
    if (opts.throws) throw new Error("connection refused");
    sent.push(JSON.parse(init.body));
    // A fake that accepts any body is what let a request the API rejected pass every test: with `validates`, a body the API would refuse is its HTTP 422.
    if (opts.validates && violation(sent.at(-1)) !== null) return { ok: false, status: 422, json: async () => ({ detail: [{ type: "missing", msg: violation(sent.at(-1)) }] }) };
    return { ok: true, status: 200, json: async () => opts.body ?? reply({}) };
  }) as unknown as typeof fetch;
  const logPath = decisionLogPathFrom(join(dir, "state", "wake-ledger"));
  const reads: string[] = [];
  const deps: DecisionDeps & { haikuSwitchPath: string } = {
    host: withTriage(opts.triage), fetch: fn, state: freshState(), timeoutMs: 50, diagnostic: () => {}, switchesPath: decisionSwitchesPath(dir), logPath, now: () => 1_000,
    readKey: (path) => { reads.push(path); return "tsk-FAKE"; }, haikuSwitchPath: haikuSwitch,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { deps, calls: () => calls, sent, reads, log, logPath };
}
const ON = JSON.stringify({ "model-routing": true });

// --- composeRoute: pure (#4764) ---

const CLEAN: Answers = { mechanical: true, subsystems: false, debugging: false, score: 2 };
const SMALL = { regionFiles: 2 };
const MANY = { regionFiles: 4 };

test("composeRoute: mechanical and a score of at most 2 is Haiku/high; the answers one step away are not, and each lands where its own rule says", () => {
  assert.equal(composeRoute(CLEAN, SMALL), "haiku/high");
  assert.equal(composeRoute({ ...CLEAN, score: 1 }, SMALL), "haiku/high");
  assert.equal(composeRoute({ ...CLEAN, score: 3 }, SMALL), "sonnet/medium", "score 3 is not a Haiku row, but it is a medium one");
  assert.equal(composeRoute({ ...CLEAN, score: 4 }, SMALL), "sonnet/high");
  assert.equal(composeRoute({ ...CLEAN, mechanical: false }, SMALL), "sonnet/medium", "a non-mechanical score 2 is the medium rule's row, not Haiku's");
  assert.equal(composeRoute({ ...CLEAN, mechanical: null }, SMALL), "sonnet/medium", "mechanical not given is not a yes");
  assert.equal(composeRoute({ ...CLEAN, debugging: true }, SMALL), "sonnet/high", "debugging an unknown failure holds every rung");
});

test("composeRoute: mechanical with the score NOT GIVEN is Haiku/high only when the Region names at most 3 files; a non-mechanical row with no score never lowers", () => {
  const unscored = { ...CLEAN, score: null };
  assert.equal(composeRoute(unscored, { regionFiles: 3 }), "haiku/high");
  assert.equal(composeRoute(unscored, { regionFiles: 1 }), "haiku/high");
  assert.equal(composeRoute(unscored, MANY), "sonnet/high", "a fourth file (or a directory, which counts as four) is not a small Region");
  assert.equal(composeRoute(unscored, { regionFiles: 0 }), "sonnet/high", "a Region that names nothing is not small, it is unread");
  for (const answers of [{ ...unscored, mechanical: false }, { ...unscored, mechanical: null }]) {
    assert.equal(composeRoute(answers, SMALL), "sonnet/high", JSON.stringify(answers));
  }
});

test("composeRoute: a score of at most 3 with subsystems NOT answered yes is Sonnet/medium; yes, a higher score and no score are Sonnet/high", () => {
  const medium: Answers = { mechanical: false, subsystems: false, debugging: false, score: 3 };
  assert.equal(composeRoute(medium, SMALL), "sonnet/medium");
  assert.equal(composeRoute({ ...medium, subsystems: null }, SMALL), "sonnet/medium", "subsystems not given passes: `!= yes`");
  assert.equal(composeRoute({ ...medium, debugging: null }, SMALL), "sonnet/medium", "only a debugging YES holds a row");
  assert.equal(composeRoute({ ...medium, score: 1 }, MANY), "sonnet/medium", "the Region's size is Haiku's concern, not the medium rule's");
  for (const flipped of [{ subsystems: true }, { debugging: true }, { score: 4 }, { score: 5 }, { score: null }]) {
    assert.equal(composeRoute({ ...medium, ...flipped }, SMALL), "sonnet/high", JSON.stringify(flipped));
  }
});

// --- the state ---

test("routeState: title, Region entries, Acceptance text and Done-when items -- never the body -- and under the byte limit", () => {
  const row = rowOf({ body: bodyOf({ extra: `${SECRET_BODY_TEXT}\n\n`, region: ["agent-org:src/a.ts", "- `src/b.ts`"], doneWhen: ["1. First.", "- Second."] }) });
  const state = routeState(row);
  assert.deepEqual(Object.keys(state).sort(), ["acceptance", "doneWhen", "region", "title"]);
  assert.deepEqual(state.region, ["agent-org:src/a.ts", "src/b.ts"]);
  assert.deepEqual(state.doneWhen, ["First.", "Second."]);
  assert.equal(state.acceptance, "pnpm test");
  assert.ok(!JSON.stringify(state).includes(SECRET_BODY_TEXT));
  const huge = routeState(rowOf({ title: "t".repeat(5000), body: bodyOf({ region: Array.from({ length: 50 }, (_, i) => `src/${"x".repeat(400)}${i}.ts`), acceptance: "pnpm test ".repeat(500), doneWhen: Array.from({ length: 40 }, () => "d".repeat(900)) }) }));
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= MAX_STATE_BYTES, "a worst-case row is trimmed to what decide will send");
});

// --- the fallback: no provider ---

test("fallbackRoute: at most 3 files and a command Acceptance is Sonnet/medium; a fourth file, a directory, or no command is Sonnet/high; never Haiku", () => {
  assert.equal(fallbackRoute(rowOf({ body: bodyOf({ region: ["a.ts", "b.ts", "c.ts"] }) })), "sonnet/medium");
  assert.equal(fallbackRoute(rowOf({ body: bodyOf({ region: ["a.ts", "b.ts", "c.ts", "d.ts"] }) })), "sonnet/high");
  assert.equal(fallbackRoute(rowOf({ body: bodyOf({ region: ["src/"] }) })), "sonnet/high", "a directory names every file under it");
  assert.equal(fallbackRoute(rowOf({ body: bodyOf({ acceptance: null }) })), "sonnet/high");
  assert.equal(fallbackRoute(rowOf({ body: "no sections at all" })), "sonnet/high", "an unreadable row is the ordinary profile, not medium");
  assert.notEqual(fallbackRoute(rowOf({ title: "rename one thing", body: bodyOf({ region: ["a.ts"], doneWhen: ["1. Renamed."] }) })), "haiku/high");
});

test("provider ABSENT: the fallback route, the provider asked zero times, no key read", async () => {
  const r = rig({ switches: ON });
  const small = await routeEngineer(rowOf(), r.deps);
  assert.deepEqual([small.route, small.via, small.profile?.model, small.profile?.effort, small.profile?.autocompactWindow], ["sonnet/medium", "fallback", "sonnet", "medium", AUTOCOMPACT_WINDOW_TOKENS]);
  const big = await routeEngineer(rowOf({ body: bodyOf({ region: ["a", "b", "c", "d"] }) }), r.deps);
  assert.deepEqual([big.route, big.via, big.profile], ["sonnet/high", "fallback", null]);
  assert.equal(r.calls(), 0);
  assert.deepEqual(r.reads, []);
});

test("provider on but KEY MISSING, USE OFF, REFUSING or TIMING OUT: each takes the fallback and none throws", async () => {
  const keyMissing = rig({ triage: JEV, switches: ON });
  keyMissing.deps.readKey = () => { throw new Error("ENOENT"); };
  const off = rig({ triage: JEV });
  const refusing = rig({ triage: JEV, switches: ON, body: { error: "refused" } });
  const failing = rig({ triage: JEV, switches: ON, throws: true });
  for (const [name, r] of Object.entries({ keyMissing, off, refusing, failing })) {
    const routed = await routeEngineer(rowOf(), r.deps);
    assert.deepEqual([routed.route, routed.via], ["sonnet/medium", "fallback"], name);
  }
  assert.equal(off.calls(), 0, "a use that is off asks nobody");
  assert.equal(failing.calls(), 1, "the control: a use that is on DID ask");
});

// --- the provider on (a fake fetch) ---

test("provider ON: clean answers are Haiku/high with the Haiku profile; a non-mechanical score 3 is Sonnet/medium; a subsystem answer on that row is Sonnet/high", async () => {
  const haiku = rig({ triage: JEV, switches: ON });
  const h = await routeEngineer(rowOf(), haiku.deps);
  assert.deepEqual([h.route, h.via, h.profile?.model, h.profile?.effort, h.profile?.autocompactWindow], ["haiku/high", "jev", HAIKU_MODEL_ID, "high", HAIKU_AUTOCOMPACT_WINDOW_TOKENS]);
  const small = { mechanical: "no", subsystems: "no", score: 3 };
  const medium = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(small) }).deps);
  assert.deepEqual([medium.route, medium.via, medium.profile?.effort], ["sonnet/medium", "jev", "medium"]);
  const cross = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...small, subsystems: "yes" }) }).deps);
  assert.deepEqual([cross.route, cross.via, cross.profile], ["sonnet/high", "jev", null]);
  assert.equal(haiku.calls(), 1);
});

test("#4764 DONE-WHEN 1: a mechanical row the provider says the Acceptance does NOT cover (`covered: no`, as it said on 55 of 55 logged decisions) is routed to Haiku/high; the question is no longer asked", async () => {
  const body = reply({});
  const asked = { ...body, answers: { ...body.answers, covered: choice("no") } };
  const r = rig({ triage: JEV, switches: ON, body: asked });
  const routed = await routeEngineer(rowOf(), r.deps);
  assert.deepEqual([routed.route, routed.via, routed.profile?.model], ["haiku/high", "jev", HAIKU_MODEL_ID]);
  assert.ok(!("covered" in (r.sent[0] as { questions: object }).questions), "the question is not put to the provider: its answer composed nothing");
  assert.deepEqual(Object.keys(QUESTIONS), ["mechanical", "subsystems", "debugging", "score"]);
});

test("#4764 DONE-WHEN 1: a small single-subsystem row (two files, a command, subsystems no, score 3) is Sonnet/medium via the provider, and ONE answer short of that is not Haiku", async () => {
  const given = { mechanical: "no", subsystems: "no", score: 3 };
  const medium = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(given) }).deps);
  assert.deepEqual([medium.route, medium.via, medium.profile?.model, medium.profile?.effort], ["sonnet/medium", "jev", "sonnet", "medium"]);
  // The answers the provider was NOT sure of (live: `subsystems` 28 of 49, `score` 31 of 49) are the reason the route was pinned; subsystems not given is not a yes.
  const unsure = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, low: "subsystems" }) }).deps);
  assert.equal(unsure.route, "sonnet/medium", "subsystems under the floor passes `!= yes`");
  assert.match(unsure.reason!, /^answers not given \(subsystems: no at 0\.5, under the floor/);
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, subsystems: "yes" }) }).deps)).route, "sonnet/high", "the control: subsystems yes");
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, low: "score" }) }).deps)).route, "sonnet/high", "the control: no score, not mechanical");
});

test("provider ON with ONE answer under the floor: each question's absence composes what its own rule says, and the same row with a fourth file is the control for score", async () => {
  const expected: Record<keyof Answers, Route> = { mechanical: "sonnet/medium", subsystems: "haiku/high", debugging: "haiku/high", score: "haiku/high" };
  for (const low of Object.keys(QUESTIONS) as (keyof Answers)[]) {
    const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ low }) }).deps);
    assert.equal(routed.route, expected[low], low);
    assert.equal(routed.via, "jev");
  }
  const four = rowOf({ body: bodyOf({ region: ["a.ts", "b.ts", "c.ts", "d.ts"] }) });
  const noScore = await routeEngineer(four, rig({ triage: JEV, switches: ON, body: reply({ low: "score" }) }).deps);
  assert.deepEqual([noScore.route, noScore.profile], ["sonnet/high", null], "mechanical with no score and a Region of four is not small");
});

test("a composed Haiku is still refused by the Haiku switch: switch off gives Sonnet/high and says why; the same row with the switch on gets Haiku", async () => {
  const off = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, haikuSwitch: '{ "enabled": false }' }).deps);
  assert.deepEqual([off.route, off.profile], ["sonnet/high", null]);
  assert.match(off.why, /switch is off/);
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON }).deps)).route, "haiku/high");
});

// --- the wire: what is POSTED, validated against the API's own schema (agent-org#564) ---

/** The 200 the API answered the first valid request with (2026-10-09T23:10Z): a zero-based, fractional score, and a choice under the floor. Recorded, not invented. */
const RECORDED_SCORE = { type: "score", score: 0.04, confidence: 0.97,
  legend: { 0: "one stated edit in one file", 1: "a few independent edits", 2: "a new small unit with a test", 3: "several subsystems", 4: "a design with open questions" },
  probabilities: { 0: 0.98, 1: 0.01, 2: 0.01, 3: 0.0, 4: 0.0 } };
const RECORDED_MECHANICAL = { type: "choice", choice: "yes", confidence: 0.44, probabilities: { yes: 0.72, no: 0.28 } };
const choice = (value: string) => ({ type: "choice", choice: value, confidence: 0.95, probabilities: {} });
const RECORDED_200 = { model: "jev-1.13.0", usage: { input_tokens: 426, output_tokens: 46 },
  answers: { mechanical: RECORDED_MECHANICAL, subsystems: choice("no"), debugging: choice("no"), covered: choice("yes"), score: RECORDED_SCORE } };

test("the routing request validates against the API's shape: the score carries `criteria` as an array of its five levels, each choice an object; the recorded 200 is read, not dropped", async () => {
  const r = rig({ triage: JEV, switches: ON, body: RECORDED_200, validates: true });
  const routed = await routeEngineer(rowOf(), r.deps);
  assert.equal(r.calls(), 1);
  assert.equal(violation(r.sent[0]), null);
  const { questions } = r.sent[0] as { questions: Record<string, { type: string; criteria: unknown }> };
  assert.deepEqual(Object.keys(questions), Object.keys(QUESTIONS));
  assert.ok(Array.isArray(questions.score.criteria) && questions.score.criteria.length === 5, "the score's criteria is an array of five");
  assert.deepEqual(questions.score.criteria, QUESTIONS.score.type === "score" ? QUESTIONS.score.levels : null, "in the order the levels are scored, level 1 first");
  for (const name of ["mechanical", "subsystems", "debugging"]) assert.ok(!Array.isArray(questions[name].criteria), `${name}'s criteria is an object`);
  // The provider answered: a zero-based 0.04 is level 1, and the row is NOT a fallback. The choice at 0.44 is under the 0.9 floor and is the one answer not given.
  assert.equal(routed.via, "jev");
  const line = r.log().find((l) => l.answers !== undefined);
  assert.deepEqual([line.via, line.answers.score.value, line.answers.score.fellBack, line.answers.mechanical.fellBack], ["jev", 1, false, true]);
  assert.match(line.answers.mechanical.reason, /yes at 0\.44, under the floor 0\.9/);
  assert.equal(routed.route, "sonnet/medium", "mechanical not given, score 1 and subsystems no is the medium rule's row (#4764)");
  assert.match(routed.reason!, /^answers not given \(mechanical: yes at 0\.44, under the floor 0\.9\)$/);
});

test("CONTROL: the same request with the score's `criteria` left off is the API's HTTP 422, every question falls back with it, and the log says so", async () => {
  const r = rig({ triage: JEV, switches: ON, body: RECORDED_200, validates: true });
  const noLevels = { ...QUESTIONS, score: { ...QUESTIONS.score, levels: undefined as never } };
  const d = await decide("model-routing", routeState(rowOf()), noLevels, r.deps);
  assert.deepEqual([d.via, d.reason], ["none", "the API answered HTTP 422"]);
  assert.match(violation(r.sent[0])!, /^score\.criteria/);
  assert.deepEqual(Object.values(d.answers).map((a) => a.fellBack), [true, true, true, true], "one invalid question rejects the whole request");
  assert.equal(r.log()[0].answers.mechanical.reason, "the API answered HTTP 422");
});

test("the recorded 200 with every answer over the floor composes a route the way the 1..5 levels say: level 1 and mechanical is Haiku/high", async () => {
  const body = { ...RECORDED_200, answers: { ...RECORDED_200.answers, mechanical: { ...RECORDED_MECHANICAL, confidence: 0.95 } } };
  const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body, validates: true }).deps);
  assert.deepEqual([routed.route, routed.via, routed.reason], ["haiku/high", "jev", undefined]);
});

// --- overrides win ---

test("`tier:haiku` decides before the provider is asked, and the provider's contrary answer does not move it", async () => {
  const r = rig({ triage: JEV, switches: ON, body: reply({ debugging: "yes" }) });
  const labelled = await routeEngineer(rowOf({ labels: ["ready", "tier:haiku"] }), r.deps);
  assert.deepEqual([labelled.route, labelled.via, labelled.profile?.model], ["haiku/high", "override", HAIKU_MODEL_ID]);
  assert.equal(r.calls(), 0);
  assert.equal((await routeEngineer(rowOf(), r.deps)).route, "sonnet/high", "the control: the same row unlabelled is routed by the (contrary) answers");
  assert.equal(r.calls(), 1);
});

test("`tier:haiku` keeps its refusals: lane:ceo, needs:chairman, a workflows Region and no command each give the ordinary profile, and the provider is not asked", async () => {
  const refused: Partial<RouteRow>[] = [
    { labels: ["tier:haiku", "lane:ceo"] }, { labels: ["tier:haiku", "needs:chairman"] },
    { labels: ["tier:haiku"], body: bodyOf({ region: [".github/workflows/ci.yml"] }) }, { labels: ["tier:haiku"], body: bodyOf({ acceptance: null }) },
  ];
  const r = rig({ triage: JEV, switches: ON });
  for (const over of refused) {
    const routed = await routeEngineer(rowOf(over), r.deps);
    assert.deepEqual([routed.route, routed.via, routed.profile], ["sonnet/high", "override", null], JSON.stringify(over));
  }
  assert.equal(r.calls(), 0);
  assert.equal((await routeEngineer(rowOf({ labels: ["tier:haiku"] }), r.deps)).route, "haiku/high", "the control: none of the four is the same row");
});

test("a row nothing may lower is never asked: lane:ceo, needs:chairman, a workflows Region, no command Acceptance, and not even the fallback's Sonnet/medium", async () => {
  const r = rig({ triage: JEV, switches: ON });
  for (const over of [{ labels: ["lane:ceo"] }, { labels: ["needs:chairman"] }, { body: bodyOf({ region: [".github/workflows/ci.yml"] }) }, { body: bodyOf({ acceptance: null }) }]) {
    const routed = await routeEngineer(rowOf(over), r.deps);
    assert.deepEqual([routed.route, routed.via], ["sonnet/high", "refused"], JSON.stringify(over));
  }
  assert.equal(r.calls(), 0);
  assert.equal((await routeEngineer(rowOf(), r.deps)).via, "jev", "the control: the unrefused row IS asked");
});

// --- the log ---

/** The OUTCOME line, as against the REQUEST line (`answers`, and since #4754 `outcome: "asked"`): a request line's `outcome` is the provider having been asked, not a route. */
const isOutcomeLine = (l: { outcome?: string; answers?: unknown }): boolean => l.outcome !== undefined && l.answers === undefined;

test("every route is a decision-log line, in the fallback, override, refused and provider cases, and the outcome lands beside it", async () => {
  const r = rig({ triage: JEV, switches: ON });
  const off = rig();
  await routeEngineer(rowOf({ number: 1 }), r.deps);
  await routeEngineer(rowOf({ number: 2, labels: ["tier:haiku"] }), r.deps);
  await routeEngineer(rowOf({ number: 3, labels: ["lane:ceo"] }), r.deps);
  await routeEngineer(rowOf({ number: 4 }), off.deps);
  const routes = (lines: { id?: string; outcome?: string }[]) => lines.filter(isOutcomeLine).map((l) => [l.id, l.outcome]);
  assert.deepEqual(routes(r.log()), [
    ["row-1", "route haiku/high via jev (the provider answered: mechanical=yes, subsystems=no, debugging=no, score=2) [fallback would be sonnet/medium]"],
    ["row-2", "route haiku/high via override (tier:haiku)"],
    ["row-3", "route sonnet/high via refused (the row carries lane:ceo)"]]);
  assert.deepEqual(routes(off.log()), [["row-4", "route sonnet/medium via fallback (no triage provider is declared)"]]);
  // A route the provider did not decide carries WHY on its outcome line: a refused row says what refused it, a fallback says why the provider did not decide.
  const reasons = (lines: { outcome?: string; reason?: string }[]) => lines.filter(isOutcomeLine).map((l) => l.reason);
  assert.deepEqual(reasons(r.log()), [undefined, undefined, "the row carries lane:ceo"]);
  assert.deepEqual(reasons(off.log()), ["no triage provider is declared"]);
  assert.ok(r.log().some((l) => l.use === "model-routing" && l.answers !== undefined), "the provider's own line (the answers) is there too");
  recordRouteOutcome(1, "merged-first-pass", r.deps);
  assert.deepEqual(routes(r.log()).at(-1), ["row-1", "merged-first-pass"]);
});

// --- the wake wiring ---

test("routesForStarts: resolves the first ROUTE_AHEAD start orders by row, skips an order that is not a start and a row that cannot be read", async () => {
  const orders = [4, 5, 6, 7, 8].map((n) => ({ causeKey: `engineers/ready-row-unclaimed/${n}` }));
  const read: number[] = [];
  const readRow = (row: number) => { read.push(row); if (row === 5) throw new Error("gh down"); return { labels: ["ready"], body: bodyOf(), title: `row ${row}` }; };
  const dir = tmpDir("engineer-route-wake-");
  const routes = await routesForStarts([{ causeKey: "ceo/org-health/x" }, ...orders], { host: withTriage(), ledgerPath: join(dir, "wake-ledger"), readRow, projectDir: dir });
  assert.deepEqual(read, orders.slice(0, ROUTE_AHEAD).map((o) => Number(o.causeKey.split("/")[2])));
  assert.deepEqual([...routes.keys()], [4, 6], "row 5 could not be read, so it is absent and tierOfRow does what it did");
  assert.equal(routes.get(4)?.route, "sonnet/medium");
});

test("spawnClaimer.tier: a routed row gets its route's profile; a row with no route takes the label-only path it always did", () => {
  const dir = tmpDir("engineer-route-claimer-");
  const switchPath = join(dir, "on.json");
  writeFileSync(switchPath, '{ "enabled": true }');
  const claimed = (row: number) => ({ row, branch: "b", worktree: "w", launchDir: "l" });
  const medium = { route: "sonnet/medium", via: "fallback", why: "x", profile: { kind: "claude", model: "sonnet", effort: "medium", why: "x", autocompactWindow: AUTOCOMPACT_WINDOW_TOKENS } } as const;
  const claimer = spawnClaimer({ routes: new Map([[10, medium]]), switchPath, readRow: () => ({ labels: ["ready", "tier:haiku"], body: bodyOf() }) });
  assert.equal(claimer.tier?.(claimed(10))?.effort, "medium");
  assert.equal(claimer.tier?.(claimed(11))?.model, HAIKU_MODEL_ID, "the control: with no route the label still decides");
  assert.equal(spawnClaimer({ routes: new Map(), switchPath, readRow: () => ({ labels: ["ready"], body: bodyOf() }) }).tier?.(claimed(12)), null);
});

// --- every fallback says why, on a line of the decision log ---

/** The outcome line `routeEngineer` appended for the row, as a person reads it. */
const outcomeOf = (r: ReturnType<typeof rig>): string => r.log().filter(isOutcomeLine).at(-1).outcome;

test("the outcome line reads `route <route> via <via> (<why>)`, and what <why> says is the reason for each via: jev, fallback, refused, override", async () => {
  // jev, every answer given: the answers that composed the route.
  const given = rig({ triage: JEV, switches: ON });
  assert.equal((await routeEngineer(rowOf(), given.deps)).via, "jev");
  assert.equal(outcomeOf(given), "route haiku/high via jev (the provider answered: mechanical=yes, subsystems=no, debugging=no, score=2) [fallback would be sonnet/medium]");
  // jev, one answer not given: the line names it and why, and the route is what the rest compose (Sonnet/medium: not mechanical, score 2, subsystems no).
  const held = rig({ triage: JEV, switches: ON, body: reply({ low: "mechanical" }) });
  assert.equal((await routeEngineer(rowOf(), held.deps)).route, "sonnet/medium");
  assert.match(outcomeOf(held), /^route sonnet\/medium via jev \(the provider answered: mechanical=not given \(yes at [0-9.]+, under the floor 0\.9\), subsystems=no, .*\) \[fallback would be sonnet\/medium\]$/);
  // fallback: the provider's failure, never the fallback rule's own "a small row".
  const failed = rig({ triage: JEV, switches: ON });
  failed.deps.fetch = (async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch;
  const fell = await routeEngineer(rowOf(), failed.deps);
  assert.deepEqual([fell.route, fell.via], ["sonnet/medium", "fallback"]);
  assert.equal(outcomeOf(failed), "route sonnet/medium via fallback (the API answered HTTP 422)");
  // refused: what refused it.
  const refused = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ body: bodyOf({ acceptance: null }) }), refused.deps);
  assert.equal(outcomeOf(refused), "route sonnet/high via refused (it has no Acceptance command)");
  // override: the label, and the refusal when Haiku was refused.
  const label = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ labels: ["tier:haiku"] }), label.deps);
  assert.equal(outcomeOf(label), "route haiku/high via override (tier:haiku)");
  const barred = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ labels: ["tier:haiku", "lane:ceo"] }), barred.deps);
  assert.match(outcomeOf(barred), /^route sonnet\/high via override \(tier:haiku was refused: .*lane:ceo/);
});

test("a route the provider did not decide: the work tick's journal line prints the same text the outcome line does", async () => {
  const r = rig({ triage: JEV });
  const routed = await routeEngineer(rowOf({ number: 10 }), r.deps);
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    spawnClaimer({ routes: new Map([[10, routed]]), switchPath: undefined, readRow: () => ({ labels: ["ready"], body: bodyOf() }) }).tier?.({ row: 10, branch: "b", worktree: "w", launchDir: "l" });
  } finally { process.stderr.write = write; }
  assert.deepEqual(written, [`wake: #10 routed sonnet/medium via fallback (the use is switched off).\n`]);
  assert.equal(outcomeOf(r), "route sonnet/medium via fallback (the use is switched off)");
});


test("every way the provider does not decide a route puts its reason on the outcome line and in the journal's `why`: switch off, no provider, HTTP 422, a timeout, a state too large, a malformed answer", async () => {
  const withFetch = (r: ReturnType<typeof rig>, fn: unknown) => { r.deps.fetch = fn as typeof fetch; return r; };
  // `routeState` clips every field, so only a multi-byte state reaches the cap: three bytes a character fills it.
  const wide = rowOf({ title: "€".repeat(200), body: bodyOf({ region: Array.from({ length: 12 }, () => "€".repeat(120)), acceptance: "€".repeat(600), doneWhen: Array.from({ length: 8 }, () => "€".repeat(200)) }) });
  const cases: [string, ReturnType<typeof rig>, RouteRow, string][] = [
    ["switch off", rig({ triage: JEV }), rowOf(), "the use is switched off"],
    ["no provider", rig({ switches: ON }), rowOf(), "no triage provider is declared"],
    ["HTTP 422", withFetch(rig({ triage: JEV, switches: ON }), async () => ({ ok: false, status: 422, json: async () => ({}) })), rowOf(), "the API answered HTTP 422"],
    ["a timeout", withFetch(rig({ triage: JEV, switches: ON }), () => new Promise(() => {})), rowOf(), "the API timed out"],
    ["a state too large", rig({ triage: JEV, switches: ON }), wide, "the state is too large to send"],
    ["a malformed answer", rig({ triage: JEV, switches: ON, body: { answers: {} } }), rowOf(), "the API's answer was not a choice with a confidence"],
  ];
  for (const [label, r, row, reason] of cases) {
    const routed = await routeEngineer(row, r.deps);
    const outcome = r.log().filter(isOutcomeLine).at(-1);
    assert.equal(routed.via, "fallback", label);
    assert.equal(routed.reason, reason, label);
    assert.equal(outcome.reason, reason, `${label}: the outcome line carries it`);
    assert.equal(routed.why, reason, `${label}: the journal's why is the same text`);
    assert.equal(outcome.outcome, `route ${routed.route} via fallback (${reason})`, `${label}: and so is the outcome line a person reads`);
    assert.doesNotMatch(outcome.outcome, /a small row/, `${label}: the reason is the failure's, not the fallback rule's gloss`);
  }
  assert.equal(cases[4][1].calls(), 0, "the state over the cap was never sent: the outcome line is the only line that can say why");
});

// --- #4764: the guard against paying more than the fallback ---

/** One outcome line as `routeEngineer` writes it for a provider route: `route <provider> via jev (...) [fallback would be <fallback>]`. */
const outcomeLine = (n: number, provider: Route, fallback: Route | null, at = n) =>
  ({ use: "model-routing", id: `row-${n}`, outcome: `route ${provider} via jev (the provider answered: x)${fallback === null ? "" : ` [fallback would be ${fallback}]`}`, at });
const run = (n: number, provider: Route, fallback: Route | null) => Array.from({ length: n }, (_, i) => outcomeLine(i, provider, fallback));

test("routeCostReading: the provider's last 20 routes against the fallback's -- costlier only when the MEAN is strictly above, and never before 20 comparisons", () => {
  assert.equal(GUARD_DECISIONS, 20);
  const dear = routeCostReading(run(20, "sonnet/high", "sonnet/medium"));
  assert.deepEqual(dear, { kind: "read", compared: 20, providerMean: 3, fallbackMean: 2, costlier: true });
  assert.equal((routeCostReading(run(20, "sonnet/medium", "sonnet/medium")) as { costlier: boolean }).costlier, false, "equal is not costlier");
  assert.equal((routeCostReading(run(20, "haiku/high", "sonnet/medium")) as { costlier: boolean }).costlier, false, "cheaper is not costlier");
  assert.deepEqual(routeCostReading(run(19, "sonnet/high", "sonnet/medium")), { kind: "too-few", compared: 19 }, "the control: one short of 20 says nothing");
  // Dearer on ten rows and cheaper on ten is a provider working, not a regression: the means are equal.
  const mixed = [...run(10, "sonnet/high", "sonnet/medium"), ...run(10, "haiku/high", "sonnet/medium")].map((l, i) => ({ ...l, id: `row-${i}` }));
  assert.equal((routeCostReading(mixed) as { costlier: boolean }).costlier, false);
});

test("routeCostReading: only the LAST 20 comparisons count, and a line with no fallback named, another use or another via is not a comparison", () => {
  // Thirty dear routes, then twenty even ones: the regression is fixed and the reading says so.
  const recovered = [...run(30, "sonnet/high", "sonnet/medium"), ...run(20, "sonnet/medium", "sonnet/medium").map((l, i) => ({ ...l, id: `row-${100 + i}`, at: 100 + i }))];
  assert.equal((routeCostReading(recovered) as { costlier: boolean }).costlier, false);
  assert.equal((routeCostReading([...recovered.slice(0, 30)]) as { costlier: boolean }).costlier, true, "the control: only the dear ones");
  // Nothing before #4764 carried the comparison, so a log of 20 of them is no reading, never a regression.
  assert.deepEqual(routeCostReading(run(20, "sonnet/high", null)), { kind: "too-few", compared: 0 });
  const foreign = run(20, "sonnet/high", "sonnet/medium").map((l) => ({ ...l, use: "wake-triage" }));
  assert.deepEqual(routeCostReading(foreign), { kind: "too-few", compared: 0 });
  const fallbackVia = run(20, "sonnet/high", "sonnet/medium").map((l) => ({ ...l, outcome: l.outcome.replace("via jev", "via fallback") }));
  assert.deepEqual(routeCostReading(fallbackVia), { kind: "too-few", compared: 0 }, "a fallback route is the fallback: nothing to compare");
  assert.deepEqual(routeCostReading(["not json", null, 7]), { kind: "too-few", compared: 0 });
});

test("routeCostEvents: one ledger event per UTC day when costlier, none otherwise", () => {
  const dear = routeCostReading(run(20, "sonnet/high", "sonnet/medium"));
  const at = Date.parse("2026-10-10T09:00:00Z");
  assert.deepEqual(routeCostEvents(dear, at), [{ classKey: ROUTE_COSTLIER_THAN_FALLBACK, ref: "model-routing-vs-fallback@2026-10-10" }]);
  assert.deepEqual(routeCostEvents(dear, at + 60_000), routeCostEvents(dear, at), "the same day is the same ref, which `recordFailures` skips");
  assert.notDeepEqual(routeCostEvents(dear, at + 24 * 3_600_000), routeCostEvents(dear, at));
  assert.deepEqual(routeCostEvents(routeCostReading(run(20, "sonnet/medium", "sonnet/medium")), at), []);
  assert.deepEqual(routeCostEvents(routeCostReading(run(3, "sonnet/high", "sonnet/medium")), at), []);
});

test("#4764 DONE-WHEN 1: the guard FIRES on a fixture -- twenty provider routes at Sonnet/high where the fallback would have said Sonnet/medium raise one ledger incident, and the nineteenth does not", async () => {
  const dear = rig({ triage: JEV, switches: ON, body: reply({ debugging: "yes" }) });
  const ledger = join(dirname(dear.logPath), "failure-ledger");
  for (let n = 1; n <= GUARD_DECISIONS - 1; n++) await routeEngineer(rowOf({ number: n }), dear.deps);
  assert.equal(existsSync(ledger), false, "nineteen routes: too few to say anything");
  const twentieth = await routeEngineer(rowOf({ number: 20 }), dear.deps);
  assert.deepEqual([twentieth.route, twentieth.via], ["sonnet/high", "jev"]);
  assert.deepEqual(readFileSync(ledger, "utf8").trim().split("\n").map((l) => l.split("\t").filter((_, i) => i !== 1)), [[ROUTE_COSTLIER_THAN_FALLBACK, "model-routing-vs-fallback@1970-01-01"]]);
  await routeEngineer(rowOf({ number: 21 }), dear.deps);
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1, "a standing regression is one line a day, not one per route");
  // The log beside each provider route names the fallback's would-be route; the same fallback's own line does not (it IS the route).
  const outcomes = dear.log().filter(isOutcomeLine).map((l) => l.outcome as string);
  assert.ok(outcomes.length === 21 && outcomes.every((o) => o.endsWith("[fallback would be sonnet/medium]")), outcomes[0]);
});

test("the guard's control: twenty provider routes that cost what the fallback would have, or less, raise nothing -- and an unreadable log is reported, never thrown", async () => {
  const even = rig({ triage: JEV, switches: ON, body: reply({ mechanical: "no", subsystems: "no", score: 3 }) });
  const cheap = rig({ triage: JEV, switches: ON });
  for (let n = 1; n <= GUARD_DECISIONS + 1; n++) {
    assert.equal((await routeEngineer(rowOf({ number: n }), even.deps)).route, "sonnet/medium");
    await routeEngineer(rowOf({ number: n }), cheap.deps);
  }
  assert.equal(existsSync(join(dirname(even.logPath), "failure-ledger")), false);
  assert.equal(existsSync(join(dirname(cheap.logPath), "failure-ledger")), false);
  // A log that cannot be read says so on the diagnostic and the route still comes back.
  const said: string[] = [];
  const broken = rig({ triage: JEV, switches: ON });
  // `read` is also what the switches file is read through, so only the LOG's path fails.
  broken.deps.read = ((path: string, encoding: BufferEncoding) => { if (path === broken.logPath) throw new Error("EIO"); return readFileSync(path, encoding); }) as never;
  broken.deps.diagnostic = (line: string) => { said.push(line); };
  const routed = await routeEngineer(rowOf(), broken.deps);
  assert.equal(routed.via, "jev");
  assert.ok(said.some((l) => /route-cost guard could not read the decision log \(EIO\)/.test(l)), said.join("|"));
});

// --- #4764 change 3: the criteria carry summaries, signals and examples from rows whose outcome is known ---

const ROW_REF = /^(a11ign|agent-org)#\d+$/;

test("every score level carries a summary, signals and examples, and every example names a row of ours with what merged; the five stay in order and the wire shape is unchanged", () => {
  assert.equal(SCORE_LEVEL_DATA.length, 5);
  const levels = QUESTIONS.score.type === "score" ? QUESTIONS.score.levels : [];
  assert.equal(levels.length, 5);
  SCORE_LEVEL_DATA.forEach((level, i) => {
    assert.ok(level.summary !== "" && level.signals.length >= 2 && level.examples.length >= 2, `level ${i + 1} has a summary, signals and examples`);
    assert.ok(levels[i].startsWith(level.summary), `level ${i + 1} is where its position says`);
    assert.ok(levels[i].includes("Signals: ") && level.signals.every((s) => levels[i].includes(s)), `level ${i + 1} sends its signals`);
    for (const example of level.examples) {
      assert.match(example.row, ROW_REF);
      assert.ok(example.what !== "" && /\d/.test(example.merged), `${example.row} says what it changed and how big the merged diff was`);
      assert.ok(levels[i].includes(example.row), `${example.row} is sent`);
    }
  });
  assert.ok(levels.every((l) => typeof l === "string" && l !== ""), "an array of five non-empty strings: what the API's score accepts");
});

test("the subsystems options are `what`, `not for` and examples, keyed yes and no as before, and no row is the example of both answers", () => {
  const q = QUESTIONS.subsystems;
  assert.equal(q.type, "choice");
  const criteria = q.type === "choice" ? q.criteria : {};
  assert.deepEqual(Object.keys(criteria), ["yes", "no"], "the answer words are what `decide` checks a choice against");
  for (const name of ["yes", "no"] as const) {
    const option = SUBSYSTEMS_DATA[name];
    assert.ok(criteria[name].startsWith(option.what) && criteria[name].includes("Not for: ") && option.examples.length >= 2, name);
    for (const example of option.examples) assert.match(example.row, ROW_REF);
  }
  const yes = SUBSYSTEMS_DATA.yes.examples.map((e) => e.row);
  assert.deepEqual(SUBSYSTEMS_DATA.no.examples.map((e) => e.row).filter((row) => yes.includes(row)), [], "a row is not a yes and a no");
  // The control: a rendered option that dropped its examples would read as a bare gloss again.
  assert.ok(Object.values(criteria).every((text) => /Examples, from rows whose outcome is known: /.test(text)));
});

test("the criteria are sent and the request still validates: the same score array of five and choice objects the API's schema asks for", async () => {
  const r = rig({ triage: JEV, switches: ON, validates: true });
  await routeEngineer(rowOf(), r.deps);
  assert.equal(r.calls(), 1);
  assert.equal(violation(r.sent[0]), null);
  const { questions } = r.sent[0] as { questions: Record<string, { criteria: unknown }> };
  assert.match(JSON.stringify(questions.score.criteria), /Signals: .*a11ign#4748/);
  assert.match(JSON.stringify(questions.subsystems.criteria), /Not for: .*a11ign#4629/);
});
