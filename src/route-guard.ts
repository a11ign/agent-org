// agent-org#724 (item 4 of a11ign/a11ign#4875): WHERE ENGINEER STARTS WENT BY ROUTE, AND A GUARD ON EACH LOWER TIER'S FIRST-PASS MERGE AGAINST SONNET/HIGH'S. #4875 made routing decide on the provider's
// probabilities, so Haiku/high and Sonnet/medium now take many more starts; this is the instrument that says whether that was worth it.
//
// THE ROUTE OF A ROW IS THE DECISION LOG'S, NOT A LABEL. `haiku-tier-report.ts` tells Haiku from "others" by the `tier:haiku` label a human puts on a row, which a provider-routed start never carries,
// and it cannot tell Sonnet/medium from Sonnet/high at all. The route is on the outcome line `engineer-route.ts` writes (`route <route> window <w> via <via> (...)`), joined to the row by the decision's
// `id` (`row-<n>`). A ROW ROUTED MORE THAN ONCE COUNTS UNDER ITS LAST ROUTE: that is the one whose worker built it. The starts reading counts the route LINES, which is what the row's open-check counts.
//
// ONLY THE PROVIDER'S ROUTES (`via jev`) ARE COMPARED. A fallback is the Region's file count, a refusal and an override are a rule and a human; none of them is a start the thresholds below decided, so
// a Sonnet/medium that the fallback chose could not be repaired by raising a constant and would blur the one comparison this guard makes: the provider's lower tiers against the provider's Sonnet/high.
//
// FIRST-PASS IS THE REPORT'S DEFINITION, NOT A NEW ONE: a pull request merged with no `CHANGES_REQUESTED` review (`pullOutcome` in `haiku-tier-report.ts`). The decision log carries no
// `merged-first-pass` line (`recordRouteOutcome` has no caller), so it is read from the trace store's events, which is also where the report reads it.
//
// A TIER IS READABLE AT `minRows` MERGED ROWS (the report's `MIN_RATE_ROWS`, handed in so this reading does not import the report, which resolves the host's checkout on import) AND SO MUST
// SONNET/HIGH BE, since the gap is between two rates. A tier that is not readable says so and files nothing. The gap is compared in integers, so "more than 5 points" is not decided by a float.
//
// THE GUARD NEVER EDITS A THRESHOLD (a threshold is a decision). It files ONE ledger incident per tier, and the ref names no day, so a standing breach is one line and the second day's reading of it
// files nothing (`recordFailures` skips a (class, ref) pair it holds). The cost of that is deliberate: a breach fixed and returned is still the same line until someone clears it, the opposite choice
// of `engineer-route.ts`'s per-day cost incident, because a gap that is read over a trailing window is the same gap tomorrow.
//
// DIRECTION: the four constants the row names are not all "raise". `MEDIUM_MAX_P_SUBSYSTEMS` is a CEILING (Sonnet/medium needs P(subsystems) BELOW it), so sending fewer rows to Sonnet/medium means
// LOWERING it; the incident says which way each goes.
//
// THE POST rides the announcement path of `decision-confidence-post.ts` (a11ign/a11ign#4742, #4755): told, never asked, one per UTC day, nothing at all without a provider. Its delivery code is
// copied below, and says so, because that file is outside this row's Region.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessenger } from "./messaging/core.ts";
import { createLedger } from "./messaging/ledger.ts";
import { AUDIENCE } from "./messaging/provider-contract.ts";
import { CONFIDENCE_CONFIG, POST_KIND, TRACKER_EPIC, type Delivery, type PostResult } from "./decision-confidence-post.ts";
import { FAILURE_LEDGER_FILE, recordFailures, type FailureEvent, type RecordResult } from "./failure-ledger.ts";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { parseWindow } from "./provider-confidence.ts";

