// #4629: THE ENGINEER ROUTE. A new engineer's model and effort were Sonnet/high for every row unless a human put `tier:haiku` on it. This module routes each row by atomic questions
// over the row's own text, and `tierOfRow` (wake.ts) asks it beside `haikuTierProfile`.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). Asked through `decide` (#4628), so there is one client, one switch (`model-routing` in `.agent-org/decisions.json`) and one log. With no
// provider, no key, the use switched off, a refusal, a timeout or a floor not met, the route is {@link fallbackRoute}: the Region's file count and the Acceptance's shape. The
// fallback NEVER picks Haiku -- that stays `tier:haiku`'s, a human's.
//
// THE PROVIDER ONLY CLASSIFIES. It answers four questions; {@link composeRoute}, which is pure, turns the answers into a route. Nothing the provider says can start anything
// but a worker the row was already going to get, one rung cheaper, and a worker's own CEILINGS (the Haiku switch and its refusals) are asked of the same code `tier:haiku` uses.
//
// #4764: THE ROUTE MUST NEVER COST MORE THAN THE RULE IT REPLACED, AND NOW IT IS MEASURED. A `covered` question ("does the Acceptance fully cover the Done-when?") was answered `no` on 55
// of 55 provider decisions, because this org's Done-when lists always run past the Acceptance command, and composing it as a gate pinned every provider route to Sonnet/high: dearer than the fallback.
// It is gone; "the Acceptance is a command" is a fact of the row's text, which {@link whyHeld} already reads. Each provider route logs the route the fallback WOULD have taken beside
// it, and {@link routeCostReading} raises a ledger incident when the provider's last {@link GUARD_DECISIONS} routes averaged dearer than that.
//
// THE STATE IS STRUCTURED AND TRIMMED: the title, the Region's entries, the Acceptance's command text and the Done-when list. Never the row's body, which an agent wrote.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractAcceptanceSection } from "./acceptance-commands.ts";
import { decide, decisionsIn, recordOutcome, type DecisionDeps, type Question, type ScoreLevels } from "./decision-provider.ts";
import { FAILURE_LEDGER_FILE, recordFailures, type FailureEvent } from "./failure-ledger.ts";
import { LANE_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { extractLabeledSection, extractRegionSection } from "./region-paths.ts";
import { AUTOCOMPACT_WINDOW_TOKENS, haikuTierProfile, HAIKU_TIER_LABEL, type TierProfile } from "./worker-profile.ts";

export type Route = "haiku/high" | "sonnet/medium" | "sonnet/high";
/** `override` is a `tier:haiku` label deciding; `refused` is a row nothing may lower; `jev` is a provider's answers composed; `fallback` is the file-count rule. */
export type Via = "override" | "refused" | "jev" | "fallback";
export type RouteRow = { number: number; title: string; labels: readonly string[]; body: string };
export type Routed = { route: Route; via: Via;
  /** THE REASON THE ROUTE WAS TAKEN, one text: the work tick's `routed ...` journal line and the decision log's outcome line (`route <route> via <via> (<why>)`) both print it. */ why: string;
  /** `null` is the ordinary Sonnet/high profile, byte-identical to before. */ profile: TierProfile | null;
  /** Why the provider did not decide this route (a fallback), or which answers it did not give (a `jev` route held to Sonnet/high); absent when it decided it. */ reason?: string };
/** One answer per question; `null` is an answer that was not given: malformed, or under the confidence floor. {@link composeRoute} says what each question's absence means. */
export type Answers = { mechanical: boolean | null; subsystems: boolean | null; debugging: boolean | null; score: number | null };

/** The Region's largest size that is still "a small row" (the row's own number). */
export const SMALL_ROW_FILES = 3;
/** The complexity `score` a Haiku row may be at most, and the one a Sonnet/medium row is. */
export const HAIKU_MAX_SCORE = 2;
export const MEDIUM_SCORE = 3;
const MEDIUM_EFFORT = "medium";
const DIRECTORY_FILES = SMALL_ROW_FILES + 1;
const TITLE_CHARS = 200;
const REGION_ENTRIES = 12;
const ENTRY_CHARS = 120;
const ACCEPTANCE_CHARS = 600;
const DONE_WHEN_ITEMS = 8;
const DONE_WHEN_CHARS = 200;
const ID_PREFIX = "row-";

const YES_NO = { yes: "true of this row", no: "not true of this row" } as const;

// --- the criteria: what each answer means, with rows whose outcome is known (#4764 change 3, the method of #4627's 07:45Z direction) ---
//
// THE PROVIDER WAS UNSURE BECAUSE IT WAS TOLD LITTLE: `score` came back under the floor on 34 of 55 provider decisions and `subsystems` on 30 (the decision log, 2026-10-10),
// from five bare level phrases and two bare yes/no glosses. A Choice option now carries `what`, `not_for` and `examples`, a score level a `summary` and its `signals`, and every example
// is a row of ours: its number and the merged diff that settled the answer (`git diff --numstat` of the merge commit: files and lines). "Outcome known" is MERGED and what it
// changed; first-pass CI is not in any log this module can read.
//
// THE STRUCTURE IS RENDERED INTO THE ONE STRING THE API TAKES PER OPTION, which `wire()` sends unchanged (`criteria` is an object of strings, a score's an array of five). A
// structured object per option is #4752's (it changes `wire()`, which is `decision-provider.ts`'s), and a shape the API refused would be an HTTP 422 for every question at once.
type Example = { row: string; what: string; merged: string };
type Level = { summary: string; signals: readonly string[]; examples: readonly Example[] };
type Option = { what: string; notFor: string; examples: readonly Example[] };

/** The five levels of a `score`, level 1 first: a level's position IS its score (agent-org#564). */
export const SCORE_LEVEL_DATA: readonly [Level, Level, Level, Level, Level] = Object.freeze([
  { summary: "one stated edit in one file",
    signals: ["the Region names one source file (and its test)", "the Done-when is one assertion", "the row quotes the text or the value to change"],
    examples: [{ row: "a11ign#4522", what: "the Haiku tier's effort constant", merged: "1 file, +3 -3" },
      { row: "a11ign#4618", what: "a counter no longer read as an unknown failure class", merged: "1 file, +15 -3" }] },
  { summary: "a few stated edits, each independent",
    signals: ["the Region names 2 to 8 files and the edit is the same kind in each", "each edit is stated by the row and none needs another"],
    examples: [{ row: "a11ign#4557", what: "renamed paths and headers in two copies", merged: "2 files, +11 -11" },
      { row: "a11ign#4582", what: "thirteen copies naming originals that moved", merged: "8 files, +28 -19" }] },
  { summary: "a new small unit with a test, in one subsystem",
    signals: ["one new module and its test, or one module grown", "the Region stays inside one directory or one concern", "the Acceptance runs that module's own test"],
    examples: [{ row: "a11ign#4748", what: "a new reading over the decision log", merged: "1 source file, +478 with its test" },
      { row: "a11ign#4635", what: "a new review-depth module", merged: "1 source file, +187 with its test" }] },
  { summary: "a change that touches how two modules agree",
    signals: ["the Region names a module and its caller, or a wire, a type or a log format that both read", "a test of one module is not enough: the other must be run against it"],
    examples: [{ row: "a11ign#4629", what: "the route module and its wiring into the spawn path", merged: "2 source files, +476 -20" },
      { row: "a11ign#4630", what: "the escalation module and the tick that calls it", merged: "2 source files, +737 -17" }] },
  { summary: "a new seam, a migration or anything whose shape the row does not state",
    signals: ["the Region is a directory, or the row says migrate, replace or every", "the Done-when leaves a design or a reading open", "files in more than one area (source, host scripts, package.json, workflows)"],
    examples: [{ row: "a11ign#4418", what: "a new place the Acceptance is read from", merged: "7 source files and package.json, +404 -31" },
      { row: "a11ign#4389", what: "110 .mjs files become .ts", merged: "473 files, +6132 -9492" }] },
]);

/** The `subsystems` question's two options. `yes` is the one that holds a row at Sonnet/high only when the other rules would have lowered it. */
export const SUBSYSTEMS_DATA: Readonly<Record<"yes" | "no", Option>> = Object.freeze({
  yes: { what: "the Region spans modules that interact, so a change in one must be understood against the other (a producer and the consumer of one format, a module and the tick that calls it)",
    notFor: "the same edit repeated across files that do not interact, or one module and its own test",
    examples: [{ row: "a11ign#4629", what: "the route module and the spawn path that calls it", merged: "2 source files" },
      { row: "a11ign#4630", what: "the escalation module and the tick", merged: "2 source files" },
      { row: "agent-org#564", what: "one request shape agreed by the route, the provider client and the triage client", merged: "3 source files" }] },
  no: { what: "the Region is one module and its test, or the same edit in several files that do not interact",
    notFor: "a module and its caller, or two modules that read one format",
    examples: [{ row: "a11ign#4748", what: "one new reading module", merged: "1 source file" },
      { row: "a11ign#4639", what: "one scheduled-measurement module", merged: "1 source file" },
      { row: "a11ign#4582", what: "the same path fix in thirteen copies", merged: "8 files, none reading another" }] },
});

const exampleText = ({ row, what, merged }: Example): string => `${row} (${what}; merged: ${merged})`;
const examplesText = (examples: readonly Example[]): string => `Examples, from rows whose outcome is known: ${examples.map(exampleText).join("; ")}.`;
const levelText = ({ summary, signals, examples }: Level): string => `${summary}. Signals: ${signals.join("; ")}. ${examplesText(examples)}`;
const optionText = ({ what, notFor, examples }: Option): string => `${what}. Not for: ${notFor}. ${examplesText(examples)}`;

function scoreLevels(): ScoreLevels {
  const [one, two, three, four, five] = SCORE_LEVEL_DATA;
  return [levelText(one), levelText(two), levelText(three), levelText(four), levelText(five)];
}

/** The four atomic questions. Every fallback is the answer that does NOT lower the route; {@link fallbackRoute} decides what a fallback row gets. */
export const QUESTIONS: Readonly<Record<keyof Answers, Question>> = Object.freeze({
  mechanical: { type: "choice", criteria: YES_NO, fallback: "no",
    instructions: "Is this row MECHANICAL: a rename, a move, a sweep or a one-line fix where every edit is stated by the row itself and nothing is left to design?" },
  subsystems: { type: "choice", criteria: { yes: optionText(SUBSYSTEMS_DATA.yes), no: optionText(SUBSYSTEMS_DATA.no) }, fallback: "yes",
    instructions: "Does this row need reasoning ACROSS SUBSYSTEMS: its Region spans modules that interact, so a change in one must be understood against another?" },
  debugging: { type: "choice", criteria: YES_NO, fallback: "yes",
    instructions: "Does this row require DEBUGGING AN UNKNOWN FAILURE: the cause is not stated in the row and has to be found before anything is fixed?" },
  // The provider scores a level by its POSITION in `levels` (from zero); `decide` hands the callers the 1-based level, so `fallback: 5` is the last description.
  score: { type: "score", fallback: 5, levels: scoreLevels(),
    instructions: "Complexity of the row, as the level whose summary and signals fit it. Signals: file count, whether the Acceptance is a command, whether the Done-when is checkable." },
});

const asBool = (value: unknown): boolean | null => (value === "yes" ? true : value === "no" ? false : null);

/**
 * THE ROUTE AN ANSWER SET COMPOSES, PURE (#4764). Debugging an unknown failure holds a row at Sonnet/high. Otherwise, in order:
 * Haiku/high: mechanical and a score of at most {@link HAIKU_MAX_SCORE}, or mechanical with the score NOT GIVEN and a Region of at most {@link SMALL_ROW_FILES} files (a mechanical row
 * states every edit, and the Region says how many there can be). Sonnet/medium: a score of at most {@link MEDIUM_SCORE} and subsystems not answered `yes` (not given passes: the
 * provider is unsure, and a row this small is not reasoned across modules by default). ANYTHING ELSE is Sonnet/high as before.
 * `regionFiles` is {@link regionFileCount}: 0 is a Region that names nothing, which is never "small".
 */
export function composeRoute(answers: Answers, { regionFiles }: { regionFiles: number }): Route {
  const { mechanical, subsystems, debugging, score } = answers;
  if (debugging === true) return "sonnet/high";
  const smallRegion = regionFiles > 0 && regionFiles <= SMALL_ROW_FILES;
  if (mechanical === true && (score === null ? smallRegion : score <= HAIKU_MAX_SCORE)) return "haiku/high";
  if (score !== null && score <= MEDIUM_SCORE && subsystems !== true) return "sonnet/medium";
  return "sonnet/high";
}

/** The Region's entries, one per file named; a directory (a trailing slash) counts as more than the small-row limit, because it names every file under it. */
export function regionEntries(body: string): string[] {
  return (extractRegionSection(body) ?? "").split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]\s+)?/, "").replace(/`/g, "").trim())
    .filter((line) => line !== "" && !line.startsWith("```"));
}

