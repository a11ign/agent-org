// #4629: the engineer route. A fake `fetch`, a fake key, a fixture row and a temp directory only: no network, no real key, no corpus.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the route beside the row one answer away from it, and the provider-on case beside the four ways the provider is not asked.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { decide, decisionLogPathFrom, decisionSwitchesPath, MAX_STATE_BYTES, type Answer, type DecisionDeps } from "./decision-provider.ts";
import {
  composeRoute, HAIKU_MAX_P_DEBUGGING, HAIKU_MAX_P_SUBSYSTEMS, HAIKU_MIN_P_MECHANICAL, HAIKU_MIN_P_SCORE, HAIKU_MIN_P_SMALL, MEDIUM_MAX_P_SUBSYSTEMS, MEDIUM_MIN_P_SCORE, scoreAtMost, type Readings, fallbackRoute, fallbackWindow, GUARD_DECISIONS, isWindowTooSmall, LARGE_ROW_FILES, LARGEST_ROW_FILES, recordRouteOutcome, recordWindowTooSmall, regionSize, routeCostEvents,
  MECHANICAL_DATA, DEBUGGING_DATA, routeCostReading, ROUTE_COSTLIER_THAN_FALLBACK, routeEngineer, routeState, SCORE_LEVEL_DATA, SMALL_ROW_FILES, SUBSYSTEMS_DATA, windowOf, windowReadings, windowReportLines, QUESTIONS,
  acceptPick, isTestsFirst, pickedOf, ROUTE_DATA, routeQuestion, type Answers, type Route, type RouteRow,
} from "./engineer-route.ts";
import { parseHostConfig } from "./host-config.ts";
import { ABSENT_ROUTING, type RoutingDeclaration } from "./project-config.ts";
import { confidenceReading } from "./provider-confidence.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { freshState } from "./triage-provider.ts";
import { escalationsNow, instanceRefused } from "./wake.ts";
import { ROUTE_AHEAD, routesForStarts, spawnClaimer } from "./wake/release-line-and-seats.ts";
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

/** The probabilities a test sets directly (#4875): P(yes) for a yes/no question and P(level) for the score, keyed by its 1-based level. */
type Distribution = { mechanical?: number; subsystems?: number; debugging?: number; score?: Record<number, number> };
type Given = Partial<Record<keyof Answers, string | number>> & { confidence?: number; low?: keyof Answers; p?: Distribution };
const CLEAN_HAIKU = { mechanical: "yes", subsystems: "no", debugging: "no", score: 2 };
/** The API's score is the level's POSITION from zero and fractional (agent-org#564): level 2 comes back `1.04`, not `2`. `score` in a {@link Given} is the 1-based level. */
const positionOf = (level: number): number => level - 1 + 0.04;
const SCORE_LEVELS = [1, 2, 3, 4, 5];
/** TypeSafe's own formula, `confidence = (p_max - 1/n) / (1 - 1/n)` (docs.typesafe.ai/confidence): what a reply's confidence is of the distribution it carries. */
const confidenceOf = (pMax: number, n: number): number => (pMax - 1 / n) / (1 - 1 / n);

/** A yes/no reply: the chosen answer at `confidence` (its probability follows from the formula), or P(yes) set outright, in which case the confidence follows from IT. */
function choiceReply(chosen: string, confidence: number, pYes?: number) {
  if (pYes !== undefined) return { type: "choice", choice: pYes >= 0.5 ? "yes" : "no", confidence: confidenceOf(Math.max(pYes, 1 - pYes), 2), probabilities: { yes: pYes, no: 1 - pYes } };
  const pChosen = 0.5 + confidence / 2;
  return { type: "choice", choice: chosen, confidence, probabilities: { [chosen]: pChosen, [chosen === "yes" ? "no" : "yes"]: 1 - pChosen } };
}

/** A score reply, its probabilities keyed by zero-based position as the API's are: the level at `confidence` with the rest spread evenly, or the levels set outright. */
function scoreReply(level: number, confidence: number, levels?: Record<number, number>) {
  const pMax = levels === undefined ? 0.2 + 0.8 * confidence : Math.max(...Object.values(levels));
  const by = Object.fromEntries(SCORE_LEVELS.map((at) => [at, levels === undefined ? (at === level ? pMax : (1 - pMax) / (SCORE_LEVELS.length - 1)) : levels[at] ?? 0]));
  const top = Number(Object.entries(by).sort(([, a], [, b]) => b - a)[0][0]);
  const probabilities = Object.fromEntries(Object.entries(by).map(([at, p]) => [String(Number(at) - 1), p]));
  return { type: "score", score: positionOf(top), confidence: levels === undefined ? confidence : confidenceOf(pMax, SCORE_LEVELS.length), probabilities };
}

/** The provider's reply for a set of answers; `low` names the one question answered under the floor, and `p` sets a question's probabilities outright. */
function reply(given: Given) {
  const base = { ...CLEAN_HAIKU, ...given };
  const answers = Object.fromEntries((Object.keys(QUESTIONS) as (keyof Answers)[]).map((name) => {
    const confidence = name === given.low ? 0.5 : given.confidence ?? 0.95;
    if (name === "score") return [name, scoreReply(base.score as number, confidence, given.p?.score)];
    return [name, choiceReply(base[name] as string, confidence, given.p?.[name])];
  }));
  return { answers };
}

/**
 * WHAT THE API'S OPENAPI DOCUMENT REQUIRES OF A QUESTION, copied from `components.schemas.ChoiceQuestion` and `ScoreQuestion` of https://api.typesafe.ai/openapi.json (read 2026-10-10,
 * version 0.2.0), the parts a request can break: `criteria` is required; a choice's is an OBJECT of descriptions by choice, a score's an ORDERED ARRAY of at least one level; a
 * description is a string, an object or an array (a choice's may also be null); `type` is the constant. One invalid question rejects the whole request, so {@link violation}
 * returns the first, or `null`.
 */
type Schema = { type?: string; const?: unknown; anyOf?: Schema[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; additionalProperties?: Schema | boolean; minItems?: number };
const TEXT_OBJECT_OR_ARRAY: Schema[] = [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "array", items: {} }];
const OPENAPI_QUESTIONS: Readonly<Record<"choice" | "score", Schema>> = {
  choice: { type: "object", required: ["criteria", "type"], properties: { type: { type: "string", const: "choice" }, instructions: { anyOf: [...TEXT_OBJECT_OR_ARRAY, { type: "null" }] },
    criteria: { type: "object", additionalProperties: { anyOf: [...TEXT_OBJECT_OR_ARRAY, { type: "null" }] } } } },
  score: { type: "object", required: ["criteria", "type"], properties: { type: { type: "string", const: "score" }, instructions: { anyOf: [...TEXT_OBJECT_OR_ARRAY, { type: "null" }] },
    criteria: { type: "array", minItems: 1, items: { anyOf: TEXT_OBJECT_OR_ARRAY } } } },
};

const kindOf = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** The first way `value` is not what `schema` says, or `null`: the subset of JSON Schema the two question schemas use, nothing more. */
function mismatch(value: unknown, schema: Schema, at: string): string | null {
  if (schema.anyOf !== undefined) return schema.anyOf.some((alternative) => mismatch(value, alternative, at) === null) ? null : `${at}: ${kindOf(value)} is none of ${schema.anyOf.map((a) => a.type).join(", ")}`;
  if (schema.type !== undefined && kindOf(value) !== schema.type) return `${at}: ${kindOf(value)} is not ${schema.type}`;
  if ("const" in schema && value !== schema.const) return `${at}: not ${JSON.stringify(schema.const)}`;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) return `${at}: needs at least ${schema.minItems} items`;
    return value.map((item, i) => mismatch(item, schema.items ?? {}, `${at}[${i}]`)).find((found) => found !== null) ?? null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const missing = (schema.required ?? []).find((name) => record[name] === undefined);
  if (missing !== undefined) return `${at}.${missing}: required`;
  const each = typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
  return Object.entries(record).map(([name, v]) => { const sub = schema.properties?.[name] ?? each; return sub === undefined ? null : mismatch(v, sub, `${at}.${name}`); }).find((found) => found !== null) ?? null;
}