export const ROUTES = Object.freeze(["haiku/high", "sonnet/medium", "sonnet/high"] as const);
export type Route = (typeof ROUTES)[number];
export type LowerTier = Exclude<Route, "sonnet/high">;
const BASELINE: Route = "sonnet/high";
const LOWER_TIERS: readonly LowerTier[] = Object.freeze(["haiku/high", "sonnet/medium"] as const);
/** A lower tier more than this many points under Sonnet/high's first-pass merge is a breach. */
export const ROUTE_FIRST_PASS_GAP_POINTS = 5;
/** The failure-ledger class key (an event kind, like `main-red`). */
export const ROUTE_FIRST_PASS_GAP = "route-first-pass-gap";
/** What a breach of each tier tells its reader to change in `engineer-route.ts`, in the direction that sends fewer rows to the tier. Pinned to the source by the test. */
export const TUNING: Readonly<Record<LowerTier, string>> = Object.freeze({
  "haiku/high": "raise HAIKU_MIN_P_MECHANICAL and HAIKU_MIN_P_SCORE",
  "sonnet/medium": "raise MEDIUM_MIN_P_SCORE and lower MEDIUM_MAX_P_SUBSYSTEMS",
});
/** The trailing window of a reading: a week, because a lower tier rarely has 8 merged rows in a day. `--since` sets another. */
export const DEFAULT_WINDOW_MS = 7 * 86_400_000;
const PERCENT = 100;
const DAY_LENGTH = 10;
const MINUTE_LENGTH = 16;

const ROW_ID = /^row-(\d+)$/;
const ROUTE_LINE = /^route (\S+) window \S+(?: \(.*?\))? via (\S+)/;
const isRoute = (value: string): value is Route => (ROUTES as readonly string[]).includes(value);
const isLowerTier = (route: Route): route is LowerTier => route !== BASELINE;

type Window = { now: number; windowMs: number };
/** One routing the log holds: the row, when, and what its outcome line says (`via` as written, `route` as written). */
export type RouteStart = { row: number; at: number; route: string; via: string };

/**
 * Every `model-routing` outcome line that names a route, for a row, in file order, at the outcome line's own time. A line that is not a route (`merged-first-pass`, `window too small`, a request
 * line) is not a start. Read here and not through `decision-provider.ts`'s `decisionsIn`, which resolves the host's checkout on import: this reading needs no pairing of requests to outcomes.
 */
export function routeStartsIn(lines: readonly unknown[]): RouteStart[] {
  return (lines as { use?: unknown; id?: unknown; outcome?: unknown; at?: unknown }[]).flatMap((line) => {
    if (line?.use !== "model-routing" || typeof line.id !== "string" || typeof line.outcome !== "string" || typeof line.at !== "number") return [];
    const row = Number(ROW_ID.exec(line.id)?.[1]);
    const route = Number.isInteger(row) ? ROUTE_LINE.exec(line.outcome) : null;
    return route === null ? [] : [{ row, at: line.at, route: route[1], via: route[2] }];
  });
}

const inWindow = (start: RouteStart, { now, windowMs }: Window): boolean => start.at >= now - windowMs && start.at <= now;

// --- the starts by route ---

export type RouteShares = {
  since: number; until: number;
  /** Route lines read in the window: `providerStarts` plus every `apart` count, so nothing read is left out of the sum. */
  starts: number; rows: number;
  providerStarts: number; provider: Readonly<Record<Route, number>>;
  /** The share of provider starts each route took, or `null` when the provider decided none (a share of nothing is not zero). */
  shares: Readonly<Record<Route, number>> | null;
  /** Starts the provider did not decide, by how they were decided; `unrecognised` is a `via` or a provider route this reading has no name for. */
  apart: Readonly<Record<"fallback" | "refused" | "override" | "unrecognised", number>>;
};

/** THE STARTS BY ROUTE over the trailing window: the provider's by route and share, the fallback, refused and override starts counted apart. */
export function routeShares(lines: readonly unknown[], window: Window): RouteShares {
  const read = routeStartsIn(lines).filter((start) => inWindow(start, window));
  const provider: Record<Route, number> = { "haiku/high": 0, "sonnet/medium": 0, "sonnet/high": 0 };
  const apart = { fallback: 0, refused: 0, override: 0, unrecognised: 0 };
  for (const { via, route } of read) {
    if (via === "jev" && isRoute(route)) provider[route] += 1;
    else if (via === "fallback" || via === "refused" || via === "override") apart[via] += 1;
    else apart.unrecognised += 1;
  }
  const providerStarts = ROUTES.reduce((sum, route) => sum + provider[route], 0);
  const shares = providerStarts === 0 ? null : (Object.fromEntries(ROUTES.map((route) => [route, provider[route] / providerStarts])) as Record<Route, number>);
  return { since: window.now - window.windowMs, until: window.now, starts: read.length, rows: new Set(read.map((start) => start.row)).size, providerStarts, provider, shares, apart };
}

// --- first-pass merge by route ---

