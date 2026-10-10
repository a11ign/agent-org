// #4629: the engineer route. A fake `fetch`, a fake key, a fixture row and a temp directory only: no network, no real key, no corpus.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the route beside the row one answer away from it, and the provider-on case beside the four ways the provider is not asked.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, decisionLogPathFrom, decisionSwitchesPath, MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import { composeRoute, fallbackRoute, fallbackWindow, isWindowTooSmall, LARGE_ROW_FILES, LARGEST_ROW_FILES, recordRouteOutcome, recordWindowTooSmall, regionSize, routeEngineer, routeState, SMALL_ROW_FILES, windowOf,
  windowReadings, windowReportLines, QUESTIONS, type Answers, type RouteRow } from "./engineer-route.ts";
import { parseHostConfig } from "./host-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { freshState } from "./triage-provider.ts";
import { ROUTE_AHEAD, routesForStarts, spawnClaimer } from "./wake.ts";
import { AUTOCOMPACT_WINDOW_TOKENS, HAIKU_AUTOCOMPACT_WINDOW_TOKENS, HAIKU_MODEL_ID, LARGE_WINDOW_TOKENS, LARGEST_WINDOW_TOKENS } from "./worker-profile.ts";

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
const CLEAN_HAIKU = { mechanical: "yes", subsystems: "no", debugging: "no", covered: "yes", score: 2 };
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

// --- composeRoute: pure ---

const CLEAN: Answers = { mechanical: true, subsystems: false, debugging: false, covered: true, score: 2 };

test("composeRoute: mechanical, covered, score 2, no subsystems, no debugging is Haiku/high -- and each answer one step away is Sonnet/high", () => {
  assert.equal(composeRoute(CLEAN), "haiku/high");
  assert.equal(composeRoute({ ...CLEAN, score: 1 }), "haiku/high");
  for (const flipped of [{ mechanical: false }, { subsystems: true }, { debugging: true }, { covered: false }, { score: 4 }, { score: 5 }]) {
    assert.equal(composeRoute({ ...CLEAN, ...flipped }), "sonnet/high", JSON.stringify(flipped));
  }
});

test("composeRoute: score 3 with none of the others is Sonnet/medium, and each of the others sends it to Sonnet/high", () => {
  const medium: Answers = { ...CLEAN, score: 3 };
  assert.equal(composeRoute(medium), "sonnet/medium");
  assert.equal(composeRoute({ ...medium, mechanical: false }), "sonnet/medium", "mechanical is not asked of a medium row");
  for (const flipped of [{ subsystems: true }, { debugging: true }, { covered: false }, { score: 4 }]) {
    assert.equal(composeRoute({ ...medium, ...flipped }), "sonnet/high", JSON.stringify(flipped));
  }
  assert.equal(composeRoute({ ...CLEAN, mechanical: false }), "sonnet/high", "a non-mechanical score 2 is neither rule's row");
});

test("composeRoute: a missing (low-confidence) answer is Sonnet/high whatever the others say", () => {
  for (const name of Object.keys(CLEAN) as (keyof Answers)[]) {
    assert.equal(composeRoute({ ...CLEAN, [name]: null }), "sonnet/high", name);
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

test("provider ON: clean answers are Haiku/high with the Haiku profile; score 3 is Sonnet/medium; a subsystem answer is Sonnet/high", async () => {
  const haiku = rig({ triage: JEV, switches: ON });
  const h = await routeEngineer(rowOf(), haiku.deps);
  assert.deepEqual([h.route, h.via, h.profile?.model, h.profile?.effort, h.profile?.autocompactWindow], ["haiku/high", "jev", HAIKU_MODEL_ID, "high", HAIKU_AUTOCOMPACT_WINDOW_TOKENS]);
  const medium = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ score: 3 }) }).deps);
  assert.deepEqual([medium.route, medium.via, medium.profile?.effort], ["sonnet/medium", "jev", "medium"]);
  const cross = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ subsystems: "yes" }) }).deps);
  assert.deepEqual([cross.route, cross.via, cross.profile], ["sonnet/high", "jev", null]);
  assert.equal(haiku.calls(), 1);
});

test("provider ON with ONE answer under the floor: Sonnet/high, though the other four would have composed Haiku (the negative control is the line above)", async () => {
  for (const low of Object.keys(QUESTIONS) as (keyof Answers)[]) {
    const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ low }) }).deps);
    assert.deepEqual([routed.route, routed.profile], ["sonnet/high", null], low);
  }
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
  for (const name of ["mechanical", "subsystems", "debugging", "covered"]) assert.ok(!Array.isArray(questions[name].criteria), `${name}'s criteria is an object`);
  // The provider answered: a zero-based 0.04 is level 1, and the row is NOT a fallback. The choice at 0.44 is under the 0.9 floor and is the one answer not given.
  assert.equal(routed.via, "jev");
  const line = r.log().find((l) => l.answers !== undefined);
  assert.deepEqual([line.via, line.answers.score.value, line.answers.score.fellBack, line.answers.mechanical.fellBack], ["jev", 1, false, true]);
  assert.match(line.answers.mechanical.reason, /yes at 0\.44, under the floor 0\.9/);
  assert.equal(routed.route, "sonnet/high", "an answer not given composes Sonnet/high");
  assert.match(routed.reason!, /^answers not given \(mechanical: yes at 0\.44, under the floor 0\.9\)$/);
});