function violation(sent: unknown): string | null {
  const questions = (sent as { questions?: Record<string, { type?: string; instructions?: unknown }> } | null)?.questions;
  if (typeof questions !== "object" || questions === null) return "questions: required";
  for (const [name, q] of Object.entries(questions)) {
    if (typeof q?.instructions !== "string") return `${name}.instructions: required`;
    if (q.type !== "score" && q.type !== "choice") return `${name}.type: not a question type`;
    const found = mismatch(q, OPENAPI_QUESTIONS[q.type], name);
    if (found !== null) return found;
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
  // `routing` is PINNED to the absent declaration (the four traits, composed): left out, `routeEngineer` reads the HOME project's `routing` block, and a11ign/a11ign set
  // `routing: { question: "choice" }` in the #4953 ruling, so every test here that drives the four traits was reading a project fact and not the thing it names. A test
  // that means the one-question form spreads `CHOICE` over these deps, as the `choose` helper below does.
  const deps: DecisionDeps & { haikuSwitchPath: string; routing: RoutingDeclaration } = {
    host: withTriage(opts.triage), fetch: fn, state: freshState(), timeoutMs: 50, diagnostic: () => {}, switchesPath: decisionSwitchesPath(dir), logPath, now: () => 1_000,
    readKey: (path) => { reads.push(path); return "tsk-FAKE"; }, haikuSwitchPath: haikuSwitch, routing: ABSENT_ROUTING,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { deps, calls: () => calls, sent, reads, log, logPath };
}
const ON = JSON.stringify({ "model-routing": true });

// --- composeRoute: pure, on the provider's probabilities (#4875 on #4764) ---

/** A distribution over the five levels with `level` holding `p` and the rest spread evenly: a score of that level, as sure as `p`. */
const atLevel = (level: number, p: number): Record<string, number> =>
  Object.fromEntries(SCORE_LEVELS.map((at) => [String(at), at === level ? p : (1 - p) / (SCORE_LEVELS.length - 1)]));
/** P(level) for the levels given; the rest of the distribution is the remainder spread over the levels not named, so the total is 1. */
const levelsOf = (given: Record<number, number>): Record<string, number> => {
  const unnamed = SCORE_LEVELS.filter((at) => !(at in given));
  const rest = (1 - Object.values(given).reduce((a, b) => a + b, 0)) / unnamed.length;
  return Object.fromEntries(SCORE_LEVELS.map((at) => [String(at), at in given ? given[at] : rest]));
};
const CLEAN: Readings = { mechanical: 0.95, subsystems: 0.05, debugging: 0.05, score: atLevel(2, 0.9) };
const SMALL = { regionFiles: 2 };
const MANY = { regionFiles: 4 };

test("composeRoute: mechanical and a score probably at most 3 is Haiku/high (a11ign#4877); the readings one step away are not, and each lands where its own rule says", () => {
  assert.equal(composeRoute(CLEAN, SMALL), "haiku/high");
  assert.equal(composeRoute({ ...CLEAN, score: atLevel(1, 0.9) }, SMALL), "haiku/high");
  assert.equal(composeRoute({ ...CLEAN, score: atLevel(3, 0.9) }, SMALL), "haiku/high", "score 3 IS a Haiku row now (HAIKU_MAX_SCORE, #4877); it routed sonnet/medium at 2");
  assert.equal(composeRoute({ ...CLEAN, score: atLevel(4, 0.9) }, SMALL), "sonnet/high", "one level above the limit stays off Haiku, mechanical or not");
  assert.equal(composeRoute({ ...CLEAN, mechanical: 0.05 }, SMALL), "haiku/high", "a non-mechanical score 2 IS Haiku's on size (#4902): mechanical is a logged signal, not a gate");
  assert.equal(composeRoute({ ...CLEAN, mechanical: null }, SMALL), "haiku/high", "mechanical not given changes nothing for a scored row");
  assert.equal(composeRoute({ ...CLEAN, mechanical: 0.05, score: atLevel(4, 0.9) }, SMALL), "sonnet/high", "the control: size is the gate, so a non-mechanical score 4 is not lowered");
  assert.equal(composeRoute({ ...CLEAN, debugging: 0.95 }, SMALL), "sonnet/high", "debugging an unknown failure holds every rung");
});

test("composeRoute DONE-WHEN 1 (#4902): each threshold is a boundary, held to its own side, and none is the old confidence floor (a yes/no at 0.65 has a confidence of 0.3)", () => {
  assert.deepEqual([HAIKU_MIN_P_SMALL, HAIKU_MIN_P_SCORE, HAIKU_MAX_P_SUBSYSTEMS, HAIKU_MAX_P_DEBUGGING, MEDIUM_MIN_P_SCORE, MEDIUM_MAX_P_SUBSYSTEMS], [0.6, 0.9, 0.1, 0.25, 0.6, 0.5], "the chairman's values (#4902)");
  assert.equal(HAIKU_MIN_P_MECHANICAL, 0.65, "the one place mechanical still decides: an unscored row in a small Region");
  const at = (over: Partial<Readings>) => composeRoute({ ...CLEAN, mechanical: 0.05, ...over }, SMALL);
  const contained = levelsOf({ 1: 0.025, 2: 0.025, 3: 0.85 }); // P(score <= 2) 0.05, P(score <= 3) exactly 0.9: only the containment rule can take it
  assert.equal(at({ score: levelsOf({ 1: 0.3, 2: 0.3 }) }), "haiku/high", "P(score <= 2) of exactly 0.6, summed over TWO levels, qualifies on size");
  assert.equal(at({ score: levelsOf({ 1: 0.3, 2: 0.29 }) }), "sonnet/medium", "0.59 does not, and falls to the medium rule");
  assert.equal(at({ score: contained, subsystems: 0.1, debugging: 0.25 }), "haiku/high", "P(score <= 3) 0.9, subsystems 0.1 and debugging 0.25 are each AT their bound, and qualify");
  assert.equal(at({ score: levelsOf({ 1: 0.025, 2: 0.025, 3: 0.84 }), subsystems: 0.05, debugging: 0.05 }), "sonnet/medium", "P(score <= 3) of 0.89 is under 0.9");
  assert.equal(at({ score: contained, subsystems: 0.11, debugging: 0.05 }), "sonnet/medium", "subsystems just over 0.1");
  assert.equal(at({ score: contained, subsystems: 0.05, debugging: 0.26 }), "sonnet/medium", "debugging just over 0.25");
  assert.equal(at({ score: contained, subsystems: null, debugging: 0.05 }), "sonnet/medium", "subsystems not given is not containment");
  assert.equal(at({ score: contained, subsystems: 0.05, debugging: null }), "sonnet/medium", "debugging not given is not containment");
  assert.equal(at({ score: levelsOf({ 1: 0.2, 2: 0.2, 3: 0.2 }) }), "sonnet/medium", "P(score <= 3) of 0.6 is the medium rule's");
  assert.equal(at({ score: levelsOf({ 1: 0.2, 2: 0.2, 3: 0.19 }) }), "sonnet/high", "0.59 does not qualify for medium");
  assert.equal(at({ score: contained, subsystems: 0.49, debugging: 0.05 }), "sonnet/medium", "P(subsystems) under 0.5 passes the medium rule");
  assert.equal(at({ score: contained, subsystems: 0.5, debugging: 0.05 }), "sonnet/high", "and AT 0.5 does not: the bound is strict");
  assert.equal(at({ debugging: 0.49 }), "haiku/high", "a size-qualified row is held only by the debugging hold");
  assert.equal(at({ debugging: 0.5 }), "sonnet/high", "P(debugging) at 0.5 holds the row at the top");
});

test("composeRoute DONE-WHEN 1: a score split across ADJACENT levels is read as the sum, so 0.3 at level 2, 0.3 at level 3 and 0.35 at level 4 is not Haiku's but is a Sonnet/medium row though no level is likely", () => {
  const split = levelsOf({ 2: 0.3, 3: 0.3, 4: 0.35 });
  assert.deepEqual([scoreAtMost(split, 2), scoreAtMost(split, 3)], [0.325, 0.625], "P(<=2) is level 1's 0.025 of the remainder plus level 2's 0.3; P(<=3) adds level 3's 0.3");
  assert.equal(composeRoute({ ...CLEAN, score: split }, SMALL), "sonnet/medium", "P(score <= 3) is over 0.6 and under Haiku's 0.9, mechanical or not");
  assert.equal(composeRoute({ ...CLEAN, score: levelsOf({ 2: 0.3, 3: 0.25, 4: 0.4 }) }, SMALL), "sonnet/high", "the control: the same shape with 0.4 above level 3 is P(score <= 3) of 0.575");
});

test("composeRoute: mechanical with the score NOT GIVEN is Haiku/high only when the Region names at most 3 files; a non-mechanical row with no score never lowers", () => {
  const unscored = { ...CLEAN, score: null };
  assert.equal(composeRoute(unscored, { regionFiles: 3 }), "haiku/high");
  assert.equal(composeRoute(unscored, { regionFiles: 1 }), "haiku/high");
  assert.equal(composeRoute(unscored, MANY), "sonnet/high", "a fourth file (or a directory, which counts as four) is not a small Region");
  assert.equal(composeRoute(unscored, { regionFiles: 0 }), "sonnet/high", "a Region that names nothing is not small, it is unread");
  for (const readings of [{ ...unscored, mechanical: 0.05 }, { ...unscored, mechanical: null }]) {
    assert.equal(composeRoute(readings, SMALL), "sonnet/high", JSON.stringify(readings));
  }
});

test("composeRoute: a score probably at most 3 with subsystems NOT probably yes is Sonnet/medium; a probable yes, a higher score and no score are Sonnet/high", () => {
  const medium: Readings = { mechanical: 0.05, subsystems: 0.3, debugging: 0.05, score: atLevel(3, 0.9) };
  assert.equal(composeRoute(medium, SMALL), "sonnet/medium");
  assert.equal(composeRoute({ ...medium, subsystems: null }, SMALL), "sonnet/medium", "subsystems not given passes");
  assert.equal(composeRoute({ ...medium, debugging: null }, SMALL), "sonnet/medium", "only a probable debugging YES holds a row");
  assert.equal(composeRoute({ ...medium, score: atLevel(1, 0.9) }, MANY), "haiku/high", "a scored row is Haiku's on size, whatever the Region names (the Region only gates an unscored one)");
  for (const flipped of [{ subsystems: 0.9 }, { debugging: 0.9 }, { score: atLevel(4, 0.9) }, { score: atLevel(5, 0.9) }, { score: null }]) {
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

/** What a provider-ABSENT route is, recorded from `origin/main` at 5f4b499 BEFORE the criteria became structured (#4752): the route, its profile, and the one log line it wrote. */
const ABSENT_SNAPSHOT = "[{\"region\":[\"src/a.ts\",\"src/a.test.ts\"],\"routed\":{\"route\":\"sonnet/medium\",\"via\":\"fallback\",\"why\":\"no triage provider is declared\",\"profile\":{\"kind\":\"claude\",\"model\":\"sonnet\",\"effort\":\"medium\",\"autocompactWindow\":200000,\"why\":\"a small row with a command Acceptance (a11ign/a11ign#4629): medium effort is enough to build it\"},\"reason\":\"no triage provider is declared\"},\"log\":[{\"use\":\"model-routing\",\"id\":\"row-4999\",\"outcome\":\"route sonnet/medium window 200k via fallback (no triage provider is declared)\",\"reason\":\"no triage provider is declared\",\"at\":1000}],\"calls\":0,\"reads\":[]},{\"region\":[\"src/\"],\"routed\":{\"route\":\"sonnet/high\",\"via\":\"fallback\",\"why\":\"no triage provider is declared\",\"profile\":null,\"reason\":\"no triage provider is declared\"},\"log\":[{\"use\":\"model-routing\",\"id\":\"row-4999\",\"outcome\":\"route sonnet/high window 200k via fallback (no triage provider is declared)\",\"reason\":\"no triage provider is declared\",\"at\":1000}],\"calls\":0,\"reads\":[]},{\"region\":[\"a\",\"b\",\"c\",\"d\"],\"routed\":{\"route\":\"sonnet/high\",\"via\":\"fallback\",\"why\":\"no triage provider is declared\",\"profile\":null,\"reason\":\"no triage provider is declared\"},\"log\":[{\"use\":\"model-routing\",\"id\":\"row-4999\",\"outcome\":\"route sonnet/high window 200k via fallback (no triage provider is declared)\",\"reason\":\"no triage provider is declared\",\"at\":1000}],\"calls\":0,\"reads\":[]}]";

test("provider ABSENT: the route, its profile and its log line are byte-for-byte what they were before the criteria were structured (#4752)", async () => {
  const shapes = [["src/a.ts", "src/a.test.ts"], ["src/"], ["a", "b", "c", "d"]];
  const seen = [];
  for (const region of shapes) {
    const r = rig({ switches: ON });
    const routed = await routeEngineer(rowOf({ body: bodyOf({ region }) }), r.deps);
    seen.push({ region, routed, log: r.log(), calls: r.calls(), reads: r.reads });
  }
  assert.equal(JSON.stringify(seen), ABSENT_SNAPSHOT);
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

test("provider ON: clean answers are Haiku/high with the Haiku profile; a non-mechanical score 3 with subsystems no is Haiku/high (#4902); one unsure of subsystems is Sonnet/medium; a subsystem yes is Sonnet/high", async () => {
  const haiku = rig({ triage: JEV, switches: ON });
  const h = await routeEngineer(rowOf(), haiku.deps);
  assert.deepEqual([h.route, h.via, h.profile?.model, h.profile?.effort, h.profile?.autocompactWindow], ["haiku/high", "jev", HAIKU_MODEL_ID, "high", HAIKU_AUTOCOMPACT_WINDOW_TOKENS]);
  const small = { mechanical: "no", subsystems: "no", score: 3 };
  const contained = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(small) }).deps);
  assert.deepEqual([contained.route, contained.via, contained.profile?.effort], ["haiku/high", "jev", "high"]);
  const medium = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...small, low: "subsystems" }) }).deps);
  assert.deepEqual([medium.route, medium.via, medium.profile?.effort], ["sonnet/medium", "jev", "medium"], "subsystems at P(yes) 0.25 is not containment");
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

test("#4764 DONE-WHEN 1: a small single-subsystem row (two files, a command, subsystems no, score 3) is Haiku/high via the provider (#4902), and ONE answer short of that is Sonnet/medium", async () => {
  const given = { mechanical: "no", subsystems: "no", score: 3 };
  const medium = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(given) }).deps);
  assert.deepEqual([medium.route, medium.via, medium.profile?.model, medium.profile?.effort], ["haiku/high", "jev", HAIKU_MODEL_ID, "high"]);
  // The answers the provider was NOT sure of (live: `subsystems` 28 of 49, `score` 31 of 49) are why the route was pinned. At a confidence of 0.5 a `no` is still P(yes) = 0.25 and a level 3
  // still P(score <= 3) = 0.8, so neither is discarded any more (#4875), and the reason says nothing was missing.
  const unsure = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, low: "subsystems" }) }).deps);
  assert.deepEqual([unsure.route, unsure.reason], ["sonnet/medium", undefined]);
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, low: "score" }) }).deps)).route, "sonnet/medium");
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...given, subsystems: "yes" }) }).deps)).route, "sonnet/high", "the control: subsystems yes");
  const noScore = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: withoutProbabilities(reply(given), "score") }).deps);
  assert.equal(noScore.route, "sonnet/high", "the control: no score, not mechanical");
  assert.match(noScore.reason!, /^probabilities not given \(score: the answer carried no readable probabilities\)$/);
});