/** What the caller read of a routed row once it closed: `merged` with its `CHANGES_REQUESTED` count, or not merged. `unresolved` is a closing pull request whose repository could not be read
 * (agent-org#689): not a row that did not merge, so it is counted apart and never in the merged or unmerged. */
export type RowResult = { merged: boolean; rejections: number; unresolved?: boolean };

/** The rows the provider routed in the window, each under its LAST route line (a row routed twice is one row); a row whose last line is not the provider's, or names no route this reading knows, is not one. */
export function providerRoutedRows(lines: readonly unknown[], window: Window): (RouteStart & { route: Route })[] {
  const last = new Map<number, RouteStart>();
  for (const start of routeStartsIn(lines).filter((s) => inWindow(s, window))) last.set(start.row, start);
  return [...last.values()].filter((start): start is RouteStart & { route: Route } => start.via === "jev" && isRoute(start.route));
}

export type TierReading = {
  route: Route; routed: number; merged: number; firstPass: number;
  /** Closed with no merged pull request. */ closedUnmerged: number;
  /** Closed, its pull request's repository unreadable: not an outcome. */ unresolved: number;
  /** Not closed, so not yet an outcome. */ open: number;
  readable: boolean;
};

/** FIRST-PASS MERGE BY ROUTE: each routed row's result joined by its number. A row with no entry in `results` has not closed. `minRows` is the report's floor for a readable rate. */
export function firstPassByRoute(routed: readonly RouteStart[], results: ReadonlyMap<number, RowResult>, minRows: number): Record<Route, TierReading> {
  const reading = (route: Route): TierReading => {
    const rows = routed.filter((start) => start.route === route);
    const outcomes = rows.flatMap((start) => (results.has(start.row) ? [results.get(start.row) as RowResult] : []));
    const unresolved = outcomes.filter((outcome) => outcome.unresolved === true).length;
    const merged = outcomes.filter((outcome) => outcome.merged && outcome.unresolved !== true);
    return { route, routed: rows.length, merged: merged.length, firstPass: merged.filter((outcome) => outcome.rejections === 0).length, unresolved,
      closedUnmerged: outcomes.length - merged.length - unresolved, open: rows.length - outcomes.length, readable: merged.length >= minRows };
  };
  return Object.fromEntries(ROUTES.map((route) => [route, reading(route)])) as Record<Route, TierReading>;
}

export type GuardVerdict =
  | { route: LowerTier; state: "ok" | "breach"; gapPoints: number }
  | { route: LowerTier; state: "not-readable"; why: string };

/** The tier's gap under the baseline in points, exactly: `null` unless both are rates. `over` is whether it is MORE than {@link ROUTE_FIRST_PASS_GAP_POINTS}, decided on integers. */
function gapOf(tier: TierReading, baseline: TierReading): { points: number; over: boolean } {
  // baseline.firstPass/baseline.merged - tier.firstPass/tier.merged, over a common denominator
  const numerator = baseline.firstPass * tier.merged - tier.firstPass * baseline.merged;
  const denominator = baseline.merged * tier.merged;
  return { points: (numerator * PERCENT) / denominator, over: numerator * PERCENT > ROUTE_FIRST_PASS_GAP_POINTS * denominator };
}

/** THE GUARD: one verdict per lower tier. A tier (or the baseline) under `minRows` merged rows is not readable and decides nothing. */
export function guardVerdicts(readings: Record<Route, TierReading>, minRows: number): GuardVerdict[] {
  const baseline = readings[BASELINE];
  return LOWER_TIERS.map((route): GuardVerdict => {
    const tier = readings[route];
    if (!tier.readable) return { route, state: "not-readable", why: `${route} has ${tier.merged} merged rows, under ${minRows}` };
    if (!baseline.readable) return { route, state: "not-readable", why: `${BASELINE}, the baseline, has ${baseline.merged} merged rows, under ${minRows}` };
    const gap = gapOf(tier, baseline);
    return { route, state: gap.over ? "breach" : "ok", gapPoints: gap.points };
  });
}

/** The ledger events: one per breaching tier, its ref naming the tier and what to change. No day in the ref, so a standing breach is one line. */
export function guardEvents(verdicts: readonly GuardVerdict[]): FailureEvent[] {
  return verdicts.filter((verdict) => verdict.state === "breach").map(({ route }) => ({ classKey: ROUTE_FIRST_PASS_GAP,
    ref: `${route} first-pass merge over ${ROUTE_FIRST_PASS_GAP_POINTS} points under ${BASELINE}: ${TUNING[route as LowerTier]} in engineer-route.ts` }));
}