/** The Done-when's items: the numbered or bulleted lines under that heading. */
export function doneWhenItems(body: string): string[] {
  return (extractLabeledSection(body, "Done-when") ?? "").split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim())
    .filter((line) => line !== "");
}

/** The Acceptance's command text, or `null` for a row whose Acceptance is not a command. */
export function acceptanceCommands(body: string): string | null {
  const section = extractAcceptanceSection(body);
  return section.kind === "commands" ? section.commands.join("\n") : null;
}

/** The files a Region names, with a directory counted as {@link DIRECTORY_FILES}. */
export function regionFileCount(body: string): number {
  return regionEntries(body).reduce((total, entry) => total + (entry.endsWith("/") ? DIRECTORY_FILES : 1), 0);
}

/** What goes to the provider: structured fields and nothing else, each cut to a length. {@link MAX_STATE_BYTES} still has the last word. */
export function routeState(row: RouteRow): Record<string, unknown> {
  const clip = (text: string, chars: number): string => text.slice(0, chars);
  return {
    title: clip(row.title, TITLE_CHARS),
    region: regionEntries(row.body).slice(0, REGION_ENTRIES).map((entry) => clip(entry, ENTRY_CHARS)),
    acceptance: clip(acceptanceCommands(row.body) ?? "", ACCEPTANCE_CHARS),
    doneWhen: doneWhenItems(row.body).slice(0, DONE_WHEN_ITEMS).map((item) => clip(item, DONE_WHEN_CHARS)),
  };
}

