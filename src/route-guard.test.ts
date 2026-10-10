// agent-org#724: the route readings and the first-pass guard over FIXTURE decision-log lines and fixture rows. No network, no live log, no `gh`, no trace store: the lines are written here in
// the shape `engineer-route.ts`'s `recordOutcome` writes, and the rows' results are handed in. `engineer-route.ts` and `haiku-tier-report.ts` are NOT imported (they resolve the host's checkout
// on import and this file must pass with `AGENT_ORG_HOST` unset): the one thing read from the former is its source text, to pin the constants a breach names.
// no-token: none -- the token is a fixture string and no process is started
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURE_LEDGER_FILE, parseFailureLedger, recordFailures } from "./failure-ledger.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";
import { createFakeProvider } from "./messaging/fake-provider.ts";
import { createLedger } from "./messaging/ledger.ts";
import type { Delivery } from "./decision-confidence-post.ts";
import {
  ROUTE_FIRST_PASS_GAP, ROUTE_FIRST_PASS_GAP_POINTS, TUNING, firstPassByRoute, formatRouteGuard, guardEvents, guardVerdicts, postRouteGuard, providerRoutedRows,
  renderRouteGuardPost, routeShares, routeStartsIn, type Route, type RowResult,
} from "./route-guard.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-10T12:00:00Z");
/** The report's floor for a readable rate; handed in, as the CLI hands in the report's own `MIN_RATE_ROWS`. */
const MIN_ROWS = 8;
const WINDOW = { now: NOW, windowMs: DAY };
const scratch = tmpDirForFile("route-guard-");
let nextFile = 0;
const fresh = (name: string) => join(scratch, `${name}-${nextFile += 1}`);

// --- fixtures: one decision-log line per route, as `recordOutcome` writes it ---
const outcome = (row: number, route: string, via: string, at = NOW - HOUR, window = "200k") =>
  ({ use: "model-routing", id: `row-${row}`, outcome: `route ${route} window ${window} via ${via} (a reason)`, at });
const provider = (row: number, route: Route, at?: number) => outcome(row, route, "jev", at);

test("the starts by route: the provider's routes with shares, the fallback, refused and override starts apart, and the parts sum to the starts read", () => {
  const lines = [
    provider(1, "haiku/high"), provider(2, "sonnet/medium"), provider(3, "sonnet/medium"), provider(4, "sonnet/high"),
    outcome(5, "sonnet/medium", "fallback"), outcome(6, "sonnet/high", "refused"), outcome(7, "haiku/high", "override"),
    outcome(8, "opus/max", "jev"), outcome(9, "sonnet/high", "magic"),
  ];
  const reading = routeShares(lines, WINDOW);
  assert.equal(reading.starts, 9);
  assert.deepEqual(reading.provider, { "haiku/high": 1, "sonnet/medium": 2, "sonnet/high": 1 });
  assert.equal(reading.providerStarts, 4);
  assert.deepEqual(reading.apart, { fallback: 1, refused: 1, override: 1, unrecognised: 2 });
  assert.equal(reading.providerStarts + Object.values(reading.apart).reduce((a, b) => a + b, 0), reading.starts, "nothing read is dropped from the sum");
  assert.deepEqual(reading.shares, { "haiku/high": 0.25, "sonnet/medium": 0.5, "sonnet/high": 0.25 });
  assert.equal(Object.values(reading.shares ?? {}).reduce((a, b) => a + b, 0), 1);
});

test("a window holds the lines in it; a log line that is not a route is not a start; none decided by the provider is no share, not a zero", () => {
  const lines = [provider(1, "sonnet/high", NOW - 2 * DAY), provider(2, "sonnet/high", NOW - HOUR), provider(3, "sonnet/high", NOW + HOUR),
    { use: "model-routing", id: "row-2", outcome: "merged-first-pass", at: NOW }, { use: "model-routing", id: "row-2", outcome: "window too small: 3 compactions at 200k", at: NOW },
    { use: "wake-triage", id: "row-2", outcome: "route sonnet/high window 200k via jev", at: NOW }, "half a line", null];
  const reading = routeShares(lines, WINDOW);
  assert.equal(reading.starts, 1, "the old line, the future line, the verdicts, the other use and the junk are all out");
  assert.equal(reading.rows, 1);
  const none = routeShares([outcome(1, "sonnet/high", "refused")], WINDOW);
  assert.equal(none.shares, null);
  assert.equal(none.starts, 1);
});