// --- the reading as text ---

const percent = (share: number): string => `${Math.round(share * PERCENT)}%`;
const minute = (at: number): string => `${new Date(at).toISOString().slice(0, MINUTE_LENGTH)}Z`;
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, DAY_LENGTH);

function sharesText(reading: RouteShares): string[] {
  const { providerStarts, provider, shares, apart } = reading;
  const split = shares === null ? "the provider decided none" : ROUTES.map((route) => `${route} ${provider[route]} (${percent(shares[route])})`).join(", ");
  const other = Object.entries(apart).filter(([, n]) => n > 0).map(([how, n]) => `${how} ${n}`);
  return [`Engineer starts by route, ${minute(reading.since)} to ${minute(reading.until)}: ${reading.starts} route lines on ${reading.rows} rows.`,
    `  the provider's routes (via jev), ${providerStarts}: ${split}`,
    `  not the provider's: ${other.length === 0 ? "none" : other.join(", ")}`];
}

function tierText(tier: TierReading): string {
  const rate = tier.merged === 0 ? "none merged" : `${tier.firstPass} of ${tier.merged} merged first pass (${percent(tier.firstPass / tier.merged)})`;
  return `  ${tier.route}: ${tier.routed} routed, ${rate}; ${tier.closedUnmerged} closed with no merged pull request, ${tier.unresolved} unresolved, ${tier.open} still open`;
}

function verdictText(verdict: GuardVerdict): string {
  if (verdict.state === "not-readable") return `  ${verdict.route}: not readable -- ${verdict.why}`;
  const gap = `${verdict.gapPoints.toFixed(0)} points under ${BASELINE}`;
  return verdict.state === "ok" ? `  ${verdict.route}: ok, ${gap} (the line is more than ${ROUTE_FIRST_PASS_GAP_POINTS})`
    : `  ${verdict.route}: OVER THE LINE, ${gap}; ${TUNING[verdict.route]} in engineer-route.ts (nothing is edited here)`;
}

/** BOTH READINGS as lines. `results === null` is a reading whose rows could not be read (no store, no `gh`): it says so and shows no first-pass figure it did not see. */
export function formatRouteGuard({ shares, tiers, verdicts, minRows, unread }: { shares: RouteShares; tiers: Record<Route, TierReading>; verdicts: readonly GuardVerdict[]; minRows: number; unread?: string }): string {
  const firstPass = unread === undefined
    ? [...ROUTES.map((route) => tierText(tiers[route])), `Guard (a tier is read at ${minRows} merged rows or more; over the line is more than ${ROUTE_FIRST_PASS_GAP_POINTS} points under ${BASELINE}):`, ...verdicts.map(verdictText)]
    : [`  NOT READ: ${unread}`];
  return [...sharesText(shares), "First-pass merge by route, rows the provider routed in the window (a pull request merged with no CHANGES_REQUESTED review):", ...firstPass].join("\n");
}

// --- the daily post ---

const NOTHING_ASKED = "Told, not asked: nothing here needs an answer.";
export const markerFor = (day: string): string => `<!-- route-guard-post: ${day} -->`;

/** One short text per day, the same shape on a quiet day. Every `?` is removed at the end: this is an announcement and must ask nothing, whatever a row's route text carries. */
export function renderRouteGuardPost(reading: Parameters<typeof formatRouteGuard>[0]): string {
  return `${formatRouteGuard(reading)}\n${NOTHING_ASKED}`.replaceAll("?", "");
}

// COPIED FROM `decision-confidence-post.ts` (a11ign/a11ign#4755): its `postThroughMessenger` and `postToTracker` are not exported and that file is outside this row's Region. The only changes are the key,
// the marker and that the text is handed in. When that file exports them, delete these two.
async function postThroughMessenger({ delivery, key, text, now }: { delivery: Extract<Delivery, { via: "messenger" }>; key: string; text: string; now: number }): Promise<PostResult> {
  const { provider, ledger, config = CONFIDENCE_CONFIG } = delivery;
  const messenger = createMessenger({ provider, ledger, now: () => now, config });
  const decisions = await messenger.tick([{ key, kind: POST_KIND, severity: "info", firstSeenAt: now, text }]);
  const action = decisions.find((decision) => decision.key === key)?.action ?? "none";
  if (action === "duplicate") return { posted: false, why: "already-posted" };
  const line = ledger.read().filter((entry: Record<string, any>) => entry.key === key && entry.status === "sent").at(-1) as Record<string, any> | undefined;
  if (action !== "sent" || line === undefined) return { posted: false, why: "not-sent", detail: action };
  const toChannel = line.audience === AUDIENCE.announcement && (provider.capabilities.destinations ?? 1) >= 2;
  return { posted: true, destination: toChannel ? "channel" : "chairman-chat", ref: String(line.providerMessageId), key, text };
}