test("provider ON with ONE distribution not given: each question's absence composes what its own rule says, and the same row with a fourth file is the control for score", async () => {
  const expected: Record<keyof Answers, Route> = { mechanical: "haiku/high", subsystems: "haiku/high", debugging: "haiku/high", score: "haiku/high" };
  for (const name of Object.keys(QUESTIONS) as (keyof Answers)[]) {
    const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: withoutProbabilities(reply({}), name) }).deps);
    assert.equal(routed.route, expected[name], name);
    assert.equal(routed.via, "jev");
    assert.match(routed.reason!, new RegExp(`^probabilities not given \\(${name}: `));
  }
  const four = rowOf({ body: bodyOf({ region: ["a.ts", "b.ts", "c.ts", "d.ts"] }) });
  const noScore = await routeEngineer(four, rig({ triage: JEV, switches: ON, body: withoutProbabilities(reply({}), "score") }).deps);
  assert.deepEqual([noScore.route, noScore.profile], ["sonnet/high", null], "mechanical with no score and a Region of four is not small");
});

test("#4875 DONE-WHEN 1: an answer UNDER THE CONFIDENCE FLOOR is not discarded -- every question at confidence 0.5 (under the floor of 0.9) composes the same route as every one at 0.95, and the log keeps what the floor replaced", async () => {
  const sure = rig({ triage: JEV, switches: ON, body: reply({}) });
  const unsure = rig({ triage: JEV, switches: ON, body: reply({ confidence: 0.5 }) });
  const [a, b] = [await routeEngineer(rowOf(), sure.deps), await routeEngineer(rowOf(), unsure.deps)];
  assert.deepEqual([a.route, b.route, b.via, b.reason], ["haiku/high", "haiku/high", "jev", undefined]);
  const line = unsure.log().find((l) => l.answers !== undefined);
  assert.deepEqual(Object.values(line.answers as Record<string, { fellBack: boolean }>).map((x) => x.fellBack), [true, true, true, true], "the floor still replaced every VALUE: the window and every other reader see what they saw");
  assert.deepEqual(line.answers.mechanical.probabilities, { yes: 0.75, no: 0.25 }, "and the distribution it replaced is on the record");
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
const choice = (value: string) => ({ type: "choice", choice: value, confidence: 0.95, probabilities: { [value]: 0.975, [value === "yes" ? "no" : "yes"]: 0.025 } });
/** A reply with one question's distribution emptied: an answer that was well formed and carried no probabilities, which is "not given" and never a probability of zero (#4875). */
const withoutProbabilities = (body: { answers: Record<string, object> }, name: string) => ({ ...body, answers: { ...body.answers, [name]: { ...body.answers[name], probabilities: {} } } });
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
  // The provider answered: a zero-based 0.04 is level 1, and the row is NOT a fallback. The mechanical answer at 0.44 is under the 0.9 floor, so its VALUE was replaced -- but its
  // distribution, 72% yes, is what the route reads (#4875): this recorded 200 was a Sonnet/medium row under the floor and is a Haiku one on its probabilities.
  assert.equal(routed.via, "jev");
  const line = r.log().find((l) => l.answers !== undefined);
  assert.deepEqual([line.via, line.answers.score.value, line.answers.score.fellBack, line.answers.mechanical.fellBack], ["jev", 1, false, true]);
  assert.match(line.answers.mechanical.reason, /yes at 0\.44, under the floor 0\.9/);
  assert.deepEqual(line.answers.mechanical.probabilities, { yes: 0.72, no: 0.28 }, "the full distribution of a choice is in the decision record");
  assert.deepEqual(line.answers.score.probabilities, { 1: 0.98, 2: 0.01, 3: 0.01, 4: 0, 5: 0 }, "and a score's, keyed by the 1-based level its `value` is on");
  assert.equal(routed.route, "haiku/high", "P(mechanical) 0.72 clears 0.65 and P(score <= 2) is 0.99");
  assert.equal(routed.reason, undefined, "every distribution was read, so nothing was not given");
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

// --- #4875 DONE-WHEN 1, end to end: the provider's probabilities through `routeEngineer`, at a confidence the old floor discarded ---

/** The three rows the chairman named, as replies: every question is under the floor of 0.9, so on the old rule none of them was a given answer at all. */
const ROUTED = {
  "0.8 mechanical, P(score <= 2) 0.7": { mechanical: "yes", p: { mechanical: 0.8, subsystems: 0.1, debugging: 0.05, score: { 1: 0.3, 2: 0.4, 3: 0.2, 4: 0.1 } } },
  "score split 0.45 at 2 and 0.4 at 3": { mechanical: "yes", p: { mechanical: 0.9, subsystems: 0.1, debugging: 0.05, score: { 2: 0.45, 3: 0.4, 4: 0.15 } } },
  "0.5 mechanical": { mechanical: "yes", p: { mechanical: 0.5, subsystems: 0.1, debugging: 0.05, score: { 1: 0.5, 2: 0.4, 3: 0.1 } } },
} as const;

test("#4875 DONE-WHEN 1: a row the provider rates 0.8 mechanical with P(score <= 2) of 0.7 routes to Haiku/high -- under a confidence floor of 0.9 it was discarded", async () => {
  const body = reply(ROUTED["0.8 mechanical, P(score <= 2) 0.7"]);
  assert.equal(body.answers.mechanical.confidence, 0.6000000000000001, "the control: a confidence of 0.6, which the old floor read as 'not given'");
  const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body }).deps);
  assert.deepEqual([routed.route, routed.via, routed.profile?.model], ["haiku/high", "jev", HAIKU_MODEL_ID]);
  assert.match(routed.why, /P\(mechanical=yes\)=0\.800, .*P\(score<=3\)=0\.900/);
});

test("#4875 DONE-WHEN 1: a score split 0.45 at level 2 and 0.4 at level 3 routes to Sonnet/medium, mechanical or not (P(score <= 2) is 0.45 and P(score <= 3) 0.85, under Haiku's 0.9, #4902)", async () => {
  const split = ROUTED["score split 0.45 at 2 and 0.4 at 3"];
  const mechanical = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(split) }).deps);
  assert.deepEqual([mechanical.route, mechanical.profile?.model], ["sonnet/medium", "sonnet"]);
  const notMechanical = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply({ ...split, p: { ...split.p, mechanical: 0.1 } }) }).deps);
  assert.equal(notMechanical.route, "sonnet/medium", "mechanical is not a gate (#4902): the same row at 0.1 routes the same");
  const scattered = { ...split, p: { ...split.p, score: { 2: 0.3, 3: 0.25, 4: 0.3, 5: 0.15 } } };
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: reply(scattered) }).deps)).route, "sonnet/high", "the control: P(score <= 3) of 0.55 is under 0.6");
});

