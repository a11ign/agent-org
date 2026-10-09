// #4629: the engineer route. A fake `fetch`, a fake key, a fixture row and a temp directory only: no network, no real key, no corpus.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the route beside the row one answer away from it, and the provider-on case beside the four ways the provider is not asked.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decisionLogPathFrom, decisionSwitchesPath, MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import { composeRoute, fallbackRoute, recordRouteOutcome, routeEngineer, routeState, QUESTIONS, type Answers, type RouteRow } from "./engineer-route.ts";
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
const CLEAN_HAIKU = { mechanical: "yes", subsystems: "no", debugging: "no", covered: "yes", score: 2 };
/** The provider's reply for a set of answers; `low` names the one question answered under the floor. */
function reply(given: Given) {
  const base = { ...CLEAN_HAIKU, ...given };
  const answers = Object.fromEntries((Object.keys(QUESTIONS) as (keyof Answers)[]).map((name) => {
    const confidence = name === given.low ? 0.5 : given.confidence ?? 0.95;
    return [name, name === "score" ? { type: "score", score: base.score, confidence } : { type: "choice", choice: base[name], probabilities: {}, confidence }];
  }));
  return { answers };
}

function rig(opts: { triage?: unknown; switches?: string; body?: unknown; haikuSwitch?: string; throws?: boolean } = {}) {
  const dir = tmpDir("engineer-route-");
  if (opts.switches !== undefined) {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(decisionSwitchesPath(dir), opts.switches);
  }
  const haikuSwitch = join(dir, "haiku-tier.json");
  writeFileSync(haikuSwitch, opts.haikuSwitch ?? '{ "enabled": true }');
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    if (opts.throws) throw new Error("connection refused");
    return { ok: true, status: 200, json: async () => opts.body ?? reply({}) };
  }) as unknown as typeof fetch;
  const logPath = decisionLogPathFrom(join(dir, "state", "wake-ledger"));
  const reads: string[] = [];
  const deps: DecisionDeps & { haikuSwitchPath: string } = {
    host: withTriage(opts.triage), fetch: fn, state: freshState(), timeoutMs: 50, diagnostic: () => {}, switchesPath: decisionSwitchesPath(dir), logPath, now: () => 1_000,
    readKey: (path) => { reads.push(path); return "tsk-FAKE"; }, haikuSwitchPath: haikuSwitch,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { deps, calls: () => calls, reads, log, logPath };
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

test("every route is a decision-log line, in the fallback, override, refused and provider cases, and the outcome lands beside it", async () => {
  const r = rig({ triage: JEV, switches: ON });
  const off = rig();
  await routeEngineer(rowOf({ number: 1 }), r.deps);
  await routeEngineer(rowOf({ number: 2, labels: ["tier:haiku"] }), r.deps);
  await routeEngineer(rowOf({ number: 3, labels: ["lane:ceo"] }), r.deps);
  await routeEngineer(rowOf({ number: 4 }), off.deps);
  const routes = (lines: { id?: string; outcome?: string }[]) => lines.filter((l) => l.outcome !== undefined).map((l) => [l.id, l.outcome]);
  assert.deepEqual(routes(r.log()), [["row-1", "route haiku/high via jev"], ["row-2", "route haiku/high via override"], ["row-3", "route sonnet/high via refused"]]);
  assert.deepEqual(routes(off.log()), [["row-4", "route sonnet/medium via fallback"]]);
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