function postToTracker({ delivery, text, day }: { delivery: Extract<Delivery, { via: "tracker" }>; text: string; day: string }): PostResult {
  const { repo, run } = delivery;
  const marker = markerFor(day);
  const path = `repos/${repo}/issues/${TRACKER_EPIC}/comments?per_page=100&since=${day}T00:00:00Z`;
  const present = run(["api", "--paginate", path, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim();
  if (present !== "") return { posted: false, why: "already-posted" };
  const printed = run(["issue", "comment", String(TRACKER_EPIC), "--repo", repo, "--body", `${marker}\n${text}`]).trim();
  return { posted: true, destination: "tracker-comment", ref: /issuecomment-(\d+)/.exec(printed)?.[1] ?? printed, key: marker, text };
}

/** THE POST: nothing without a provider; otherwise one announcement for the UTC day of `now`, wherever the delivery sends it. */
export async function postRouteGuard({ text, providerDeclared, delivery, now }: { text: string; providerDeclared: boolean; delivery: Delivery; now: number }): Promise<PostResult> {
  if (!providerDeclared) return { posted: false, why: "no-provider" };
  const day = utcDay(now);
  if (delivery.via === "tracker") return postToTracker({ delivery, text, day });
  return postThroughMessenger({ delivery, key: `${POST_KIND}:route-guard:${day}`, text, now });
}

// --- the CLI ---
//
// `node src/route-guard.ts [--log=<decisions>] [--store=<events.ndjson>] [--since=7d] [--record] [--post]` prints both readings. `--record` files the guard's incidents beside the decision log;
// `--post` posts the day's announcement. Everything the host knows is imported when it is needed, so the readings above and their test refuse on no machine for want of `AGENT_ORG_HOST`.
const EXIT = { OK: 0, NOT_SENT: 1, CANNOT: 2 };
const GH_TIMEOUT_MS = 60_000;

function cannot(message: string): never {
  process.stderr.write(`CANNOT READ: ${message}\n`);
  process.exit(EXIT.CANNOT);
}

/** An absent log is the provider never having been asked; any other failure to read it is not that. */
function readLog(path: string): unknown[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return [];
    return cannot(`the decision log could not be read (${(error as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a provider asked nothing.`);
  }
}

/** The rows' results from `gh` (the rows closed since the earliest routing) and the trace store (their pull requests' reviews and merges). A row `gh` did not return has not closed. */
async function readResults(rows: readonly RouteStart[], storePath: string | undefined): Promise<Map<number, RowResult>> {
  const [{ readStore }, { defaultStore }, { readClosedRows, pullOutcome }] = await Promise.all([import("./trace/store.ts"), import("./trace/otel-receiver.ts"), import("./trace/haiku-tier-report.ts")]);
  const wanted = new Set(rows.map((start) => start.row));
  if (wanted.size === 0) return new Map();
  const closed = readClosedRows(Math.min(...rows.map((start) => start.at)), Date.now()).filter((row) => wanted.has(row.number));
  const pulls = readStore(storePath ?? defaultStore()).filter((event) => event.source === "github" && (event.kind === "merged" || event.kind === "reviewed"));
  return new Map(closed.map((row) => [row.number, row.unresolved === true ? { merged: false, rejections: 0, unresolved: true } : pullOutcome(pulls, row.pr)] as const));
}

async function hostFacts(): Promise<{ providerDeclared: boolean; logPath: () => Promise<string> }> {
  const logPath = async (): Promise<string> => {
    const { stateEntryPath } = await import("./host-config.ts");
    const { decisionLogPathFrom } = await import("./decision-provider.ts");
    return decisionLogPathFrom(stateEntryPath("wake-ledger"));
  };
  try {
    return { providerDeclared: (await import("./host-config.ts")).homeHostConfig().triage?.provider === "jev", logPath };
  } catch (error) {
    return cannot(`the host declaration could not be read (${(error as Error)?.name ?? "unknown error"}), so whether a provider is declared is not known and nothing was posted.`);
  }
}

// COPIED FROM `decision-confidence-post.ts`'s `messengerDelivery` and `deliveryFromHost`, for the reason `postThroughMessenger` is.
async function deliveryFromHost(now: number): Promise<Delivery> {
  const { HOME_CHECKOUT } = await import("./project-config.ts");
  const { MessagingConfigRefusal, readMessagingConfig } = await import("./messaging/config.ts");
  const { trackerRepo, readAnnouncementsChatId, readChairman, defaultLedgerPath } = await import("./messaging/state.ts");
  let config;
  try {
    config = readMessagingConfig(HOME_CHECKOUT);
  } catch (error) {
    // A declaration that cannot be read is not "no messaging configured": the epic is for the second, and posting there would hide the first.
    if (error instanceof MessagingConfigRefusal) return cannot(error.message);
    throw error;
  }
  if (!config.enabled) return { via: "tracker", repo: trackerRepo(HOME_CHECKOUT), run: (args) => execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS }) };
  const { readSecretFile, SecretFileRefusal } = await import("./messaging/secret.ts");
  const { createTelegramProvider } = await import("./messaging/providers/telegram/send.ts");
  try {
    const provider = createTelegramProvider({ token: readSecretFile(config.tokenFile), chatId: readChairman(config.chairmanFile).chatId,
      announcementsChatId: readAnnouncementsChatId(config.announcementsFile), log: (line) => process.stderr.write(`${line}\n`) });
    return { via: "messenger", provider, ledger: createLedger({ path: defaultLedgerPath(homedir()), now: () => now }) };
  } catch (error) {
    if (error instanceof SecretFileRefusal) return cannot(error.message);
    throw error;
  }
}