/** WITH NO PROVIDER: at most {@link SMALL_ROW_FILES} files and a command Acceptance is Sonnet/medium, anything else Sonnet/high. Never Haiku. */
export function fallbackRoute(row: Pick<RouteRow, "body">): Route {
  return regionFileCount(row.body) <= SMALL_ROW_FILES && regionEntries(row.body).length > 0 && acceptanceCommands(row.body) !== null ? "sonnet/medium" : "sonnet/high";
}

const SONNET_MEDIUM: TierProfile = Object.freeze({ kind: "claude", model: "sonnet", effort: MEDIUM_EFFORT, autocompactWindow: AUTOCOMPACT_WINDOW_TOKENS,
  why: "a small row with a command Acceptance (a11ign/a11ign#4629): medium effort is enough to build it" });

// --- the guard against paying more than the fallback (#4764) ---

/**
 * What a route costs, as a RUNG and not as dollars: the cheapest first. The guard compares the provider's routes with the fallback's over the same rows, so only the order of the
 * rungs is claimed. The one number to tune, if a price reading ever says Haiku and Sonnet/medium are not one rung apart each.
 */
export const ROUTE_COST: Readonly<Record<Route, number>> = Object.freeze({ "haiku/high": 1, "sonnet/medium": 2, "sonnet/high": 3 });
/** The provider routes the guard reads before it says anything: the chairman's figure (#4764), the last 20 that carry the fallback's would-be route. */
export const GUARD_DECISIONS = 20;
/** The failure-ledger class key (an event kind, like `main-red`). */
export const ROUTE_COSTLIER_THAN_FALLBACK = "route-costlier-than-fallback";
const WOULD_BE = /^route (\S+) via jev .*\[fallback would be (\S+)\]$/;
const isRoute = (value: string): value is Route => Object.hasOwn(ROUTE_COST, value);