test("#4902 DONE-WHEN 1: a row with P(mechanical) = 0.5 and P(score <= 3) 0.94 routes to Haiku/high: mechanical is not a gate, size and containment are", async () => {
  const body = reply({ p: { mechanical: 0.45, subsystems: 0.05, debugging: 0.19, score: { 1: 0.1, 2: 0.2, 3: 0.64, 4: 0.04, 5: 0.02 } } });
  const routed = await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body }).deps);
  assert.deepEqual([routed.route, routed.via, routed.profile?.model], ["haiku/high", "jev", HAIKU_MODEL_ID]);
  assert.match(routed.why, /P\(mechanical=yes\)=0\.450, .*P\(score<=3\)=0\.940/);
  const crossing = reply({ p: { mechanical: 0.45, subsystems: 0.3, debugging: 0.19, score: { 1: 0.1, 2: 0.2, 3: 0.63, 4: 0.05, 5: 0.02 } } });
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: crossing }).deps)).route, "sonnet/medium", "P(score <= 3) 0.93 with P(subsystems) 0.3 is Sonnet/medium");
  const large = reply({ p: { mechanical: 0.45, subsystems: 0.05, debugging: 0.19, score: { 1: 0.05, 2: 0.1, 3: 0.1, 4: 0.5, 5: 0.25 } } });
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: large }).deps)).route, "sonnet/high", "P(score <= 3) 0.25 is Sonnet/high");
});

test("#4875 DONE-WHEN 1: the absolute refusals hold at ANY probability -- lane:ceo, needs:chairman, a workflows Region and no Acceptance command are never asked, however sure", async () => {
  const sure = reply({ p: { mechanical: 1, subsystems: 0, debugging: 0, score: { 1: 1 } } });
  const refused: [string, RouteRow][] = [
    ["lane:ceo", rowOf({ labels: ["ready", "lane:ceo"] })],
    ["needs:chairman", rowOf({ labels: ["ready", "needs:chairman"] })],
    ["a workflows Region", rowOf({ body: bodyOf({ region: [".github/workflows/ci.yml"] }) })],
    ["no Acceptance command", rowOf({ body: bodyOf({ acceptance: null }) })],
  ];
  for (const [why, row] of refused) {
    const r = rig({ triage: JEV, switches: ON, body: sure });
    const routed = await routeEngineer(row, r.deps);
    assert.deepEqual([routed.route, routed.via, routed.profile, r.calls()], ["sonnet/high", "refused", null, 0], why);
  }
  assert.equal((await routeEngineer(rowOf(), rig({ triage: JEV, switches: ON, body: sure }).deps)).route, "haiku/high", "the control: the same reply, on a row nothing refuses");
});

test("#4875 DONE-WHEN 1: the decision record keeps every question's FULL probabilities -- a choice's by option, the score's by 1-based level -- whether or not the floor replaced the value", async () => {
  const r = rig({ triage: JEV, switches: ON, body: reply(ROUTED["0.8 mechanical, P(score <= 2) 0.7"]) });
  await routeEngineer(rowOf(), r.deps);
  const { answers } = r.log().find((l) => l.answers !== undefined);
  assert.deepEqual(answers.mechanical.probabilities, { yes: 0.8, no: 0.19999999999999996 });
  assert.deepEqual(Object.keys(answers.score.probabilities), ["1", "2", "3", "4", "5"], "a score's keys are the levels its `value` is on, not the API's zero-based positions");
  assert.deepEqual(Object.values(answers.score.probabilities), [0.3, 0.4, 0.2, 0.1, 0]);
  assert.deepEqual((Object.values(answers) as { fellBack: boolean }[]).map((a) => a.fellBack), [true, true, true, true], "the control: the floor replaced every value, and the probabilities are there anyway");
});