async function main(): Promise<void> {
  refuseUnknownFlags(["--log=", "--store=", "--since=", "--record", "--post"], { entry: import.meta.url, command: "node src/route-guard.ts" });
  const since = flagValue(process.argv, "since");
  const windowMs = since === undefined ? DEFAULT_WINDOW_MS : parseWindow(since);
  if (windowMs === undefined) cannot(`--since takes a number and m, h or d (30m, 24h, 7d), not ${JSON.stringify(since)}.`);
  const now = Date.now();
  const host = await hostFacts();
  const logPath = flagValue(process.argv, "log") ?? await host.logPath();
  const lines = readLog(logPath);
  const window = { now, windowMs };
  const { MIN_RATE_ROWS } = await import("./trace/haiku-tier-report.ts");
  const routed = providerRoutedRows(lines, window);
  let results: Map<number, RowResult> | undefined;
  let unread: string | undefined;
  try {
    results = await readResults(routed, flagValue(process.argv, "store"));
  } catch (error) {
    unread = `the closed rows or the trace store could not be read (${(error as Error)?.message?.split("\n")[0] ?? "unknown error"}), so no first-pass figure is shown and the guard did not look`;
  }
  const tiers = firstPassByRoute(routed, results ?? new Map(), MIN_RATE_ROWS);
  const verdicts = guardVerdicts(tiers, MIN_RATE_ROWS);
  const reading = { shares: routeShares(lines, window), tiers, verdicts, minRows: MIN_RATE_ROWS, unread };
  process.stdout.write(`${formatRouteGuard(reading)}\n`);
  // A first-pass read that failed is not a clean run: a scheduled `--record` must not look as though the guard looked.
  let exit = unread === undefined ? EXIT.OK : EXIT.CANNOT;
  if (process.argv.includes("--record") && unread === undefined) {
    const filed: RecordResult = recordFailures({ logPath: join(dirname(logPath), FAILURE_LEDGER_FILE), events: guardEvents(verdicts), now });
    process.stdout.write(`incidents: ${filed.appended} filed, ${filed.skipped} already filed${filed.refused === null ? "" : `, REFUSED: ${filed.refused}`}\n`);
    if (filed.refused !== null) exit = EXIT.NOT_SENT;
  }
  if (process.argv.includes("--post") && host.providerDeclared) {
    const result = await postRouteGuard({ text: renderRouteGuardPost(reading), providerDeclared: true, delivery: await deliveryFromHost(now), now });
    process.stdout.write(result.posted ? `posted: ${result.destination} ${result.ref}\n` : `not posted: ${result.why}${"detail" in result && result.detail !== undefined ? ` (${result.detail})` : ""}\n`);
    if (!result.posted && result.why !== "already-posted") exit = EXIT.NOT_SENT;
  }
  process.exit(exit);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