test("a request line is not a start, and an outcome's window note, with or without its parenthesis, does not hide its route or its via", () => {
  const lines = [{ use: "model-routing", id: "row-4", answers: { score: {} }, at: NOW - 3 * HOUR },
    { use: "model-routing", id: "row-4", outcome: "route haiku/high window 100k (the Region names files=1 repositories=1; held to the ceiling of haiku) via jev (the provider's probabilities: ...)", at: NOW - 3 * HOUR + 5 },
    { use: "model-routing", id: "row-5", outcome: "route sonnet/high window 200k via fallback (the provider gave no answer)", at: NOW - 2 * HOUR },
    { use: "model-routing", id: "not-a-row", outcome: "route sonnet/high window 200k via jev", at: NOW }];
  assert.deepEqual(routeStartsIn(lines), [{ row: 4, at: NOW - 3 * HOUR + 5, route: "haiku/high", via: "jev" }, { row: 5, at: NOW - 2 * HOUR, route: "sonnet/high", via: "fallback" }]);
});

test("a row routed twice is one row under its LAST route, and a row whose last line is not the provider's is none of the provider's", () => {
  const lines = [provider(1, "sonnet/high", NOW - 5 * HOUR), provider(1, "sonnet/medium", NOW - HOUR), provider(2, "haiku/high", NOW - 4 * HOUR), outcome(2, "sonnet/high", "fallback", NOW - HOUR), provider(3, "sonnet/high")];
  const routed = providerRoutedRows(lines, WINDOW);
  assert.deepEqual(routed.map((start) => [start.row, start.route]).sort(), [[1, "sonnet/medium"], [3, "sonnet/high"]]);
});

// --- the guard ---
const merged = (rejections = 0): RowResult => ({ merged: true, rejections });
/** `n` rows of one route numbered from `from`, `firstPass` of them merged at once and the rest after a rejection. */
function tierRows(route: Route, from: number, n: number, firstPass: number) {
  const starts = Array.from({ length: n }, (_, i) => ({ row: from + i, at: NOW - HOUR, route, via: "jev" }));
  const results = new Map<number, RowResult>(starts.map((start, i) => [start.row, merged(i < firstPass ? 0 : 1)]));
  return { starts, results };
}
function reading(parts: ReturnType<typeof tierRows>[]) {
  const starts = parts.flatMap((part) => part.starts);
  const results = new Map(parts.flatMap((part) => [...part.results]));
  return firstPassByRoute(starts, results, MIN_ROWS);
}
const verdictOf = (tiers: ReturnType<typeof reading>, route: string) => guardVerdicts(tiers, MIN_ROWS).find((v) => v.route === route);

test("a lower tier 6 points under Sonnet/high's files one incident, and 4 points under files none", () => {
  const over = guardVerdicts(reading([tierRows("sonnet/high", 1, 50, 50), tierRows("sonnet/medium", 100, 50, 47)]), MIN_ROWS);
  const events = guardEvents(over);
  assert.equal(events.length, 1, "6 points under: one incident");
  assert.equal(events[0].classKey, ROUTE_FIRST_PASS_GAP);
  assert.match(events[0].ref, /^sonnet\/medium /);
  const under = guardVerdicts(reading([tierRows("sonnet/high", 1, 50, 50), tierRows("sonnet/medium", 100, 50, 48)]), MIN_ROWS);
  assert.deepEqual(guardEvents(under), [], "4 points under: none");
  const sixPoints = over.find((v) => v.route === "sonnet/medium");
  assert.ok(sixPoints?.state === "breach" && Math.round(sixPoints.gapPoints) === 6, JSON.stringify(sixPoints));
});

test("exactly 5 points under is not MORE than 5, and 5 points the other side of it is, on rates a float would get wrong", () => {
  // 19/20 against 20/20 is exactly 5 points; the float of (1 - 0.95) * 100 is 5.000000000000004, which would breach.
  const exact = reading([tierRows("sonnet/high", 1, 20, 20), tierRows("haiku/high", 100, 20, 19)]);
  assert.equal(ROUTE_FIRST_PASS_GAP_POINTS, 5);
  assert.equal(verdictOf(exact, "haiku/high")?.state, "ok");
  assert.ok((1 - 19 / 20) * 100 > ROUTE_FIRST_PASS_GAP_POINTS, "positive control: the float form of the same gap IS over 5, so the integer comparison is what held");
  const past = reading([tierRows("sonnet/high", 1, 20, 20), tierRows("haiku/high", 100, 20, 18)]);
  assert.equal(verdictOf(past, "haiku/high")?.state, "breach");
});