test("#4875 `decide` keeps a distribution only when it is one this question could have: unknown keys, a value over 1 or a total well over 1 drop it whole, and an empty record is not given", async () => {
  const ask = async (mechanical: unknown, score: unknown) => {
    const r = rig({ triage: JEV, switches: ON, body: { answers: { ...reply({}).answers, mechanical, score } } });
    return (await decide("model-routing", routeState(rowOf()), QUESTIONS, r.deps)).answers;
  };
  const choiceWith = (probabilities: unknown) => ({ type: "choice", choice: "yes", confidence: 0.95, probabilities });
  const scoreWith = (probabilities: unknown) => ({ type: "score", score: 1.04, confidence: 0.95, probabilities });
  const good = await ask(choiceWith({ yes: 0.8, no: 0.2 }), scoreWith({ 0: 0.1, 1: 0.7, 2: 0.2, 3: 0, 4: 0 }));
  assert.deepEqual(good.mechanical.probabilities, { yes: 0.8, no: 0.2 }, "the control: a distribution that is one is kept");
  assert.deepEqual(good.score.probabilities, { 1: 0.1, 2: 0.7, 3: 0.2, 4: 0, 5: 0 }, "and a score's zero-based positions move onto the 1..5 levels `value` is on");
  assert.deepEqual([good.mechanical.value, good.score.value], ["yes", 2], "the value is read as it always was");
  for (const [what, probabilities] of [["an option the question does not have", { yes: 0.5, maybe: 0.5 }], ["a probability over 1", { yes: 1.2, no: 0 }], ["a negative one", { yes: 1.1, no: -0.1 }],
    ["a total well over 1", { yes: 0.9, no: 0.9 }], ["a non-number", { yes: "0.8", no: 0.2 }], ["an empty record", {}], ["an array", [0.8, 0.2]], ["nothing", undefined]] as const) {
    const answer = (await ask(choiceWith(probabilities), scoreWith({}))).mechanical;
    assert.deepEqual([what, answer.probabilities, answer.value], [what, undefined, "yes"], "the answer is still read; only its distribution is not given");
  }
  for (const [what, probabilities] of [["a sixth position", { 0: 0.5, 5: 0.5 }], ["a key that is not a position", { first: 1 }], ["a negative position", { "-1": 0.5, 0: 0.5 }], ["a fractional one", { 0.5: 1 }]] as const) {
    assert.equal((await ask(choiceWith({ yes: 0.8, no: 0.2 }), scoreWith(probabilities))).score.probabilities, undefined, what);
  }
  const rounded = await ask(choiceWith({ yes: 0.51, no: 0.51 }), scoreWith({}));
  assert.deepEqual(rounded.mechanical.probabilities, { yes: 0.51, no: 0.51 }, "a total a little over 1 is a rounded distribution and is kept");
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
    ["row-1", "route haiku/high window 130k via jev (the provider's probabilities: P(mechanical=yes)=0.975, P(subsystems=yes)=0.025, P(debugging=yes)=0.025, P(score<=3)=0.980) [fallback would be sonnet/medium]"],
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

/** The ids and outcomes `routeEngineer` appended to the decision log beside this ledger, in order. */
const routedIdsOf = (dir: string): string[] => {
  const logPath = decisionLogPathFrom(join(dir, "wake-ledger"));
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.use === "model-routing" && isOutcomeLine(l)).map((l) => `${l.id} ${String(l.outcome).split(" ").slice(0, 2).join(" ")}`);
};
/** A row whose Region is five files, which the fallback routes Sonnet/high, and one whose Region is two, which it routes Sonnet/medium. */
const WIDE_BODY = bodyOf({ region: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"] });

test("a11ign/agent-org#756: another tracker's start order is routed too -- read from THAT tracker, filed under its keyed ref, logged as row-<key>-<n>", async () => {
  const dir = tmpDir("engineer-route-keyed-");
  const reads: [number, string | undefined][] = [];
  const readRow = (row: number, key?: string) => { reads.push([row, key]); return { labels: ["ready"], body: bodyOf(), title: `row ${row}` }; };
  const routes = await routesForStarts([{ causeKey: "engineers/ready-row-unclaimed/agent-org#756" }], { host: withTriage(), ledgerPath: join(dir, "wake-ledger"), readRow, projectDir: dir });
  assert.deepEqual(reads, [[756, "agent-org"]]);
  assert.deepEqual([...routes.keys()], ["agent-org#756"]);
  assert.equal(routes.get("agent-org#756")?.route, "sonnet/medium");
  assert.deepEqual(routedIdsOf(dir), ["row-agent-org-756 route sonnet/medium"]);
});

test("a11ign/agent-org#756: an a11ign row and an agent-org row of the SAME number are two routes and two ledger ids, and neither takes the other's", async () => {
  const dir = tmpDir("engineer-route-collision-");
  const readRow = (row: number, key?: string) => ({ labels: ["ready"], body: key === "agent-org" ? WIDE_BODY : bodyOf(), title: `${key ?? "a11ign"} row ${row}` });
  const orders = [{ causeKey: "engineers/ready-row-unclaimed/659" }, { causeKey: "engineers/ready-row-unclaimed/agent-org#659" }];
  const routes = await routesForStarts(orders, { host: withTriage(), ledgerPath: join(dir, "wake-ledger"), readRow, projectDir: dir });
  assert.deepEqual([...routes.keys()], [659, "agent-org#659"]);
  assert.equal(routes.get(659)?.route, "sonnet/medium", "the first tracker's row keeps its own route");
  assert.equal(routes.get("agent-org#659")?.route, "sonnet/high", "the keyed row took ITS body's route, not the first tracker's");
  assert.deepEqual(routedIdsOf(dir).sort(), ["row-659 route sonnet/medium", "row-agent-org-659 route sonnet/high"]);

  const claimed = (key?: string) => ({ row: 659, ...(key === undefined ? {} : { key }), branch: "b", worktree: "w", launchDir: "l" });
  const claimer = spawnClaimer({ routes, readRow: () => assert.fail("a routed row is not read again") });
  assert.equal(claimer.tier?.(claimed("agent-org")), null, "Sonnet/high is the ordinary profile, and it is not the first tracker's Sonnet/medium");
  assert.equal(claimer.tier?.(claimed())?.effort, "medium");
});

test("a11ign/agent-org#756: a keyed row that cannot be read is absent and takes the ordinary profile; one with no route is not read for the first tracker's label", async () => {
  const dir = tmpDir("engineer-route-keyed-absent-");
  const readRow = (row: number, key?: string) => { if (key === "agent-org") throw new Error("gh down"); return { labels: ["ready"], body: bodyOf(), title: `row ${row}` }; };
  const orders = [{ causeKey: "engineers/ready-row-unclaimed/agent-org#756" }, { causeKey: "engineers/ready-row-unclaimed/8" }];
  const routes = await routesForStarts(orders, { host: withTriage(), ledgerPath: join(dir, "wake-ledger"), readRow, projectDir: dir });
  assert.deepEqual([...routes.keys()], [8], "the keyed row is absent, the other is routed");

  const switchPath = join(dir, "on.json");
  writeFileSync(switchPath, '{ "enabled": true }');
  const claimer = spawnClaimer({ routes, switchPath, readRow: () => ({ labels: ["ready", "tier:haiku"], body: bodyOf() }) });
  assert.equal(claimer.tier?.({ row: 756, key: "agent-org", branch: "b", worktree: "w", launchDir: "l" }), null);
  assert.equal(claimer.tier?.({ row: 756, branch: "b", worktree: "w", launchDir: "l" })?.model, HAIKU_MODEL_ID, "the control: the first tracker's row 756 still reads its own label");
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
  assert.equal(outcomeOf(given), "route haiku/high window 130k via jev (the provider's probabilities: P(mechanical=yes)=0.975, P(subsystems=yes)=0.025, P(debugging=yes)=0.025, P(score<=3)=0.980) [fallback would be sonnet/medium]");
  // jev, one distribution not given: the line names it and why, and the route is what the rest compose (Haiku/high: score 2 is size enough, mechanical is not a gate, #4902).
  const held = rig({ triage: JEV, switches: ON, body: withoutProbabilities(reply({}), "mechanical") });
  assert.equal((await routeEngineer(rowOf(), held.deps)).route, "haiku/high");
  assert.match(outcomeOf(held), /^route haiku\/high window 130k via jev \(the provider's probabilities: P\(mechanical=yes\)=not given \(the answer carried no readable probabilities\), P\(subsystems=yes\)=0\.025, .*\) \[fallback would be sonnet\/medium\]$/);
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

// --- #4764: the guard against paying more than the fallback ---

/** One outcome line as `routeEngineer` writes it for a provider route: `route <provider> window <label> via jev (...) [fallback would be <fallback>]` (#4738 put the window there). */
const outcomeLine = (n: number, provider: Route, fallback: Route | null, at = n) =>
  ({ use: "model-routing", id: `row-${n}`, outcome: `route ${provider} window 200k via jev (the provider answered: x)${fallback === null ? "" : ` [fallback would be ${fallback}]`}`, at });
const run = (n: number, provider: Route, fallback: Route | null) => Array.from({ length: n }, (_, i) => outcomeLine(i, provider, fallback));

test("routeCostReading reads a line with the window's reason in parentheses, and one written before the window was logged", () => {
  const withReason = (n: number) => ({ use: "model-routing", id: `row-${n}`, outcome: "route sonnet/high window 400k (Region of 12 files; the provider raised it) via jev (the provider answered: x) [fallback would be sonnet/medium]", at: n });
  const before = (n: number) => ({ use: "model-routing", id: `row-${n}`, outcome: "route sonnet/high via jev (the provider answered: x) [fallback would be sonnet/medium]", at: n });
  for (const line of [withReason, before]) {
    const reading = routeCostReading(Array.from({ length: 20 }, (_, i) => line(i)));
    assert.deepEqual(reading, { kind: "read", compared: 20, providerMean: 3, fallbackMean: 2, costlier: true });
  }
});

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
    assert.equal((await routeEngineer(rowOf({ number: n }), even.deps)).route, "haiku/high");
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

// --- #4764 change 3 and #4752: the criteria are STRUCTURE, with examples from rows whose outcome is known ---

const ROW_REF = /^(a11ign|agent-org)#\d+$/;
/** What an example says it merged: `git diff --numstat` of the merge less its acceptance and changeset files, or that there was no diff of its own. */
const MERGED = /^(\d+ files?, \+\d+ -\d+|no diff of its own: .+)$/;
type SentQuestion = { type: string; instructions: string; criteria: any };

async function postedQuestions(row: RouteRow = rowOf()): Promise<{ questions: Record<string, SentQuestion>; sent: unknown }> {
  const r = rig({ triage: JEV, switches: ON, validates: true });
  await routeEngineer(row, r.deps);
  assert.equal(r.calls(), 1);
  assert.equal(violation(r.sent[0]), null, "the API would take this request");
  return { questions: (r.sent[0] as { questions: Record<string, SentQuestion> }).questions, sent: r.sent[0] };
}

test("every score level is POSTED as an object -- a summary, its signals and examples -- the five in the order scored, and every example names a row of ours with what merged (#4752)", async () => {
  assert.equal(SCORE_LEVEL_DATA.length, 5);
  const { questions } = await postedQuestions();
  const levels: Record<string, unknown>[] = questions.score.criteria;
  assert.equal(levels.length, 5);
  SCORE_LEVEL_DATA.forEach((level, i) => {
    assert.ok(level.summary !== "" && level.signals.length >= 2 && level.examples.length >= 2, `level ${i + 1} has a summary, signals and examples`);
    assert.deepEqual(Object.keys(levels[i]), ["summary", "signals", "examples"], `level ${i + 1} is structure, not a sentence`);
    assert.equal(levels[i].summary, level.summary, `level ${i + 1} is where its position says`);
    assert.deepEqual(levels[i].signals, level.signals);
    assert.equal((levels[i].examples as string[]).length, level.examples.length);
    level.examples.forEach((example, j) => {
      assert.match(example.row, ROW_REF);
      assert.match(example.merged, MERGED, `${example.row} says how big the merge that settled it was`);
      assert.ok(example.what !== "" && (levels[i].examples as string[])[j].startsWith(`${example.row}: ${example.what}`), `${example.row} is sent, with what it changed`);
    });
  });
});

test("each choice is POSTED as options keyed yes and no, every option an object of `what`, `not_for` and examples, and no row is the example of both answers (#4752)", async () => {
  const { questions } = await postedQuestions();
  const data = { mechanical: MECHANICAL_DATA, subsystems: SUBSYSTEMS_DATA, debugging: DEBUGGING_DATA };
  for (const [name, options] of Object.entries(data)) {
    const criteria = questions[name].criteria;
    assert.deepEqual(Object.keys(criteria), ["yes", "no"], `${name}: the answer words are what \`decide\` checks a choice against`);
    for (const answer of ["yes", "no"] as const) {
      const option = options[answer];
      assert.deepEqual(Object.keys(criteria[answer]), ["what", "not_for", "examples"], `${name}.${answer}`);
      assert.deepEqual([criteria[answer].what, criteria[answer].not_for], [option.what, option.notFor]);
      assert.ok(option.what !== "" && option.notFor !== "" && option.examples.length >= 2, `${name}.${answer} says what it is, what it is not for, and gives examples`);
      assert.deepEqual(criteria[answer].examples.map((e: string) => e.split(":")[0]), option.examples.map((e) => e.row));
      for (const example of option.examples) {
        assert.match(example.row, ROW_REF);
        assert.match(example.merged, MERGED);
      }
    }
    const yes = options.yes.examples.map((e) => e.row);
    assert.deepEqual(options.no.examples.map((e) => e.row).filter((row) => yes.includes(row)), [], `${name}: a row is not a yes and a no`);
  }
});

test("CONTROLS for the schema check: a description that is a number, or a score level that is null, is the API's refusal -- so passing it is not vacuous (#4752)", () => {
  const ask = (type: string, criteria: unknown) => violation({ questions: { q: { type, instructions: "?", criteria } } });
  assert.equal(ask("choice", { yes: { what: "x", not_for: "y", examples: ["z"] }, no: null }), null, "structure, and a choice's null, are what the API takes");
  assert.equal(ask("score", [{ summary: "a", signals: ["b"] }, "c"]), null);
  assert.match(ask("choice", { yes: 3, no: "n" })!, /^q\.criteria\.yes: number is none of string, object, array, null$/);
  assert.match(ask("score", [{ summary: "a" }, null])!, /^q\.criteria\[1\]: null is none of string, object, array$/);
  assert.match(ask("score", [])!, /^q\.criteria: needs at least 1 items$/);
  assert.match(ask("score", { a: "b" })!, /^q\.criteria: object is not array$/);
});

test("the state is the row's four structured fields and never its body, beside the structured criteria (#4752)", async () => {
  const { sent } = await postedQuestions(rowOf({ body: bodyOf({ extra: `${SECRET_BODY_TEXT}\n\n` }) }));
  assert.deepEqual(Object.keys((sent as { state: object }).state), ["title", "region", "acceptance", "doneWhen"]);
  assert.ok(!JSON.stringify(sent).includes(SECRET_BODY_TEXT));
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
  const withSwitch = async (switches: string, given: Given) => routeEngineer(rowOf({ body }), rig({ triage: JEV, switches, body: reply({ mechanical: "no", debugging: "yes", ...given }) }).deps);
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
  const small = await routeEngineer(rowOf(), rig({ triage: JEV, switches: WINDOW_ON, body: reply({ mechanical: "no", debugging: "yes", subsystems: "no", score: 1 }) }).deps);
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

// --- the route as ONE choice (#4904) ---

const CHOICE: RoutingDeclaration = { ...ABSENT_ROUTING, question: "choice" };
/** A row whose fallback is Sonnet/high: a fourth file is not small. The row with `rowOf()` has a fallback of Sonnet/medium. */
const FOUR_FILES = (): RouteRow => rowOf({ body: bodyOf({ region: ["a.ts", "b.ts", "c.ts", "d.ts"] }) });

/** The route question's reply: P(route) set outright, the pick the likeliest, its confidence what TypeSafe's formula gives of three options. */
function routeReply(given: Record<string, number>, over: Given = {}) {
  const [pick, pMax] = Object.entries(given).sort(([, a], [, b]) => b - a)[0];
  const route = { type: "choice", choice: pick, confidence: confidenceOf(pMax, 3), probabilities: given };
  return { answers: { ...reply(over).answers, route } };
}
/** Probabilities over the three routes with `route` at `p` and the remainder split 2:1 over the others, so `route` is the likeliest for any p over 0.4. */
function at(route: Route, p: number): Record<string, number> {
  const others = (["haiku/high", "sonnet/medium", "sonnet/high"] as Route[]).filter((r) => r !== route);
  return { [route]: p, [others[0]]: (1 - p) * (2 / 3), [others[1]]: (1 - p) / 3 };
}
async function choose(row: RouteRow, body: unknown, over: { routing?: RoutingDeclaration; haikuSwitch?: string; validates?: boolean } = {}) {
  const r = rig({ triage: JEV, switches: ON, body, haikuSwitch: over.haikuSwitch, validates: over.validates });
  const routed = await routeEngineer(row, { ...r.deps, routing: over.routing ?? CHOICE });
  return { routed, r, picked: pickedOf(outcomeOf(r)) };
}

test("#4904 DONE-WHEN 1: a Haiku/high pick at P=0.55 routes Haiku over a Sonnet/medium fallback, and at 0.45 it does not -- the cheaper threshold is 0.5", async () => {
  const taken = await choose(rowOf(), routeReply(at("haiku/high", 0.55)));
  assert.deepEqual([taken.routed.route, taken.routed.via, taken.routed.profile?.model], ["haiku/high", "jev", HAIKU_MODEL_ID]);
  const under = await choose(rowOf(), routeReply(at("haiku/high", 0.45)));
  assert.deepEqual([under.routed.route, under.routed.via, under.picked?.because, under.picked?.pick, under.picked?.ran], ["sonnet/medium", "fallback", "low-confidence", "haiku/high", "sonnet/medium"]);
  assert.match(under.routed.reason!, /needs P >= 0\.5/);
});

test("#4904 DONE-WHEN 1: a Sonnet/high pick at P=0.6 over a Sonnet/medium fallback takes the fallback, and at 0.7 it is taken -- the dearer threshold is 0.7", async () => {
  const held = await choose(rowOf(), routeReply(at("sonnet/high", 0.6)));
  assert.deepEqual([held.routed.route, held.routed.via, held.picked?.because], ["sonnet/medium", "fallback", "low-confidence"]);
  assert.equal((await choose(rowOf(), routeReply(at("sonnet/high", 0.69)))).routed.route, "sonnet/medium", "the boundary: 0.69 is under it");
  const taken = await choose(rowOf(), routeReply(at("sonnet/high", 0.7)));
  assert.deepEqual([taken.routed.route, taken.routed.via, taken.picked?.because], ["sonnet/high", "jev", "jev"]);
  // And the cheaper pick over a Sonnet/high fallback is the mirror: 0.5 takes it where the dearer would not.
  assert.equal((await choose(FOUR_FILES(), routeReply(at("sonnet/medium", 0.5)))).routed.route, "sonnet/medium");
});

test("#4904 the thresholds are config values: a declaration's 0.8 for dearer and 0.3 for cheaper moves where each pick stands", async () => {
  const routing = { ...CHOICE, cheaperMinP: 0.3, dearerMinP: 0.8 };
  assert.equal((await choose(rowOf(), routeReply(at("haiku/high", 0.45)), { routing })).routed.route, "haiku/high");
  assert.equal((await choose(rowOf(), routeReply(at("sonnet/high", 0.75)), { routing })).routed.route, "sonnet/medium");
  assert.equal((await choose(rowOf(), routeReply(at("sonnet/high", 0.8)), { routing })).routed.route, "sonnet/high");
});

test("#4904 DONE-WHEN 1: an off-list answer is the fallback with the reason invalid-option -- a route nobody configured, and a configured one this project left out", async () => {
  const off = await choose(rowOf(), { answers: { ...reply({}).answers, route: { type: "choice", choice: "opus/max", confidence: 0.99, probabilities: { "opus/max": 0.99 } } } });
  assert.deepEqual([off.routed.route, off.routed.via, off.picked?.because, off.picked?.pick], ["sonnet/medium", "fallback", "invalid-option", null]);
  const noHaiku = { ...CHOICE, routes: ["sonnet/medium", "sonnet/high"] as RoutingDeclaration["routes"] };
  const left = await choose(rowOf(), routeReply(at("haiku/high", 0.9)), { routing: noHaiku });
  assert.deepEqual([left.routed.route, left.picked?.because], ["sonnet/medium", "invalid-option"], "Haiku is not an option of this project's question");
  assert.deepEqual(Object.keys((left.r.sent[0] as { questions: { route: { criteria: object } } }).questions.route.criteria), ["sonnet/medium", "sonnet/high"]);
  assert.equal((await choose(rowOf(), routeReply(at("haiku/high", 0.9)))).routed.route, "haiku/high", "the control: the same reply under all three routes is taken");
});

test("#4904 DONE-WHEN 1: no provider leaves the fallback unchanged, in either mode, and the provider is asked zero times", async () => {
  for (const routing of [CHOICE, ABSENT_ROUTING]) {
    const off = rig();
    const routed = await routeEngineer(FOUR_FILES(), { ...off.deps, routing });
    assert.deepEqual([routed.route, routed.via, routed.profile], ["sonnet/high", "fallback", null], routing.question);
    assert.equal(off.calls(), 0);
    assert.equal(outcomeOf(off), "route sonnet/high window 200k via fallback (no triage provider is declared)" + (routing.question === "choice" ? " [pick none; ran sonnet/high; because fallback; P not given; 0ms]" : ""));
  }
  const failed = rig({ triage: JEV, switches: ON, throws: true });
  assert.equal((await routeEngineer(rowOf(), { ...failed.deps, routing: CHOICE })).route, "sonnet/medium", "a failed call is the fallback, never Haiku");
});

test("#4904 DONE-WHEN 1: tier:sonnet-high beats Jev, tier:sonnet-medium too, and the provider is not asked; two labels give the dearer", async () => {
  const r = rig({ triage: JEV, switches: ON, body: routeReply(at("haiku/high", 0.95)) });
  const deps = { ...r.deps, routing: CHOICE };
  const high = await routeEngineer(rowOf({ labels: ["ready", "tier:sonnet-high"] }), deps);
  assert.deepEqual([high.route, high.via, high.profile], ["sonnet/high", "override", null]);
  const medium = await routeEngineer(FOUR_FILES(), { ...deps }).then(() => routeEngineer({ ...FOUR_FILES(), labels: ["tier:sonnet-medium"] }, deps));
  assert.deepEqual([medium.route, medium.via, medium.profile?.effort], ["sonnet/medium", "override", "medium"]);
  const both = await routeEngineer(rowOf({ labels: ["tier:haiku", "tier:sonnet-high"] }), deps);
  assert.equal(both.route, "sonnet/high");
  assert.equal(r.calls(), 1, "only the unlabelled FOUR_FILES row was asked");
  assert.equal((await routeEngineer(rowOf({ labels: ["tier:haiku"] }), deps)).route, "haiku/high", "tier:haiku is still every project's");
  // The control: a label for a route this project did not configure is no label.
  const noHaiku = { ...CHOICE, routes: ["sonnet/medium", "sonnet/high"] as RoutingDeclaration["routes"] };
  const ignored = await routeEngineer(rowOf({ labels: ["tier:haiku"] }), { ...r.deps, routing: noHaiku });
  assert.notEqual(ignored.via, "override");
});

test("#4904 DONE-WHEN 1: a refused row is not lowered by a label -- tier:sonnet-medium, tier:sonnet-high and tier:haiku each give Sonnet/high with the refusal, and the provider is not asked", async () => {
  const r = rig({ triage: JEV, switches: ON, body: routeReply(at("haiku/high", 0.95)) });
  const refused: Partial<RouteRow>[] = [{ labels: ["lane:ceo"] }, { labels: ["needs:chairman"] }, { body: bodyOf({ region: [".github/workflows/ci.yml"] }) }, { body: bodyOf({ acceptance: null }) }];
  for (const label of ["tier:sonnet-medium", "tier:sonnet-high", "tier:haiku"]) {
    for (const over of refused) {
      const row = rowOf({ ...over, labels: [...(over.labels ?? []), label] });
      const routed = await routeEngineer(row, { ...r.deps, routing: CHOICE });
      assert.deepEqual([routed.route, routed.via, routed.profile], ["sonnet/high", "override", null], `${label} ${JSON.stringify(over)}`);
      assert.match(routed.reason!, new RegExp(`^${label} was refused`));
    }
  }
  assert.equal(r.calls(), 0);
});

test("#4904 DONE-WHEN 1: `traits` mode reproduces today's routes -- the four decide, no route question is sent, and an absent block is the same", async () => {
  const bodies = [reply({}), reply({ mechanical: "no", subsystems: "no", score: 3 }), reply({ mechanical: "no", subsystems: "no", score: 3, low: "subsystems" }), reply({ mechanical: "no", subsystems: "yes", score: 3 }), reply({ debugging: "yes" })];
  const routes: Route[] = [];
  for (const body of bodies) {
    const absent = rig({ triage: JEV, switches: ON, body });
    const traits = rig({ triage: JEV, switches: ON, body });
    const a = await routeEngineer(rowOf(), { ...absent.deps, routing: ABSENT_ROUTING });
    const t = await routeEngineer(rowOf(), { ...traits.deps, routing: { ...CHOICE, question: "traits" } });
    assert.deepEqual(t, a);
    assert.equal(outcomeOf(traits), outcomeOf(absent));
    assert.ok(!outcomeOf(traits).includes("[pick"), "a traits line has no route bracket");
    assert.ok(!("route" in (traits.sent[0] as { questions: object }).questions));
    routes.push(t.route);
  }
  assert.deepEqual(routes, ["haiku/high", "haiku/high", "sonnet/medium", "sonnet/high", "sonnet/high"]);
  // A project that dropped Haiku from its routes moves a composed Haiku UP to the next configured route, never down.
  const noHaiku = { ...ABSENT_ROUTING, routes: ["sonnet/medium", "sonnet/high"] as RoutingDeclaration["routes"] };
  assert.equal((await routeEngineer(rowOf(), { ...rig({ triage: JEV, switches: ON }).deps, routing: noHaiku })).route, "sonnet/medium");
});

test("#4904 in `choice` mode the four are still ASKED and still LOGGED, and no longer decide: four clean answers do not hold a Sonnet/high pick, and four contrary ones do not hold a Haiku pick", async () => {
  const dear = await choose(rowOf(), routeReply(at("sonnet/high", 0.9)));
  assert.equal(dear.routed.route, "sonnet/high", "the four say Haiku and the route question says Sonnet/high");
  const cheap = await choose(rowOf(), routeReply(at("haiku/high", 0.9), { debugging: "yes", subsystems: "yes" }));
  assert.equal(cheap.routed.route, "haiku/high", "the four say Sonnet/high and the route question says Haiku");
  const sent = (cheap.r.sent[0] as { questions: Record<string, unknown> }).questions;
  assert.deepEqual(Object.keys(sent), ["mechanical", "subsystems", "debugging", "score", "route"], "one call, the four and the route");
  const request = cheap.r.log().find((l) => l.answers !== undefined);
  assert.deepEqual(Object.keys(request.answers), ["mechanical", "subsystems", "debugging", "score", "route"], "the request line keeps every answer for route-accuracy");
  assert.equal(cheap.r.calls(), 1);
});

test("#4904 DONE-WHEN 2: a decision line carries every route's probability, the pick, the route that ran, the reason and the call's duration -- and `route-outcome`'s reader gets them back", async () => {
  const r = rig({ triage: JEV, switches: ON, body: routeReply({ "haiku/high": 0.4, "sonnet/medium": 0.25, "sonnet/high": 0.35 }) });
  let clock = 1_000;
  r.deps.now = () => { const t = clock; clock += 40; return t; };
  const routed = await routeEngineer(rowOf(), { ...r.deps, routing: CHOICE });
  assert.equal(routed.route, "sonnet/medium", "0.4 is under the 0.5 a cheaper pick needs");
  const line = outcomeOf(r);
  assert.match(line, /\[pick haiku\/high; ran sonnet\/medium; because low-confidence; P haiku\/high=0\.400 sonnet\/medium=0\.250 sonnet\/high=0\.350; \d+ms\]$/);
  assert.ok(!line.includes("[fallback would be"), "a route the fallback took is not a comparison: the cost guard counts jev lines only");
  const read = pickedOf(line);
  assert.deepEqual([read?.pick, read?.ran, read?.because, read?.probabilities], ["haiku/high", "sonnet/medium", "low-confidence", { "haiku/high": 0.4, "sonnet/medium": 0.25, "sonnet/high": 0.35 }]);
  assert.ok((read?.ms ?? 0) >= 40, "the call's duration, from the injected clock");
  assert.equal(pickedOf("route sonnet/medium window 200k via fallback (x)"), null, "a line from before #4904 has no bracket");
  // The probabilities are also on the request line, as the provider gave them.
  const request = r.log().find((l) => l.answers !== undefined);
  assert.deepEqual(request.answers.route.probabilities, { "haiku/high": 0.4, "sonnet/medium": 0.25, "sonnet/high": 0.35 });
});

test("#4904 every reason is on the line: jev, low-confidence, invalid-option, override, refused and fallback; and the cost guard still reads the line", async () => {
  const reasons: string[] = [];
  const outcomes: string[] = [];
  const cases: [Partial<RouteRow>, unknown][] = [
    [{}, routeReply(at("sonnet/medium", 0.9))], [{}, routeReply(at("sonnet/high", 0.55))],
    [{}, { answers: { ...reply({}).answers, route: choice("maybe") } }], [{ labels: ["tier:sonnet-high"] }, undefined],
    [{ labels: ["lane:ceo"] }, undefined],
  ];
  for (const [over, body] of cases) {
    const { r, picked } = await choose(rowOf(over), body ?? reply({}));
    reasons.push(picked!.because);
    outcomes.push(outcomeOf(r));
  }
  const failed = rig({ triage: JEV, switches: ON, throws: true });
  await routeEngineer(rowOf(), { ...failed.deps, routing: CHOICE });
  reasons.push(pickedOf(outcomeOf(failed))!.because);
  assert.deepEqual(reasons, ["jev", "low-confidence", "invalid-option", "override", "refused", "fallback"]);
  // `[fallback would be X]` is still LAST on a provider line, which is what `routeCostReading` anchors on: twenty Sonnet/high picks over a Sonnet/medium fallback still read as costlier.
  const lines = Array.from({ length: 20 }, (_, i) => ({ use: "model-routing", id: `row-${i}`, at: i, outcome: outcomes[0].replace("route sonnet/medium", "route sonnet/high").replace("pick sonnet/medium", "pick sonnet/high") }));
  assert.deepEqual(routeCostReading(lines), { kind: "read", compared: 20, providerMean: 3, fallbackMean: 2, costlier: true });
});

test("#4904 the route question is POSTED valid: an option per configured route of `what`, `signals`, `not_for` and 2-3 examples, the cheapest-route instruction, and the API accepts the request", async () => {
  const { r, routed } = await choose(rowOf(), routeReply(at("haiku/high", 0.9)), { validates: true });
  assert.equal(routed.via, "jev", "the API's shape check passed, so the reply was read and not an HTTP 422 fallback");
  const q = (r.sent[0] as { questions: { route: { type: string; instructions: string; criteria: Record<string, { what: string; signals: string[]; not_for: string; examples: string[] }> } } }).questions.route;
  assert.equal(q.type, "choice");
  assert.match(q.instructions, /cheapest route that finishes this row in one pass, with no move up to a stronger route/);
  assert.deepEqual(Object.keys(q.criteria), ["haiku/high", "sonnet/medium", "sonnet/high"]);
  for (const [route, option] of Object.entries(q.criteria)) {
    assert.ok(option.what.length > 0 && option.not_for.length > 0 && option.signals.length > 0, route);
    assert.ok(option.examples.length >= 2 && option.examples.length <= 3, `${route}: ${option.examples.length} examples`);
    assert.ok(option.examples.every((e) => /#\d+/.test(e)), `${route}: every example names a row of ours`);
  }
  // A declaration's guidance replaces a route's whole entry and leaves the others.
  const own = { what: "w", signals: ["s"], notFor: "n", examples: ["#1 e", "#2 f"] };
  const custom = routeQuestion({ routes: ["sonnet/medium", "sonnet/high"], guidance: { "sonnet/high": own } }, "sonnet/medium");
  assert.deepEqual((custom as { criteria: Record<string, unknown> }).criteria["sonnet/high"], { what: "w", signals: ["s"], not_for: "n", examples: ["#1 e", "#2 f"] });
  assert.deepEqual((custom as { criteria: Record<string, unknown> }).criteria["sonnet/medium"], { what: ROUTE_DATA["sonnet/medium"].what, signals: ROUTE_DATA["sonnet/medium"].signals, not_for: ROUTE_DATA["sonnet/medium"].notFor, examples: ROUTE_DATA["sonnet/medium"].examples });
});

test("#4904 a Haiku pick the switch refuses is the fallback it would have had -- not Sonnet/high -- and the line says Haiku was refused; acceptPick is pure on its answer", async () => {
  const off = await choose(rowOf(), routeReply(at("haiku/high", 0.9)), { haikuSwitch: '{ "enabled": false }' });
  assert.deepEqual([off.routed.route, off.routed.via, off.picked?.because], ["sonnet/medium", "fallback", "fallback"]);
  assert.match(off.routed.reason!, /Haiku was refused/);
  const answer: Answer = { value: "sonnet/high", confidence: 0.5, probabilities: at("sonnet/high", 0.7), fellBack: false };
  assert.deepEqual(acceptPick(answer, "sonnet/medium", CHOICE), { route: "sonnet/high", via: "jev", because: "jev", why: acceptPick(answer, "sonnet/medium", CHOICE).why });
  assert.equal(acceptPick({ ...answer, probabilities: undefined }, "sonnet/medium", CHOICE).because, "low-confidence", "a pick with no distribution moves nothing");
  assert.equal(acceptPick({ ...answer, confidence: undefined }, "sonnet/medium", CHOICE).because, "invalid-option");
});

test("#4904 with #756: another tracker's row is asked and logged under its OWN id in `choice` mode -- the route question's request line and the outcome line both read row-<key>-<n>", async () => {
  const keyed = await choose(rowOf({ key: "agent-org" }), routeReply(at("haiku/high", 0.8)));
  const ids = [...new Set(keyed.r.log().filter((line: { use?: string }) => line.use === "model-routing").map((line: { id: string }) => line.id))];
  assert.deepEqual(ids, ["row-agent-org-4999"], "no line was filed under the first tracker's row-4999");
  assert.equal(keyed.routed.route, "haiku/high");
  // The control: the first tracker's own row keeps row-<n>.
  const own = await choose(rowOf(), routeReply(at("haiku/high", 0.8)));
  assert.deepEqual([...new Set(own.r.log().filter((line: { use?: string }) => line.use === "model-routing").map((line: { id: string }) => line.id))], ["row-4999"]);
});

// --- #4990: the provider is asked ONCE per row body, and a reused start is one short line ---
const DAY_MS = 86_400_000;

test("#4990: a second start of the same unchanged row asks the provider zero times, runs the first start's route, and logs `route reused` that the confidence reading does not count", async () => {
  for (const routing of [ABSENT_ROUTING, CHOICE]) {
    const r = rig({ triage: JEV, switches: ON, body: routeReply(at("sonnet/high", 0.9)) });
    const first = await routeEngineer(rowOf(), { ...r.deps, routing });
    const before = confidenceReading(r.log(), { now: 1_000, windowMs: DAY_MS });
    const second = await routeEngineer(rowOf(), { ...r.deps, routing });
    assert.equal(r.calls(), 1, `${routing.question}: the first start asked, the second did not`);
    assert.deepEqual(second, first, `${routing.question}: the reused route is the logged one`);
    assert.equal(outcomeOf(r), "route reused", routing.question);
    assert.deepEqual(confidenceReading(r.log(), { now: 1_000, windowMs: DAY_MS }), before, `${routing.question}: the reused line counts for nothing`);
  }
});

test("#4990: a changed label or a changed Region asks again, and a start the provider did not answer is never remembered", async () => {
  const r = rig({ triage: JEV, switches: ON });
  await routeEngineer(rowOf(), r.deps);
  await routeEngineer(rowOf({ labels: ["ready", "area:docs"] }), r.deps);
  assert.equal(r.calls(), 2, "a changed label asks again");
  await routeEngineer(rowOf({ labels: ["ready", "area:docs"], body: bodyOf({ region: ["src/a.ts", "src/b.ts", "src/c.ts"] }) }), r.deps);
  assert.equal(r.calls(), 3, "a changed Region asks again");
  const failing = rig({ triage: JEV, switches: ON, throws: true });
  await routeEngineer(rowOf(), failing.deps);
  await routeEngineer(rowOf(), failing.deps);
  assert.equal(failing.calls(), 2, "the control: a call that failed is the fallback, and the next start asks again");
});

// --- Haiku by default, Sonnet on evidence (a11ign#5110) ---

const DEFAULTING = JSON.stringify({ "model-routing": true, "routing.haikuDefault": true });
const TESTS_FIRST = (): RouteRow => rowOf({ body: bodyOf({ region: ["src/a.ts", "src/a.test.ts"] }) });
const NO_TEST_FILE = (): RouteRow => rowOf({ body: bodyOf({ region: ["src/a.ts", "src/b.ts"] }) });
async function chooseDefaulting(row: RouteRow, body: unknown, over: { switches?: string; routing?: RoutingDeclaration } = {}) {
  const r = rig({ triage: JEV, switches: over.switches ?? DEFAULTING, body });
  return { routed: await routeEngineer(row, { ...r.deps, routing: over.routing ?? CHOICE }), r };
}

test("#5110 DONE-WHEN 1: a Tests-first row with P(sonnet/high)=0.6 routes Haiku, and with 0.75 it routes Sonnet -- the veto bar is 0.7, with the flag on", async () => {
  const under = await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.6)));
  assert.deepEqual([under.routed.route, under.routed.profile?.model, under.routed.picked?.because], ["haiku/high", HAIKU_MODEL_ID, "haiku-default"]);
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.69)))).routed.route, "haiku/high", "the boundary: 0.69 is under it");
  const over = await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.75)));
  assert.deepEqual([over.routed.route, over.routed.via, over.routed.picked?.because], ["sonnet/high", "jev", "jev"]);
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.7)))).routed.route, "sonnet/high", "0.7 vetoes");
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/medium", 0.8)))).routed.route, "sonnet/medium", "any Sonnet route vetoes, not only the dearest");
});