export type RouteCostReading =
  | { kind: "too-few"; compared: number }
  | { kind: "read"; compared: number; providerMean: number; fallbackMean: number; costlier: boolean };

/**
 * THE PROVIDER'S ROUTES AGAINST THE FALLBACK'S, over the last {@link GUARD_DECISIONS} `via jev` outcome lines that name the route the fallback would have taken (`[fallback would
 * be X]`). A line without it (written before #4764) is not a comparison and is not counted, so the guard cannot fire on a log that never carried one. `costlier` is a MEAN strictly
 * above: a provider that is dearer on some rows and cheaper on others is the provider working.
 */
export function routeCostReading(lines: readonly unknown[]): RouteCostReading {
  const pairs = decisionsIn(lines).filter((d) => d.use === "model-routing")
    .flatMap(({ outcome }) => {
      const [, provider = "", fallback = ""] = WOULD_BE.exec(outcome) ?? [];
      return isRoute(provider) && isRoute(fallback) ? [[ROUTE_COST[provider], ROUTE_COST[fallback]] as const] : [];
    }).slice(-GUARD_DECISIONS);
  if (pairs.length < GUARD_DECISIONS) return { kind: "too-few", compared: pairs.length };
  const mean = (at: 0 | 1): number => pairs.reduce((sum, pair) => sum + pair[at], 0) / pairs.length;
  const [providerMean, fallbackMean] = [mean(0), mean(1)];
  return { kind: "read", compared: pairs.length, providerMean, fallbackMean, costlier: providerMean > fallbackMean };
}