test("a tier under the floor of merged rows is not readable and files none, whatever its rate; so is a baseline under it", () => {
  const few = reading([tierRows("sonnet/high", 1, 50, 50), tierRows("haiku/high", 100, MIN_ROWS - 1, 0)]);
  const haiku = verdictOf(few, "haiku/high");
  assert.ok(haiku?.state === "not-readable" && /7 merged rows, under 8/.test(haiku.why), JSON.stringify(haiku));
  assert.deepEqual(guardEvents(guardVerdicts(few, MIN_ROWS)), []);
  // the control: at the floor, the same 0% IS read and breaches
  const atFloor = reading([tierRows("sonnet/high", 1, 50, 50), tierRows("haiku/high", 100, MIN_ROWS, 0)]);
  assert.equal(verdictOf(atFloor, "haiku/high")?.state, "breach");
  const noBaseline = reading([tierRows("sonnet/high", 1, MIN_ROWS - 1, MIN_ROWS - 1), tierRows("sonnet/medium", 100, 20, 0)]);
  const medium = verdictOf(noBaseline, "sonnet/medium");
  assert.ok(medium?.state === "not-readable" && /baseline/.test(medium.why), JSON.stringify(medium));
  assert.deepEqual(guardEvents(guardVerdicts(noBaseline, MIN_ROWS)), []);
});

test("a tier ahead of Sonnet/high's is ok, and Sonnet/high is never a tier the guard files against", () => {
  const ahead = reading([tierRows("sonnet/high", 1, 20, 10), tierRows("sonnet/medium", 100, 20, 20), tierRows("haiku/high", 200, 20, 10)]);
  const verdicts = guardVerdicts(ahead, MIN_ROWS);
  assert.deepEqual(verdicts.map((v) => [v.route, v.state]), [["haiku/high", "ok"], ["sonnet/medium", "ok"]]);
  assert.deepEqual(guardEvents(verdicts), []);
});

test("an open row, an unmerged close and an unresolved close are counted apart and none is a merged row", () => {
  const starts = [11, 12, 13, 14, 15].map((row) => ({ row, at: NOW, route: "sonnet/medium", via: "jev" }));
  const results = new Map<number, RowResult>([[11, merged(0)], [12, merged(2)], [13, { merged: false, rejections: 0 }], [14, { merged: false, rejections: 0, unresolved: true }]]);
  const tier = firstPassByRoute(starts, results, 2)["sonnet/medium"];
  assert.deepEqual({ ...tier }, { route: "sonnet/medium", routed: 5, merged: 2, firstPass: 1, closedUnmerged: 1, unresolved: 1, open: 1, readable: true });
});

test("two tiers in breach file two incidents, each naming its tier; a second day's reading files none, and the ledger holds one line each", () => {
  const verdicts = guardVerdicts(reading([tierRows("sonnet/high", 1, 50, 50), tierRows("sonnet/medium", 100, 50, 40), tierRows("haiku/high", 200, 50, 30)]), MIN_ROWS);
  const logPath = fresh("failure-ledger");
  const first = recordFailures({ logPath, events: guardEvents(verdicts), now: NOW, report: () => {} });
  assert.deepEqual([first.appended, first.skipped], [2, 0]);
  const second = recordFailures({ logPath, events: guardEvents(verdicts), now: NOW + DAY, report: () => {} });
  assert.deepEqual([second.appended, second.skipped], [0, 2], "the same breach a day later is not a second incident");
  const entries = parseFailureLedger(readFileSync(logPath, "utf8"));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.classKey === ROUTE_FIRST_PASS_GAP));
  assert.deepEqual(entries.map((entry) => entry.ref.split(" ")[0]).sort(), ["haiku/high", "sonnet/medium"]);
  assert.ok(FAILURE_LEDGER_FILE.length > 0);
});

test("an incident names the constants to change, in the direction that sends fewer rows down, and every one is a constant engineer-route.ts exports", () => {
  const source = readFileSync(new URL("./engineer-route.ts", import.meta.url), "utf8");
  const exported = (name: string): boolean => new RegExp(`^export const ${name} =`, "m").test(source);
  const named = Object.values(TUNING).flatMap((text) => text.match(/[A-Z][A-Z_]{6,}/g) ?? []);
  assert.deepEqual([...named].sort(), ["HAIKU_MIN_P_MECHANICAL", "HAIKU_MIN_P_SCORE", "MEDIUM_MAX_P_SUBSYSTEMS", "MEDIUM_MIN_P_SCORE"], "the four the row names");
  for (const name of named) assert.ok(exported(name), `${name} is not exported by engineer-route.ts`);
  // the marker's own control: a name that is not there is not found, so the loop above can fail
  assert.ok(!exported("HAIKU_MIN_P_NOTHING"));
  // the ceiling is lowered, never raised, to send fewer rows to Sonnet/medium
  assert.match(TUNING["sonnet/medium"], /lower MEDIUM_MAX_P_SUBSYSTEMS/);
  assert.match(source, /MEDIUM_MAX_P_SUBSYSTEMS = 0\.5;/);
  const ceiling = guardEvents(guardVerdicts(reading([tierRows("sonnet/high", 1, 50, 50), tierRows("sonnet/medium", 100, 50, 40)]), MIN_ROWS))[0].ref;
  assert.match(ceiling, /raise MEDIUM_MIN_P_SCORE and lower MEDIUM_MAX_P_SUBSYSTEMS in engineer-route\.ts$/);
  assert.ok(!/[\t\r\n]/.test(ceiling), "a ledger ref carries no tab or newline");
});