test("#5208: the veto bar is the project's `routing.sonnetVetoMinP` -- at 0.85 a Sonnet pick at P 0.8 does not veto Haiku, at 0.85 it does, and absent it is 0.7", async () => {
  const strict = { ...CHOICE, sonnetVetoMinP: 0.85 };
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.8)), { routing: strict })).routed.route, "haiku/high", "0.8 is under a 0.85 bar");
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.85)), { routing: strict })).routed.route, "sonnet/high", "the boundary: 0.85 vetoes");
  assert.equal((await chooseDefaulting(TESTS_FIRST(), routeReply(at("sonnet/high", 0.8)))).routed.route, "sonnet/high", "the control: absent the key, 0.8 clears 0.7");
});

test("#5110 DONE-WHEN 1: a Tests-first row with no usable pick routes Haiku -- the provider failed, answered off-list, or gave no probabilities", async () => {
  const failed = rig({ triage: JEV, switches: DEFAULTING, throws: true });
  assert.equal((await routeEngineer(TESTS_FIRST(), { ...failed.deps, routing: CHOICE })).route, "haiku/high");
  const off = await chooseDefaulting(TESTS_FIRST(), { answers: { ...reply({}).answers, route: { type: "choice", choice: "opus/max", confidence: 0.99, probabilities: { "opus/max": 0.99 } } } });
  assert.equal(off.routed.route, "haiku/high");
  const none = rig({ switches: DEFAULTING });
  assert.equal((await routeEngineer(TESTS_FIRST(), { ...none.deps, routing: CHOICE })).route, "haiku/high", "no provider declared");
});