/**
 * THE LEDGER EVENT, or none. The ref names the UTC day, because `recordFailures` skips a (key, ref) already logged for ever: a regression standing for a week is one line a day, and a
 * regression that was fixed and came back is a new one.
 */
export function routeCostEvents(reading: RouteCostReading, now: number): FailureEvent[] {
  if (reading.kind !== "read" || !reading.costlier) return [];
  return [{ classKey: ROUTE_COSTLIER_THAN_FALLBACK, ref: `model-routing-vs-fallback@${new Date(now).toISOString().slice(0, 10)}` }];
}

/** Why NO route may lower this row, or `null`. The same refusals `tier:haiku` has: a route lowers cost and never what a row is allowed to touch. */
function whyHeld(row: RouteRow): string | null {
  const refusing = [`${LANE_PREFIX}ceo`, NEEDS_CHAIRMAN_LABEL].find((label) => row.labels.includes(label));
  if (refusing !== undefined) return `the row carries ${refusing}`;
  if (regionEntries(row.body).some((entry) => entry.includes(".github/workflows/"))) return "its Region names .github/workflows/";
  if (acceptanceCommands(row.body) === null) return "it has no Acceptance command";
  return null;
}

type HaikuAsk = { profile: TierProfile } | { refused: string };
/** Haiku's profile through the code `tier:haiku` uses, so its switch and its refusals are not restated here. */
function haikuProfileOf(row: RouteRow, switchPath: string | undefined): HaikuAsk {
  let refused = "no reason was logged";
  const profile = haikuTierProfile({ number: row.number, labels: [...row.labels, HAIKU_TIER_LABEL], body: row.body }, { switchPath, log: (line) => { refused = line.replace(/^.*gets the ordinary profile: /, ""); } });
  return profile === null ? { refused } : { profile };
}

export type RouteDeps = DecisionDeps & { /** For a test: the Haiku switch file. */ haikuSwitchPath?: string };

const decided = (route: Route, via: Via, why: string, profile: TierProfile | null): Routed => ({ route, via, why, profile });
const ordinary = (via: Via, why: string): Routed => decided("sonnet/high", via, why, null);
/** A route the provider did not decide: its `why` IS the reason it did not (the switch off, the API's status, a timeout, an answer under the floor), so a fallback is never silent. */
const withReason = (routed: Routed, reason: string): Routed => ({ ...routed, reason, why: reason });

function profiled(route: Route, via: Via, row: RouteRow, haikuSwitch: string | undefined): Routed {
  if (route === "sonnet/high") return ordinary(via, "the ordinary profile");
  if (route === "sonnet/medium") return decided(route, via, "a small row", SONNET_MEDIUM);
  const haiku = haikuProfileOf(row, haikuSwitch);
  return "profile" in haiku ? decided(route, via, "a mechanical row with a command Acceptance", haiku.profile) : ordinary(via, `Haiku was composed but refused: ${haiku.refused}`);
}

/**
 * THE ROUTE OF ONE ROW. Overrides decide before the provider is asked: a `tier:haiku` label (the Haiku profile, or the ordinary one when the existing refusals say so) and a row nothing
 * may lower. Otherwise the four questions go through `decide`; any failure takes {@link fallbackRoute}. Every route is a decision-log line, and a provider route's line carries the
 * route the fallback would have taken (`[fallback would be X]`), which the guard ({@link routeCostReading}) compares.
 */
export async function routeEngineer(row: RouteRow, deps: RouteDeps): Promise<Routed> {
  const routed = await routeOnly(row, deps);
  const wouldBe = routed.via === "jev" ? ` [fallback would be ${fallbackRoute(row)}]` : "";
  recordOutcome("model-routing", `${ID_PREFIX}${row.number}`, `route ${routed.route} via ${routed.via} (${routed.why})${wouldBe}`, deps, routed.reason);
  if (routed.via === "jev") guardRouteCost(deps);
  return routed;
}