// --- the text and the post ---
const FIXTURE = (() => {
  const lines = [provider(1, "haiku/high"), outcome(2, "sonnet/high", "refused")];
  const tiers = reading([tierRows("sonnet/high", 1, 50, 50), tierRows("sonnet/medium", 100, 50, 40)]);
  return { shares: routeShares(lines, WINDOW), tiers, verdicts: guardVerdicts(tiers, MIN_ROWS), minRows: MIN_ROWS };
})();

test("the reading prints the starts and the guard; a first-pass read that failed says so and shows no figure", () => {
  const text = formatRouteGuard(FIXTURE);
  assert.match(text, /haiku\/high 1 \(100%\)/);
  assert.match(text, /not the provider's: refused 1/);
  assert.match(text, /sonnet\/medium: OVER THE LINE, 20 points under sonnet\/high; raise MEDIUM_MIN_P_SCORE and lower MEDIUM_MAX_P_SUBSYSTEMS/);
  assert.match(text, /haiku\/high: not readable -- haiku\/high has 0 merged rows, under 8/);
  const unread = formatRouteGuard({ ...FIXTURE, unread: "gh could not be reached" });
  assert.match(unread, /NOT READ: gh could not be reached/);
  assert.ok(!/OVER THE LINE|first pass \(/.test(unread), "no figure it did not see");
});

test("the post asks nothing: no question mark, even from a route text that carries one", () => {
  const text = renderRouteGuardPost({ ...FIXTURE, unread: "why did it fail?" });
  assert.ok(!text.includes("?"), text);
  assert.match(text, /why did it fail/, "positive control: the text was there and the mark was what went");
  assert.match(text, /nothing here needs an answer/);
});

function fakeGh(present = "") {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    return args[0] === "api" ? present : "https://github.com/a11ign/a11ign/issues/4627#issuecomment-6100000009\n";
  };
  return { delivery: { via: "tracker", repo: "a11ign/a11ign", run } as Extract<Delivery, { via: "tracker" }>, calls };
}

test("one post per day on the epic, carrying its own marker; nothing at all without a provider", async () => {
  const text = renderRouteGuardPost(FIXTURE);
  const gh = fakeGh();
  const sent = await postRouteGuard({ text, providerDeclared: true, delivery: gh.delivery, now: NOW });
  assert.ok(sent.posted && sent.destination === "tracker-comment" && sent.ref === "6100000009", JSON.stringify(sent));
  const body = gh.calls.find((args) => args[0] === "issue")?.[6] ?? "";
  assert.ok(body.startsWith("<!-- route-guard-post: 2026-10-10 -->\n"), body);
  assert.ok(body.endsWith(text));
  const present = fakeGh("6100000009\n");
  assert.deepEqual(await postRouteGuard({ text, providerDeclared: true, delivery: present.delivery, now: NOW }), { posted: false, why: "already-posted" });
  assert.deepEqual(present.calls.map((args) => args[0]), ["api"]);
  const none = fakeGh();
  assert.deepEqual(await postRouteGuard({ text, providerDeclared: false, delivery: none.delivery, now: NOW }), { posted: false, why: "no-provider" });
  assert.deepEqual(none.calls, []);
});

test("through the messenger the post is one announcement a day, keyed by the day", async () => {
  const provider_ = createFakeProvider({ capabilities: { destinations: 2 } });
  const delivery: Delivery = { via: "messenger", provider: provider_, ledger: createLedger({ path: fresh("ledger.jsonl"), now: () => NOW }) };
  const text = renderRouteGuardPost(FIXTURE);
  const first = await postRouteGuard({ text, providerDeclared: true, delivery, now: NOW });
  assert.ok(first.posted && first.destination === "channel", JSON.stringify(first));
  assert.equal(first.posted && first.key, "summary:route-guard:2026-10-10");
  assert.deepEqual(await postRouteGuard({ text, providerDeclared: true, delivery, now: NOW + HOUR }), { posted: false, why: "already-posted" });
  assert.equal(provider_.sent.length, 1);
  const next = await postRouteGuard({ text, providerDeclared: true, delivery, now: NOW + DAY });
  assert.ok(next.posted, "the next UTC day posts again");
  assert.equal(provider_.sent.length, 2);
});