test("#5110 the flag OFF is today's route, and a row that is not Tests-first or is refused is never defaulted", async () => {
  const pick = routeReply(at("sonnet/high", 0.6));
  const off = await chooseDefaulting(TESTS_FIRST(), pick, { switches: ON });
  assert.deepEqual([off.routed.route, off.routed.via, off.routed.picked?.because], ["sonnet/medium", "fallback", "low-confidence"], "the control: the same reply with the flag off");
  assert.equal((await chooseDefaulting(NO_TEST_FILE(), pick)).routed.route, "sonnet/medium", "no test file in the Region is not Tests-first");
  for (const over of [{ labels: ["lane:ceo"] }, { labels: ["needs:chairman"] }, { body: bodyOf({ region: [".github/workflows/ci.yml", "a.test.ts"] }) }, { body: bodyOf({ region: ["a.test.ts"], acceptance: null }) }]) {
    const refused = await chooseDefaulting(rowOf(over), pick);
    assert.deepEqual([refused.routed.route, refused.routed.via], ["sonnet/high", "refused"], JSON.stringify(over));
  }
  const noHaiku = { ...CHOICE, routes: ["sonnet/medium", "sonnet/high"] as RoutingDeclaration["routes"] };
  assert.equal((await chooseDefaulting(TESTS_FIRST(), pick, { routing: noHaiku })).routed.route, "sonnet/medium", "a project without Haiku has nothing to default to");
});