test("CONTROL: the same request with the score's `criteria` left off is the API's HTTP 422, every question falls back with it, and the log says so", async () => {
  const r = rig({ triage: JEV, switches: ON, body: RECORDED_200, validates: true });
  const noLevels = { ...QUESTIONS, score: { ...QUESTIONS.score, levels: undefined as never } };
  const d = await decide("model-routing", routeState(rowOf()), noLevels, r.deps);
  assert.deepEqual([d.via, d.reason], ["none", "the API answered HTTP 422"]);
  assert.match(violation(r.sent[0])!, /^score\.criteria/);
  assert.deepEqual(Object.values(d.answers).map((a) => a.fellBack), [true, true, true, true, true], "one invalid question rejects the whole request");
  assert.equal(r.log()[0].answers.mechanical.reason, "the API answered HTTP 422");
});

test("the recorded 200 with every answer over the floor composes a route the way the 1..5 levels say: level 1 mechanical and covered is Haiku/high", async () => {
  const body = { ...RECORDED_200, answers: { ...RECORDED_200.answers, mechanical: { ...RECORDED_MECHANICAL, confidence: 0.95 } } };
  const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body, validates: true }).deps);
  assert.deepEqual([routed.route, routed.via, routed.reason], ["haiku/high", "jev", undefined]);
});

// --- overrides win ---

test("`tier:haiku` decides before the provider is asked, and the provider's contrary answer does not move it", async () => {
  const r = rig({ triage: JEV, switches: ON, body: reply({ subsystems: "yes" }) });
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
    ["row-1", "route haiku/high window 130k via jev (the provider answered: mechanical=yes, subsystems=no, debugging=no, covered=yes, score=2)"],
    ["row-2", "route haiku/high window 130k via override (tier:haiku)"],
    ["row-3", "route sonnet/high window 200k via refused (the row carries lane:ceo)"]]);
  assert.deepEqual(routes(off.log()), [["row-4", "route sonnet/medium window 200k via fallback (no triage provider is declared)"]]);
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
  assert.equal(outcomeOf(given), "route haiku/high window 130k via jev (the provider answered: mechanical=yes, subsystems=no, debugging=no, covered=yes, score=2)");
  // jev, one answer not given: the line names it and why, and the route is Sonnet/high.
  const held = rig({ triage: JEV, switches: ON, body: reply({ low: "mechanical" }) });
  assert.equal((await routeEngineer(rowOf(), held.deps)).route, "sonnet/high");
  assert.match(outcomeOf(held), /^route sonnet\/high window 200k via jev \(the provider answered: mechanical=not given \(yes at [0-9.]+, under the floor 0\.9\), subsystems=no, /);
  // fallback: the provider's failure, never the fallback rule's own "a small row".
  const failed = rig({ triage: JEV, switches: ON });
  failed.deps.fetch = (async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch;
  const fell = await routeEngineer(rowOf(), failed.deps);
  assert.deepEqual([fell.route, fell.via], ["sonnet/medium", "fallback"]);
  assert.equal(outcomeOf(failed), "route sonnet/medium window 200k via fallback (the API answered HTTP 422)");
  // refused: what refused it.
  const refused = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ body: bodyOf({ acceptance: null }) }), refused.deps);
  assert.equal(outcomeOf(refused), "route sonnet/high window 200k via refused (it has no Acceptance command)");
  // override: the label, and the refusal when Haiku was refused.
  const label = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ labels: ["tier:haiku"] }), label.deps);
  assert.equal(outcomeOf(label), "route haiku/high window 130k via override (tier:haiku)");
  const barred = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf({ labels: ["tier:haiku", "lane:ceo"] }), barred.deps);
  assert.match(outcomeOf(barred), /^route sonnet\/high window 200k via override \(tier:haiku was refused: .*lane:ceo/);
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
  assert.equal(outcomeOf(r), "route sonnet/medium window 200k via fallback (the use is switched off)");
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
    assert.equal(outcome.outcome, `route ${routed.route} window ${label === "a state too large" ? "400k (the Region names files=12 repositories=1)" : "200k"} via fallback (${reason})`, `${label}: and so is the outcome line a person reads`);
    assert.doesNotMatch(outcome.outcome, /a small row/, `${label}: the reason is the failure's, not the fallback rule's gloss`);
  }
  assert.equal(cases[4][1].calls(), 0, "the state over the cap was never sent: the outcome line is the only line that can say why");
});