/**
 * THE GUARD, RUN AFTER A PROVIDER ROUTE IS LOGGED. Reads the decision log, and when the provider's last {@link GUARD_DECISIONS} routes averaged dearer than the fallback's it appends
 * a {@link ROUTE_COSTLIER_THAN_FALLBACK} event to the failure ledger beside the log (the same state directory). It NEVER throws: the route lowers cost and must not cost a start, and a
 * log or a ledger that cannot be used is reported on the diagnostic, so a guard that could not look is not read as a guard that found nothing.
 */
function guardRouteCost(deps: Pick<RouteDeps, "logPath" | "now" | "diagnostic" | "read">): void {
  const { logPath, diagnostic = (line: string) => { process.stderr.write(`${line}\n`); } } = deps;
  if (logPath === undefined) return;
  try {
    const lines = String((deps.read ?? readFileSync)(logPath, "utf8")).split("\n").filter((line) => line !== "").map(jsonOrNothing);
    const now = (deps.now ?? Date.now)();
    const events = routeCostEvents(routeCostReading(lines), now);
    if (events.length > 0) recordFailures({ logPath: join(dirname(logPath), FAILURE_LEDGER_FILE), events, now, report: diagnostic });
  } catch (err) {
    diagnostic(`agent-org: engineer-route: the route-cost guard could not read the decision log (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** A log line as a value, or `undefined` for one that is not JSON (a half-written tail): `decisionsIn` skips it, so one bad line does not stop the count. */
function jsonOrNothing(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function routeOnly(row: RouteRow, deps: RouteDeps): Promise<Routed> {
  if (row.labels.includes(HAIKU_TIER_LABEL)) {
    const haiku = haikuProfileOf(row, deps.haikuSwitchPath);
    if ("profile" in haiku) return decided("haiku/high", "override", HAIKU_TIER_LABEL, haiku.profile);
    const refusal = `${HAIKU_TIER_LABEL} was refused: ${haiku.refused}`;
    return { ...ordinary("override", refusal), reason: refusal };
  }
  const held = whyHeld(row);
  if (held !== null) return { ...ordinary("refused", held), reason: held };
  const decision = await decide("model-routing", routeState(row), QUESTIONS, { ...deps, id: `${ID_PREFIX}${row.number}` });
  if (decision.via === "none") return withReason(profiled(fallbackRoute(row), "fallback", row, deps.haikuSwitchPath), decision.reason ?? "the provider gave no answer and no reason");
  const given = (name: keyof Answers) => (decision.answers[name].fellBack ? null : decision.answers[name].value);
  const answers: Answers = { mechanical: asBool(given("mechanical")), subsystems: asBool(given("subsystems")), debugging: asBool(given("debugging")),
    score: typeof given("score") === "number" ? (given("score") as number) : null };
  const composed = composeRoute(answers, { regionFiles: regionFileCount(row.body) });
  const routed = profiled(composed, "jev", row, deps.haikuSwitchPath);
  // The line says which answers composed the route, so "sonnet/high" is never just "the ordinary profile": the person reading sees what held it there. An answer that was
  // not given is a null, not a no, and says why it was not given (the provider's own line has the same, per question); `composeRoute` says what each one's absence means.
  const read = (name: keyof Answers): string => {
    const answer = decision.answers[name];
    return answer.fellBack ? `${name}=not given (${answer.reason ?? "no reason"})` : `${name}=${String(answer.value)}`;
  };
  const refusedHaiku = composed === "haiku/high" && routed.profile === null ? `; ${routed.why}` : "";
  const why = `the provider answered: ${(Object.keys(QUESTIONS) as (keyof Answers)[]).map(read).join(", ")}${refusedHaiku}`;
  const notGiven = Object.entries(decision.answers).filter(([, a]) => a.fellBack).map(([name, a]) => `${name}: ${a.reason ?? "no reason"}`);
  return notGiven.length === 0 ? { ...routed, why } : { ...routed, why, reason: `answers not given (${notGiven.join("; ")})` };
}

/** What came of a route, appended to the same log: `merged-first-pass` or `not-first-pass`, so the floor is tuned from results. */
export function recordRouteOutcome(row: number, outcome: string, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  recordOutcome("model-routing", `${ID_PREFIX}${row}`, outcome, deps);
}