test("#5110 isTestsFirst reads the Region's files: .test., .spec., test_ and _test names, and not a name that merely contains `test`", () => {
  const first = (...region: string[]) => isTestsFirst({ body: bodyOf({ region }) });
  assert.deepEqual([first("a.test.ts"), first("src/x.spec.mjs"), first("tests/test_x.py"), first("x_test.go")], [true, true, true, true]);
  assert.deepEqual([first("src/testing.ts"), first("src/contest.ts"), first("a.ts")], [false, false, false]);
});

const armLine = (session: string, row: number) => JSON.stringify({ kind: "arm", at: 1, session, row, model: HAIKU_MODEL_ID });
const redHead = (row: number, head: string) => JSON.stringify({ kind: "continuation", at: 2, claim: `row-${row}`, cause: "pr-checks-failing", causeKey: `pr-checks-failing/${row}/${head}` });

test("#5110 DONE-WHEN 1: with the flag, three failing heads move a Haiku start to a fresh Sonnet session, and two do not; off, two do", () => {
  const two = [armLine("worker-1", 1), redHead(1, "a"), redHead(1, "b")].join("\n");
  const three = [two, redHead(1, "c")].join("\n");
  assert.deepEqual(escalationsNow(two, ["worker-1"], () => null, { on: true }), [], "two failing heads are not three");
  const moved = escalationsNow(three, ["worker-1"], () => null, { on: true });
  assert.deepEqual(moved.map((e) => [e.row, e.session]), [[1, "worker-1"]]);
  assert.match(moved[0].reason, /failed CI 3 times \(the cap is 3\)/);
  assert.equal(escalationsNow(two, ["worker-1"], () => null).length, 1, "the control: with the flag off the cap stays 2");
});

test("#5110 DONE-WHEN 1: with the flag, a refusal moves a Haiku start at once, once per row, and never a Sonnet one", () => {
  const record = armLine("worker-1", 1);
  const refused = () => true;
  assert.match(escalationsNow(record, ["worker-1"], () => null, { on: true, refused })[0].reason, /refused/);
  assert.deepEqual(escalationsNow(record, ["worker-1"], () => null, { on: false, refused }), [], "off, a refusal is not evidence");
  assert.deepEqual(escalationsNow(record, ["worker-1"], () => null, { on: true, refused: () => false }), []);
  const done = [record, JSON.stringify({ kind: "escalation", at: 3, row: 1, session: "worker-1", reason: "x" })].join("\n");
  assert.deepEqual(escalationsNow(done, ["worker-1"], () => null, { on: true, refused }), [], "once per row");
  const sonnet = JSON.stringify({ kind: "arm", at: 1, session: "worker-2", row: 2, model: "claude-sonnet-5-5" });
  assert.deepEqual(escalationsNow(sonnet, ["worker-2"], () => null, { on: true, refused }), []);
});

test("#5110 instanceRefused reads the named session's stop_reason: a refusal is true, an ordinary end is false, and another session's refusal is not this one's", () => {
  const dir = tmpDir("refused-");
  const project = join(dir, "p");
  mkdirSync(project);
  const turn = (stop: string) => JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } } });
  const transcript = (who: string, stop: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${who}\`` } })}\n${turn(stop)}\n`;
  const reader = { readText: (file: string) => readFileSync(file, "utf8"), readHead: (file: string) => readFileSync(file, "utf8") };
  writeFileSync(join(project, "a.jsonl"), transcript("worker-77", "refusal"));
  writeFileSync(join(project, "b.jsonl"), transcript("worker-78", "end_turn"));
  assert.equal(instanceRefused("worker-77", dir, reader), true);
  assert.equal(instanceRefused("worker-78", dir, reader), false, "the control: an ordinary end of turn");
  assert.equal(instanceRefused("worker-none", dir, reader), false, "no transcript names it");
  writeFileSync(join(project, "c.jsonl"), `${transcript("worker-79", "refusal")}${turn("end_turn")}\n`);
  assert.equal(instanceRefused("worker-79", dir, reader), false, "a refusal earlier, then a normal end: the latest response decides");
  writeFileSync(join(project, "d.jsonl"), `${transcript("worker-80", "end_turn")}${turn("refusal")}\n`);
  assert.equal(instanceRefused("worker-80", dir, reader), true, "a normal end earlier, then a refusal: refused now");
});