// --- #4738: the window the route sets ---

const WINDOW_ON = JSON.stringify({ "model-routing": true, "model-routing-window": true });
const files = (n: number, repo = ""): string[] => Array.from({ length: n }, (_, i) => `${repo}src/f${i}.ts`);
const sizedBy = (region: string[]) => fallbackWindow(bodyOf({ region })).tokens;

test("fallbackWindow, one case per cut-off: files under LARGE_ROW_FILES keep 200k, LARGE_ROW_FILES takes 400k, LARGEST_ROW_FILES takes 600k", () => {
  assert.equal(sizedBy(files(LARGE_ROW_FILES - 1)), AUTOCOMPACT_WINDOW_TOKENS);
  assert.equal(sizedBy(files(LARGE_ROW_FILES)), LARGE_WINDOW_TOKENS);
  assert.equal(sizedBy(files(LARGEST_ROW_FILES - 1)), LARGE_WINDOW_TOKENS);
  assert.equal(sizedBy(files(LARGEST_ROW_FILES)), LARGEST_WINDOW_TOKENS);
  assert.equal(sizedBy(["src/"]), AUTOCOMPACT_WINDOW_TOKENS, "one directory counts as four files, under the cut-off");
  assert.equal(sizedBy(["src/", "lib/"]), LARGE_WINDOW_TOKENS, "two directories count as eight");
});

test("fallbackWindow, one case per repository cut-off: one repository keeps its size, two take 400k, three take 600k, and a bare path is the first repository", () => {
  assert.equal(sizedBy(["agent-org:src/a.ts", "agent-org:src/b.ts"]), AUTOCOMPACT_WINDOW_TOKENS);
  assert.equal(sizedBy(["src/a.ts", "agent-org:src/b.ts"]), LARGE_WINDOW_TOKENS);
  assert.equal(sizedBy(["src/a.ts", "agent-org:src/b.ts", "nvda-worker:src/c.ts"]), LARGEST_WINDOW_TOKENS);
  assert.equal(regionSize(bodyOf({ region: ["src/a.ts", "agent-org:src/b.ts"] })).repositories, 2);
});

test("provider ABSENT: a large Region still gets its window, the route's profile carries it, and the outcome line says how it was sized", async () => {
  const r = rig();
  const routed = await routeEngineer(rowOf({ body: bodyOf({ region: files(LARGE_ROW_FILES) }) }), r.deps);
  assert.deepEqual([routed.route, windowOf(routed), routed.profile?.autocompactWindow, routed.profile?.model], ["sonnet/high", LARGE_WINDOW_TOKENS, LARGE_WINDOW_TOKENS, "sonnet"]);
  assert.equal(outcomeOf(r), `route sonnet/high window 400k (the Region names files=${LARGE_ROW_FILES} repositories=1) via fallback (no triage provider is declared)`);
  const medium = await routeEngineer(rowOf({ body: bodyOf({ region: files(SMALL_ROW_FILES) }) }), rig().deps);
  assert.deepEqual([medium.route, windowOf(medium)], ["sonnet/medium", AUTOCOMPACT_WINDOW_TOKENS], "the control: a small row keeps today's window");
  const ordinaryRow = await routeEngineer(rowOf({ body: bodyOf({ region: files(SMALL_ROW_FILES + 1) }) }), rig().deps);
  assert.deepEqual([ordinaryRow.route, ordinaryRow.profile], ["sonnet/high", null], "and a sonnet/high row at the ordinary window is still no profile at all");
});

test("a provider answer moves the window ONLY at or over the floor, and only with its own switch on", async () => {
  const body = bodyOf({ region: files(LARGE_ROW_FILES) });
  const withSwitch = async (switches: string, given: Given) => routeEngineer(rowOf({ body }), rig({ triage: JEV, switches, body: reply({ mechanical: "no", ...given }) }).deps);
  const up = await withSwitch(WINDOW_ON, { subsystems: "yes" });
  assert.equal(windowOf(up), LARGEST_WINDOW_TOKENS, "subsystems answered yes at 0.95 raises 400k one rung");
  assert.match(up.windowWhy ?? "", /raised it from 400k/);
  // The negative control: the same answer, under the floor, is a fallback value of `yes` that must NOT count.
  const low = await withSwitch(WINDOW_ON, { subsystems: "yes", low: "subsystems" });
  assert.equal(windowOf(low), LARGE_WINDOW_TOKENS);
  assert.match(low.windowWhy ?? "", /kept it at 400k \(not given, so left out: subsystems: .*under the floor/);
  // The same answer with the window's switch off: the routing is asked, the window is the Region's.
  assert.equal(windowOf(await withSwitch(ON, { subsystems: "yes" })), LARGE_WINDOW_TOKENS);
  // Down needs BOTH answers: a small score alone does not, the two together do, and never below the ordinary window.
  assert.equal(windowOf(await withSwitch(WINDOW_ON, { subsystems: "no", score: 3 })), LARGE_WINDOW_TOKENS);
  assert.equal(windowOf(await withSwitch(WINDOW_ON, { subsystems: "no", score: 2 })), AUTOCOMPACT_WINDOW_TOKENS);
  const small = await routeEngineer(rowOf(), rig({ triage: JEV, switches: WINDOW_ON, body: reply({ mechanical: "no", subsystems: "no", score: 1 }) }).deps);
  assert.equal(windowOf(small), AUTOCOMPACT_WINDOW_TOKENS, "a small row is never taken below today's window");
  // A failed provider leaves the Region's window and says it is the provider's failure.
  const failed = rig({ triage: JEV, switches: WINDOW_ON });
  failed.deps.fetch = (async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch;
  const fell = await routeEngineer(rowOf({ body }), failed.deps);
  assert.deepEqual([fell.via, windowOf(fell), fell.reason], ["fallback", LARGE_WINDOW_TOKENS, "the API answered HTTP 422"]);
});

test("a Haiku route is clamped to its ceiling whatever the Region's size or the provider says", async () => {
  const wide = bodyOf({ region: files(LARGEST_ROW_FILES) });
  const label = await routeEngineer(rowOf({ labels: ["tier:haiku"], body: wide }), rig({ triage: JEV, switches: WINDOW_ON }).deps);
  assert.deepEqual([label.route, windowOf(label)], ["haiku/high", HAIKU_AUTOCOMPACT_WINDOW_TOKENS]);
  assert.match(label.windowWhy ?? "", /held to the ceiling of claude-haiku-5-5/);
  const composed = await routeEngineer(rowOf({ body: wide }), rig({ triage: JEV, switches: WINDOW_ON, body: reply({}) }).deps);
  assert.deepEqual([composed.route, windowOf(composed)], ["haiku/high", HAIKU_AUTOCOMPACT_WINDOW_TOKENS]);
  const small = await routeEngineer(rowOf({ labels: ["tier:haiku"] }), rig().deps);
  assert.equal(small.windowWhy, undefined, "the control: a Haiku row at its own window has nothing to explain");
});

test("windowReadings and windowReportLines: the last route line per row, its verdict and outcome, grouped by route and window against the store's compactions", () => {
  const at = 1;
  const line = (id: string, outcome: string) => ({ use: "model-routing", id, outcome, at });
  const lines = [line("row-1", "route sonnet/high window 200k via fallback (x)"), line("row-1", "route sonnet/high window 400k (the Region names files=9 repositories=1) via jev (y)"),
    line("row-2", "route sonnet/high window 400k via jev (y)"), line("row-2", "merged-first-pass"), line("row-3", "route haiku/high window 130k via override (tier:haiku)"),
    line("row-3", "window too small: 3 compactions at 130k"), { use: "wake-triage", id: "row-9", outcome: "route sonnet/high window 200k via jev (z)", at }, { garbage: true }];
  const readings = windowReadings(lines);
  assert.deepEqual(readings.map((r) => [r.row, r.route, r.windowK, r.outcome, r.tooSmall]),
    [[1, "sonnet/high", 400, null, false], [2, "sonnet/high", 400, "merged-first-pass", false], [3, "haiku/high", 130, null, true]]);
  const facts = new Map([[1, { compactions: 3, costUsd: 4 }], [2, { compactions: 0, costUsd: 1.5 }]]);
  assert.deepEqual(windowReportLines(readings, facts), [
    "haiku/high window 130k: 1 rows (0 in the store), compactions 0 (most in one row 0), cost $0.00, too small 1, outcomes no outcome recorded 1",
    "sonnet/high window 400k: 2 rows (2 in the store), compactions 3 (most in one row 3), cost $5.50, too small 1, outcomes no outcome recorded 1, merged-first-pass 1"]);
  assert.deepEqual([isWindowTooSmall({ compactions: 2, costUsd: 0 }), isWindowTooSmall({ compactions: 3, costUsd: 0 }), isWindowTooSmall(undefined)], [false, true, false]);
});

test("recordWindowTooSmall appends one outcome line beside the route's, which windowReadings then reads as the verdict", async () => {
  const r = rig();
  await routeEngineer(rowOf({ number: 77, body: bodyOf({ region: files(LARGE_ROW_FILES) }) }), r.deps);
  recordWindowTooSmall(77, { window: "400k", compactions: 3 }, r.deps);
  assert.deepEqual(windowReadings(r.log()).map((x) => [x.row, x.windowK, x.tooSmall]), [[77, 400, true]]);
});
