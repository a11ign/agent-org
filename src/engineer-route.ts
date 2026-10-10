// #4629: THE ENGINEER ROUTE. A new engineer's model and effort were Sonnet/high for every row unless a human put `tier:haiku` on it. This module routes each row by atomic questions
// over the row's own text, and `tierOfRow` (wake.ts) asks it beside `haikuTierProfile`.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). Asked through `decide` (#4628), so there is one client, one switch (`model-routing` in `.agent-org/decisions.json`) and one log. With no
// provider, no key, the use switched off, a refusal, a timeout or a floor not met, the route is {@link fallbackRoute}: the Region's file count and the Acceptance's shape. The
// fallback NEVER picks Haiku -- that stays `tier:haiku`'s, a human's.
//
// THE PROVIDER ONLY CLASSIFIES. It answers four questions; {@link composeRoute}, which is pure, turns what it said into a route. Nothing the provider says can start anything
// but a worker the row was already going to get, one rung cheaper, and a worker's own CEILINGS (the Haiku switch and its refusals) are asked of the same code `tier:haiku` uses.
//
// #4764: THE ROUTE MUST NEVER COST MORE THAN THE RULE IT REPLACED, AND NOW IT IS MEASURED. A `covered` question ("does the Acceptance fully cover the Done-when?") was answered `no` on 55
// of 55 provider decisions, because this org's Done-when lists always run past the Acceptance command, and composing it as a gate pinned every provider route to Sonnet/high: dearer than the fallback.
// It is gone; "the Acceptance is a command" is a fact of the row's text, which {@link whyHeld} already reads. Each provider route logs the route the fallback WOULD have taken beside
// it, and {@link routeCostReading} raises a ledger incident when the provider's last {@link GUARD_DECISIONS} routes averaged dearer than that.
//
// #4875: THE ROUTE IS COMPOSED ON THE PROVIDER'S PROBABILITIES, NOT ON ITS CONFIDENCE. Confidence is `(p_max - 1/n) / (1 - 1/n)`, so a floor of 0.7 on a yes/no demanded p >= 0.85 and discarded
// "80% mechanical" as not given; and a Score split across ADJACENT levels, both of which qualify for Sonnet/medium, had a low confidence too. {@link composeRoute} reads P(mechanical =
// yes), P(score <= k) and P(subsystems = yes) against the named thresholds below, each scaled to the cost of being wrong: moving DOWN a tier is cheap to be wrong about, because
// `engineer-escalation.ts` (#4630) catches it. The confidence floor still decides which answers the WINDOW reads ({@link adjustWindow}) and applies to every other use; it no longer discards a routing answer.
//
// THE STATE IS STRUCTURED AND TRIMMED: the title, the Region's entries, the Acceptance's command text and the Done-when list. Never the row's body, which an agent wrote.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractAcceptanceSection } from "./acceptance-commands.ts";
import { FAILURE_LEDGER_FILE, recordFailures, type FailureEvent } from "./failure-ledger.ts";
import { pathToFileURL } from "node:url";
import { decide, decisionLogPathFrom, decisionsIn, readSwitches, recordOutcome, type Answer, type DecisionDeps, type Question, type ScoreLevels } from "./decision-provider.ts";
import { stateEntryPath } from "./host-config.ts";
import { LANE_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { extractLabeledSection, extractRegionSection, splitRegionEntry } from "./region-paths.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";
import { AUTOCOMPACT_WINDOW_TOKENS, clampWindow, haikuTierProfile, HAIKU_TIER_LABEL, MIN_WORKING_ROOM_TOKENS, ordinaryTierProfile, SONNET_WINDOW_RUNGS, type TierProfile } from "./worker-profile.ts";

export type Route = "haiku/high" | "sonnet/medium" | "sonnet/high";
/** `override` is a `tier:haiku` label deciding; `refused` is a row nothing may lower; `jev` is a provider's answers composed; `fallback` is the file-count rule. */
export type Via = "override" | "refused" | "jev" | "fallback";
export type RouteRow = { number: number; title: string; labels: readonly string[]; body: string };
export type Routed = { route: Route; via: Via;
  /** THE REASON THE ROUTE WAS TAKEN, one text: the work tick's `routed ...` journal line and the decision log's outcome line (`route <route> via <via> (<why>)`) both print it. */ why: string;
  /** `null` is the ordinary Sonnet/high profile at the ordinary window, byte-identical to before. */ profile: TierProfile | null;
  /** WHY THE WINDOW IS WHAT IT IS (#4738), only when it is not simply the route's own: the Region's size, what the provider's answers did to it, or the ceiling that held it. Kept apart from `why`, which IS the reason a fallback was taken. */ windowWhy?: string;
  /** Why the provider did not decide this route (a fallback), or which questions' probabilities it did not give (a `jev` route held to what the rest compose); absent when it decided it. */ reason?: string };
/** One answer per question; `null` is an answer that was not given: malformed, or under the confidence floor. The WINDOW reads these ({@link adjustWindow}); the route reads {@link Readings}. */
export type Answers = { mechanical: boolean | null; subsystems: boolean | null; debugging: boolean | null; score: number | null };
/**
 * WHAT {@link composeRoute} READS (#4875): the provider's probabilities. `null` is a distribution the provider did not give or that could not be read, which is "not given" and never
 * a probability of zero. The three yes/no questions are P(yes); `score` is P(level) for each level 1 to 5, keyed by the level.
 */
export type Readings = { mechanical: number | null; subsystems: number | null; debugging: number | null; score: Readonly<Record<string, number>> | null };

/** The Region's largest size that is still "a small row" (the row's own number). */
export const SMALL_ROW_FILES = 3;
/** The complexity `score` a Haiku row may be at most (3 since a11ign#4877, the chairman's direction on the trial report, a11ign#4627), and the one a Sonnet/medium row is. */
export const HAIKU_MAX_SCORE = 3;
export const MEDIUM_SCORE = 3;
// THE ROUTING THRESHOLDS (#4875, the chairman's starting values, to be calibrated from the probabilities the decision log now keeps). Each is a probability, and each is LOW on purpose:
// a row sent down a tier wrongly is caught by the escalation (a Haiku start costs about $0.10 and a restart; a Sonnet/high row's median cost is $1.01), so the price of being wrong
// is small and the price of never trying is the cost of every row.
/** Haiku/high needs P(mechanical = yes) of at least this... */
export const HAIKU_MIN_P_MECHANICAL = 0.65;
/** ...AND P(score <= {@link HAIKU_MAX_SCORE}) of at least this. */
export const HAIKU_MIN_P_SCORE = 0.6;
/** Sonnet/medium needs P(score <= {@link MEDIUM_SCORE}) of at least this... */
export const MEDIUM_MIN_P_SCORE = 0.6;
/** ...AND P(subsystems = yes) BELOW this. */
export const MEDIUM_MAX_P_SUBSYSTEMS = 0.5;
/** A row is held at Sonnet/high, whatever else is said, when P(debugging = yes) reaches this: the cause is not in the row, and a cheap tier is where that is expensive. */
export const HOLD_AT_P_DEBUGGING = 0.5;
/** A sum of probabilities is rounded to this many places, so a row that is exactly 0.6 by the arithmetic is not 0.5999999999999999 by the machine's. */
const PROBABILITY_PLACES = 6;
const MEDIUM_EFFORT = "medium";
const DIRECTORY_FILES = SMALL_ROW_FILES + 1;
const TITLE_CHARS = 200;
const REGION_ENTRIES = 12;
const ENTRY_CHARS = 120;
const ACCEPTANCE_CHARS = 600;
const DONE_WHEN_ITEMS = 8;
const DONE_WHEN_CHARS = 200;
const ID_PREFIX = "row-";

// --- the criteria: what each answer means, with rows whose outcome is known (#4764 change 3 and #4752, the method of #4627's 07:45Z direction) ---
//
// THE PROVIDER WAS UNSURE BECAUSE IT WAS TOLD LITTLE: `score` came back under the floor on 34 of 55 provider decisions and `subsystems` on 30 (the decision log, 2026-10-10),
// from five bare level phrases and two bare yes/no glosses. TypeSafe's own guidance (docs.typesafe.ai/primitives/advanced, /confidence, /primitives/choice, /primitives/score) is a
// Choice option with `what`, `not_for` and `examples`, a Score level with a `summary` and its `signals`, and examples taken from real cases whose answer is known. Every example
// here is a row of ours: its number and the merge that settled the answer.
//
// THE STRUCTURE IS SENT AS STRUCTURE (#4752): the API's schema takes a string, an object or an array for each option and level, and `wire()` passes what it is given. #4764 had to
// render the same data into one string per option because `wire()` typed them as text; `Described` (triage-provider.ts) is the widening, and the shape is TypeSafe's own.
// "Outcome known" is MERGED and what it changed: `merged` is `git diff --numstat <merge>^1 <merge>` less the `.acceptance/` and `.changeset/` files, as "<n> files, +<added> -<removed>".
// First-pass CI is not in any log this module can read.
type Example = { row: string; what: string; merged: string };
type Level = { summary: string; signals: readonly string[]; examples: readonly Example[] };
type Option = { what: string; notFor: string; examples: readonly Example[] };
type YesNo = Readonly<Record<"yes" | "no", Option>>;

/** The five levels of a `score`, level 1 first: a level's position IS its score (agent-org#564). */
export const SCORE_LEVEL_DATA: readonly [Level, Level, Level, Level, Level] = Object.freeze([
  { summary: "one stated edit in one file",
    signals: ["the Region names one source file (and its test)", "the Done-when is one assertion", "the row quotes the text or the value to change"],
    examples: [{ row: "a11ign#4522", what: "the Haiku tier's effort constant", merged: "2 files, +3 -3" },
      { row: "a11ign#4618", what: "a counter no longer read as an unknown failure class", merged: "2 files, +15 -3" }] },
  { summary: "a few stated edits, each independent",
    signals: ["the Region names 2 to 8 files and the edit is the same kind in each", "each edit is stated by the row and none needs another"],
    examples: [{ row: "a11ign#4557", what: "renamed paths and headers in two copies", merged: "2 files, +11 -11" },
      { row: "a11ign#4582", what: "thirteen copies naming originals that moved", merged: "8 files, +28 -19" }] },
  { summary: "a new small unit with a test, in one subsystem",
    signals: ["one new module and its test, or one module grown", "the Region stays inside one directory or one concern", "the Acceptance runs that module's own test"],
    examples: [{ row: "a11ign#4748", what: "a new reading over the decision log", merged: "2 files, +478 -0" },
      { row: "a11ign#4635", what: "a new review-depth module", merged: "2 files, +187 -0" }] },
  { summary: "a change that touches how two modules agree",
    signals: ["the Region names a module and its caller, or a wire, a type or a log format that both read", "a test of one module is not enough: the other must be run against it"],
    examples: [{ row: "a11ign#4629", what: "the route module and its wiring into the spawn path", merged: "3 files, +476 -20" },
      { row: "a11ign#4630", what: "the escalation module and the tick that calls it", merged: "5 files, +737 -17" }] },
  { summary: "a new seam, a migration or anything whose shape the row does not state",
    signals: ["the Region is a directory, or the row says migrate, replace or every", "the Done-when leaves a design or a reading open", "files in more than one area (source, host scripts, package.json, workflows)"],
    examples: [{ row: "a11ign#4418", what: "a new place the Acceptance is read from", merged: "11 files, +404 -31" },
      { row: "a11ign#4389", what: "110 .mjs files become .ts", merged: "473 files, +6132 -9492" }] },
]);

/** The `mechanical` question's two options. `yes` is the one that can send a row to Haiku, so its `not_for` names what looks small and is not. */
export const MECHANICAL_DATA: YesNo = Object.freeze({
  yes: { what: "every edit is stated by the row itself (a rename, a move, a sweep, a one-line fix) and nothing is left to design",
    notFor: "a new module, a new rule or a wire the row describes but does not spell out, however small the diff turns out to be",
    examples: [{ row: "a11ign#4522", what: "one constant's value, quoted by the row", merged: "2 files, +3 -3" },
      { row: "a11ign#4557", what: "renamed paths and headers in two copies, each listed", merged: "2 files, +11 -11" },
      { row: "a11ign#4613", what: "one path in a unit file, the row naming the old and the new", merged: "1 file, +1 -1" }] },
  no: { what: "the row leaves something to design: a new module, a new reading, a rule or a wire it describes without spelling every edit out",
    notFor: "a rename or a sweep whose every edit the row lists",
    examples: [{ row: "a11ign#4748", what: "a new reading over the decision log", merged: "2 files, +478 -0" },
      { row: "a11ign#4629", what: "the route module and its wiring into the spawn path", merged: "3 files, +476 -20" },
      { row: "a11ign#4639", what: "a new scheduled-measurement module", merged: "2 files, +394 -0" }] },
});

/** The `subsystems` question's two options. `yes` is the one that holds a row at Sonnet/high only when the other rules would have lowered it. */
export const SUBSYSTEMS_DATA: YesNo = Object.freeze({
  yes: { what: "the Region spans modules that interact, so a change in one must be understood against the other (a producer and the consumer of one format, a module and the tick that calls it)",
    notFor: "the same edit repeated across files that do not interact, or one module and its own test",
    examples: [{ row: "a11ign#4629", what: "the route module and the spawn path that calls it", merged: "3 files, +476 -20" },
      { row: "a11ign#4630", what: "the escalation module and the tick", merged: "5 files, +737 -17" },
      { row: "agent-org#564", what: "one request shape agreed by the route, the provider client and the triage client", merged: "5 files, +180 -36" }] },
  no: { what: "the Region is one module and its test, or the same edit in several files that do not interact",
    notFor: "a module and its caller, or two modules that read one format",
    examples: [{ row: "a11ign#4748", what: "one new reading module", merged: "2 files, +478 -0" },
      { row: "a11ign#4639", what: "one scheduled-measurement module", merged: "2 files, +394 -0" },
      { row: "a11ign#4582", what: "the same path fix in thirteen copies, none reading another", merged: "8 files, +28 -19" }] },
});

/** The `debugging` question's two options. `yes` holds a row at Sonnet/high whatever else is said, so it is the one a row that states its cause must not reach. */
export const DEBUGGING_DATA: YesNo = Object.freeze({
  yes: { what: "the cause is not stated in the row: it names a symptom, perhaps with hypotheses and the check that would tell them apart, and the cause has to be found before anything is fixed",
    notFor: "a row that names the defect and the change, even when finding it was hard for whoever filed it",
    examples: [{ row: "a11ign#3228", what: "two workers do not wake at their reserved addresses and \"the cause is unread\"", merged: "no diff of its own: the cause was read on the box and filed as #3241 and #3250" },
      { row: "a11ign#1105", what: "a navigating submit intermittently records \"unknown\", 2 of 170, with no cause named", merged: "12 files, +400 -19" }] },
  no: { what: "the row names the defect and the change that fixes it; what is left is making that change and proving it",
    notFor: "a symptom with hypotheses and no named cause",
    examples: [{ row: "a11ign#4613", what: "a unit runs a file the rename removed, and the row names the new path", merged: "1 file, +1 -1" },
      { row: "a11ign#4574", what: "the decider counts a NO VERDICT status as a failed run, and the row names the function", merged: "2 files, +30 -3" }] },
});

const exampleText = ({ row, what, merged }: Example): string => `${row}: ${what} (merged: ${merged})`;
/** TypeSafe's Choice option shape: `what`, `not_for` and `examples` (docs.typesafe.ai/primitives/advanced, "Structured Choice options"). */
const optionOf = ({ what, notFor, examples }: Option) => ({ what, not_for: notFor, examples: examples.map(exampleText) });
/** TypeSafe's Score level shape: a `summary` and its `signals` (docs.typesafe.ai/primitives/advanced, "Structured Score levels"), with the examples that settled it. */
const levelOf = ({ summary, signals, examples }: Level) => ({ summary, signals: [...signals], examples: examples.map(exampleText) });
const optionsOf = ({ yes, no }: YesNo) => ({ yes: optionOf(yes), no: optionOf(no) });

function scoreLevels(): ScoreLevels {
  const [one, two, three, four, five] = SCORE_LEVEL_DATA;
  return [levelOf(one), levelOf(two), levelOf(three), levelOf(four), levelOf(five)];
}

/** The four atomic questions. Every fallback is the answer that does NOT lower the route; {@link fallbackRoute} decides what a fallback row gets. */
export const QUESTIONS: Readonly<Record<keyof Answers, Question>> = Object.freeze({
  mechanical: { type: "choice", criteria: optionsOf(MECHANICAL_DATA), fallback: "no",
    instructions: "Is this row MECHANICAL: a rename, a move, a sweep or a one-line fix where every edit is stated by the row itself and nothing is left to design?" },
  subsystems: { type: "choice", criteria: optionsOf(SUBSYSTEMS_DATA), fallback: "yes",
    instructions: "Does this row need reasoning ACROSS SUBSYSTEMS: its Region spans modules that interact, so a change in one must be understood against another?" },
  debugging: { type: "choice", criteria: optionsOf(DEBUGGING_DATA), fallback: "yes",
    instructions: "Does this row require DEBUGGING AN UNKNOWN FAILURE: the cause is not stated in the row and has to be found before anything is fixed?" },
  // The provider scores a level by its POSITION in `levels` (from zero); `decide` hands the callers the 1-based level, so `fallback: 5` is the last description.
  score: { type: "score", fallback: 5, levels: scoreLevels(),
    instructions: "Complexity of the row, as the level whose summary and signals fit it. Signals: file count, whether the Acceptance is a command, whether the Done-when is checkable." },
});

const asBool = (value: unknown): boolean | null => (value === "yes" ? true : value === "no" ? false : null);

/** P(score <= `level`): the sum of the distribution's levels 1 to `level`, which is what a row split across ADJACENT levels is worth to a tier that takes both. */
export function scoreAtMost(distribution: Readonly<Record<string, number>>, level: number): number {
  const total = Object.entries(distribution).filter(([at]) => Number(at) <= level).reduce((sum, [, p]) => sum + p, 0);
  return Number(total.toFixed(PROBABILITY_PLACES));
}

/** `regionFiles` is {@link regionFileCount}: 0 is a Region that names nothing, which is never "small". */
const isSmallRegion = (regionFiles: number): boolean => regionFiles > 0 && regionFiles <= SMALL_ROW_FILES;

/** Mechanical, and either a low score or (the score NOT given) a Region small enough that a mechanical row's stated edits cannot be many. */
function takesHaiku({ mechanical, score }: Readings, regionFiles: number): boolean {
  if (mechanical === null || mechanical < HAIKU_MIN_P_MECHANICAL) return false;
  return score === null ? isSmallRegion(regionFiles) : scoreAtMost(score, HAIKU_MAX_SCORE) >= HAIKU_MIN_P_SCORE;
}

/** A score that is probably at most {@link MEDIUM_SCORE}, and subsystems not probably yes (not given passes: a row this small is not reasoned across modules by default). */
function takesMedium({ subsystems, score }: Readings): boolean {
  if (score === null || scoreAtMost(score, MEDIUM_SCORE) < MEDIUM_MIN_P_SCORE) return false;
  return subsystems === null || subsystems < MEDIUM_MAX_P_SUBSYSTEMS;
}

/**
 * THE ROUTE A SET OF PROBABILITIES COMPOSES, PURE (#4875, on #4764's rungs). Probably debugging an unknown failure holds a row at Sonnet/high ({@link HOLD_AT_P_DEBUGGING}). Otherwise,
 * in order: Haiku/high ({@link takesHaiku}), Sonnet/medium ({@link takesMedium}), and ANYTHING ELSE is Sonnet/high as before. A question whose distribution was not given never lowers
 * a row, except that an unscored mechanical row in a small Region may go to Haiku and a debugging question not given does not hold one.
 */
export function composeRoute(readings: Readings, { regionFiles }: { regionFiles: number }): Route {
  if (readings.debugging !== null && readings.debugging >= HOLD_AT_P_DEBUGGING) return "sonnet/high";
  if (takesHaiku(readings, regionFiles)) return "haiku/high";
  return takesMedium(readings) ? "sonnet/medium" : "sonnet/high";
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
const WOULD_BE = /^route (\S+)(?: window \d+k(?: \([^)]*\))?)? via jev .*\[fallback would be (\S+)\]$/;
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

/** THE `--autocompact` WINDOW A ROUTE'S START GETS (#4738), read off its profile: no profile is the ordinary one, at {@link AUTOCOMPACT_WINDOW_TOKENS}. */
export const windowOf = ({ profile }: Pick<Routed, "profile">): number => profile?.autocompactWindow ?? AUTOCOMPACT_WINDOW_TOKENS;
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

// --- THE WINDOW (a11ign/a11ign#4738, the chairman's "use 1b" on #4627) ---
//
// A route sets the context window as well as the model and effort, because a row that touches many files compacts mid-edit in the ordinary one. It is sized in two steps:
// {@link fallbackWindow} from the Region alone (always, so no provider is needed), then {@link adjustWindow} by the provider's `score` and `subsystems` answers one rung either way,
// and only when the answer was given at or over the floor AND `model-routing-window` is on in `.agent-org/decisions.json`. The rungs and the clamp are `worker-profile.ts`'s.

/** One large module read costs about this many tokens: layer-edges.mjs ~11k and ADR 0040 ~16k (the figures `worker-profile.ts` measured), at the middle. */
const FILE_READ_TOKENS = 12_000;
/** The files the ordinary window's working room reads ONCE: a row naming this many cannot be read and then edited inside it without a compaction between. */
export const LARGE_ROW_FILES = Math.floor(MIN_WORKING_ROOM_TOKENS / FILE_READ_TOKENS);
/** Twice that: each file read once to understand it and again around the edits. */
export const LARGEST_ROW_FILES = LARGE_ROW_FILES * 2;
/** Two repositories mean two checkouts' layouts and conventions held at once, whatever the file count; three is the widest row there is. */
export const MULTI_REPOSITORIES = 2;
export const LARGEST_REPOSITORIES = 3;
/** The provider's complexity `score` from which a row is larger than its Region says ("a change that touches how two modules agree") and up to which it is smaller ("a few stated edits"). */
export const LARGER_SCORE = 4;
export const SMALLER_SCORE = 2;
/** The key in `.agent-org/decisions.json` that lets the provider's answers move the window. The router's own `model-routing` key is what lets it be ASKED. */
export const WINDOW_SWITCH = "model-routing-window";
const TOKENS_PER_K = 1_000;

export const windowLabel = (tokens: number): string => `${Math.round(tokens / TOKENS_PER_K)}k`;

export type RegionSize = { files: number; repositories: number };
/** The Region's files (a directory counts as {@link DIRECTORY_FILES}) and the repositories its entries are keyed to; a bare path is the project's first repository. */
export function regionSize(body: string): RegionSize {
  const keys = new Set(regionEntries(body).map((entry) => splitRegionEntry(entry).key));
  return { files: regionFileCount(body), repositories: keys.size };
}

type Sizing = { tokens: number; basis: string; /** The provider's answers were read, so the line says what they did even when they moved nothing. */ provider: boolean };

/** WITH NO PROVIDER: the ordinary window for a row under {@link LARGE_ROW_FILES} files and {@link MULTI_REPOSITORIES} repositories, the next rung from either, the largest from {@link LARGEST_ROW_FILES} or {@link LARGEST_REPOSITORIES}. */
export function fallbackWindow(body: string): { tokens: number; basis: string } {
  const { files, repositories } = regionSize(body);
  const [ordinaryRung, largeRung, largestRung] = SONNET_WINDOW_RUNGS;
  const largest = files >= LARGEST_ROW_FILES || repositories >= LARGEST_REPOSITORIES;
  const large = files >= LARGE_ROW_FILES || repositories >= MULTI_REPOSITORIES;
  return { tokens: largest ? largestRung : large ? largeRung : ordinaryRung, basis: `the Region names files=${files} repositories=${repositories}` };
}

/**
 * THE PROVIDER'S READING OF A SIZE, PURE. One rung UP when either answer says the row is larger (`subsystems` yes, or a score of at least {@link LARGER_SCORE}); one rung DOWN only
 * when BOTH are given and say smaller, because a compaction mid-edit costs more than the rung does. An answer that was not given (`null`) counts for nothing in either direction.
 */
export function adjustWindow(tokens: number, { score, subsystems }: Pick<Answers, "score" | "subsystems">): number {
  const larger = subsystems === true || (score !== null && score >= LARGER_SCORE);
  const smaller = subsystems === false && score !== null && score <= SMALLER_SCORE;
  const at = Math.max(0, SONNET_WINDOW_RUNGS.indexOf(tokens));
  const moved = Math.min(Math.max(at + (larger ? 1 : smaller ? -1 : 0), 0), SONNET_WINDOW_RUNGS.length - 1);
  return SONNET_WINDOW_RUNGS[moved];
}

/** What the provider answered, for the window only: the answers composed, and why each one that is `null` was not given. */
type Provided = { answers: Answers; notGiven: Partial<Record<keyof Answers, string>> };

function windowSwitchOn(deps: RouteDeps): boolean {
  const switches = deps.switches ?? (deps.switchesPath === undefined ? {} : readSwitches(deps.switchesPath, { diagnostic: deps.diagnostic ?? printDiagnostic, state: deps.state ?? processState, read: deps.read ?? readFileSync }));
  return (switches as Record<string, boolean | undefined>)[WINDOW_SWITCH] === true;
}

function sizeOf(row: RouteRow, provided: Provided | null, deps: RouteDeps): Sizing {
  const base = fallbackWindow(row.body);
  if (provided === null || !windowSwitchOn(deps)) return { ...base, provider: false };
  const tokens = adjustWindow(base.tokens, provided.answers);
  const held = (["score", "subsystems"] as const).filter((name) => provided.answers[name] === null).map((name) => `${name}: ${provided.notGiven[name] ?? "no reason"}`);
  const moved = tokens === base.tokens ? `kept it at ${windowLabel(tokens)}` : `${tokens > base.tokens ? "raised" : "lowered"} it from ${windowLabel(base.tokens)}`;
  const heldText = held.length === 0 ? "" : ` (not given, so left out: ${held.join("; ")})`;
  return { tokens, basis: `${base.basis}; the provider's answers ${moved}${heldText}`, provider: true };
}

/** The route's profile at `tokens`: a profile it already has with the window set, or for the ordinary route no profile at all while the window is the ordinary one (byte-identical to before). */
function profileAt(routed: Routed, tokens: number): TierProfile | null {
  if (routed.profile !== null) return { ...routed.profile, autocompactWindow: tokens };
  if (tokens === AUTOCOMPACT_WINDOW_TOKENS) return null;
  return ordinaryTierProfile({ autocompactWindow: tokens, why: `the ordinary profile at a ${windowLabel(tokens)} window (a11ign/a11ign#4738)` });
}

/** THE ROUTE WITH ITS WINDOW. {@link clampWindow} has the last word, so a Haiku route is at its ceiling whatever the Region size or the provider says. */
function sizeWindow(routed: Routed, row: RouteRow, provided: Provided | null, deps: RouteDeps): Routed {
  const sizing = sizeOf(row, provided, deps);
  const model = routed.profile?.model ?? "sonnet";
  const tokens = clampWindow(model, sizing.tokens);
  const held = sizing.tokens > AUTOCOMPACT_WINDOW_TOKENS && tokens < sizing.tokens;
  const note = held ? `${sizing.basis}; held to the ceiling of ${model}` : sizing.provider || tokens !== windowOf(routed) ? sizing.basis : null;
  return { ...routed, profile: profileAt(routed, tokens), ...(note === null ? {} : { windowWhy: note }) };
}

/**
 * THE ROUTE OF ONE ROW. Overrides decide before the provider is asked: a `tier:haiku` label (the Haiku profile, or the ordinary one when the existing refusals say so) and a row nothing
 * may lower. Otherwise the four questions go through `decide`; any failure takes {@link fallbackRoute}. Every route is a decision-log line, and a provider route's line carries the
 * route the fallback would have taken (`[fallback would be X]`), which the guard ({@link routeCostReading}) compares.
 */
export async function routeEngineer(row: RouteRow, deps: RouteDeps): Promise<Routed> {
  const { routed: chosen, provided } = await routeOnly(row, deps);
  const routed = sizeWindow(chosen, row, provided, deps);
  const window = `${windowLabel(windowOf(routed))}${routed.windowWhy === undefined ? "" : ` (${routed.windowWhy})`}`;
  const wouldBe = routed.via === "jev" ? ` [fallback would be ${fallbackRoute(row)}]` : "";
  recordOutcome("model-routing", `${ID_PREFIX}${row.number}`, `route ${routed.route} window ${window} via ${routed.via} (${routed.why})${wouldBe}`, deps, routed.reason);
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

type Chosen = { routed: Routed; /** The provider's answers, when it gave any: the window reads them too. */ provided: Provided | null };
const alone = (routed: Routed): Chosen => ({ routed, provided: null });

async function routeOnly(row: RouteRow, deps: RouteDeps): Promise<Chosen> {
  if (row.labels.includes(HAIKU_TIER_LABEL)) {
    const haiku = haikuProfileOf(row, deps.haikuSwitchPath);
    if ("profile" in haiku) return alone(decided("haiku/high", "override", HAIKU_TIER_LABEL, haiku.profile));
    const refusal = `${HAIKU_TIER_LABEL} was refused: ${haiku.refused}`;
    return alone({ ...ordinary("override", refusal), reason: refusal });
  }
  const held = whyHeld(row);
  if (held !== null) return alone({ ...ordinary("refused", held), reason: held });
  const decision = await decide("model-routing", routeState(row), QUESTIONS, { ...deps, id: `${ID_PREFIX}${row.number}` });
  if (decision.via === "none") return alone(withReason(profiled(fallbackRoute(row), "fallback", row, deps.haikuSwitchPath), decision.reason ?? "the provider gave no answer and no reason"));
  const composed = composeRoute(readingsOf(decision.answers), { regionFiles: regionFileCount(row.body) });
  const routed = profiled(composed, "jev", row, deps.haikuSwitchPath);
  // The line says which probabilities composed the route, so "sonnet/high" is never just "the ordinary profile": the person reading sees what held it there. A distribution that was
  // not given is a null, not a zero, and says why; `composeRoute` says what each one's absence means.
  const refusedHaiku = composed === "haiku/high" && routed.profile === null ? `; ${routed.why}` : "";
  const why = `the provider's probabilities: ${readingLines(decision.answers).join(", ")}${refusedHaiku}`;
  const unread = (Object.keys(QUESTIONS) as (keyof Answers)[]).filter((name) => decision.answers[name].probabilities === undefined);
  const reason = unread.length === 0 ? {} : { reason: `probabilities not given (${unread.map((name) => `${name}: ${whyUnread(decision.answers[name])}`).join("; ")})` };
  return { routed: { ...routed, why, ...reason }, provided: windowAnswers(decision.answers) };
}

/** P(yes), or `null` when no distribution was read. A distribution that does not name `yes` is a probability of zero: the provider put nothing there. */
const pYes = ({ probabilities }: Answer): number | null => (probabilities === undefined ? null : probabilities.yes ?? 0);

function readingsOf(answers: Record<string, Answer>): Readings {
  return { mechanical: pYes(answers.mechanical), subsystems: pYes(answers.subsystems), debugging: pYes(answers.debugging), score: answers.score.probabilities ?? null };
}

/** Why a question has no distribution: the reason it was malformed, or, for an answer that was well formed and carried none, that. */
const whyUnread = (answer: Answer): string => (answer.confidence === undefined ? answer.reason ?? "no reason" : "the answer carried no readable probabilities");

const showP = (p: number): string => p.toFixed(3);

/** One reading per rung the route turns on, as it is printed on the route's line. */
function readingLines(answers: Record<string, Answer>): string[] {
  const { mechanical, subsystems, debugging, score } = readingsOf(answers);
  const yes = (name: "mechanical" | "subsystems" | "debugging", p: number | null): string => `P(${name}=yes)=${p === null ? `not given (${whyUnread(answers[name])})` : showP(p)}`;
  const levels = (upTo: number): string => `P(score<=${upTo})=${score === null ? `not given (${whyUnread(answers.score)})` : showP(scoreAtMost(score, upTo))}`;
  return [yes("mechanical", mechanical), yes("subsystems", subsystems), yes("debugging", debugging), ...[...new Set([HAIKU_MAX_SCORE, MEDIUM_SCORE])].map(levels)];
}

/** THE WINDOW'S ANSWERS (unchanged by #4875): the values given at or over the floor, and why each one that was not given was not. */
function windowAnswers(raw: Record<string, Answer>): Provided {
  const given = (name: keyof Answers) => (raw[name].fellBack ? null : raw[name].value);
  const answers: Answers = { mechanical: asBool(given("mechanical")), subsystems: asBool(given("subsystems")), debugging: asBool(given("debugging")),
    score: typeof given("score") === "number" ? (given("score") as number) : null };
  const notGiven = Object.entries(raw).filter(([, a]) => a.fellBack).map(([name, a]) => [name, a.reason ?? "no reason"]);
  return { answers, notGiven: Object.fromEntries(notGiven) };
}

/** What came of a route, appended to the same log: `merged-first-pass` or `not-first-pass`, so the floor is tuned from results. */
export function recordRouteOutcome(row: number, outcome: string, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  recordOutcome("model-routing", `${ID_PREFIX}${row}`, outcome, deps);
}

// --- THE WINDOW AGAINST ITS COMPACTIONS, PER ROUTE (a11ign/a11ign#4738 item 4) ---
//
// The window a route chose is on its outcome line already. The compactions, the cost and the pull request are MEASURED in the trace store, so they are joined to it at read time and not
// copied into a second log that would then disagree; the one thing the log adds is the verdict, `window too small`, which is a DEFINITION (more than {@link WINDOW_TOO_SMALL_COMPACTIONS}
// compactions in one session) and so is written once per row. `node src/engineer-route.ts [--log <decisions>] [--store <events.ndjson>] [--record]` prints it.

/** A row that compacts more than this many times in one session had a window too small for it. */
export const WINDOW_TOO_SMALL_COMPACTIONS = 2;
export const WINDOW_TOO_SMALL = "window too small";
const ROUTE_LINE = /^route (\S+) window (\d+)k(?: \([^)]*\))? via \S+/;
const ROW_ID = /^row-(\d+)$/;

export type WindowReading = { row: number; route: string; windowK: number; outcome: string | null; tooSmall: boolean };
/** What the trace store measured of a row: its most compactions in one session and its priced cost. */
export type WindowFacts = { compactions: number; costUsd: number };

/** ONE READING PER ROW from the decision log's lines: the LAST route line (a row routed twice took the later), the last outcome that is neither a route nor a verdict, and whether the verdict is there. */
export function windowReadings(lines: readonly unknown[]): WindowReading[] {
  const byRow = new Map<number, WindowReading>();
  for (const line of lines as { use?: unknown; id?: unknown; outcome?: unknown }[]) {
    if (line?.use !== "model-routing" || typeof line.id !== "string" || typeof line.outcome !== "string") continue;
    const row = Number(ROW_ID.exec(line.id)?.[1]);
    if (!Number.isInteger(row)) continue;
    const route = ROUTE_LINE.exec(line.outcome);
    const had = byRow.get(row) ?? { row, route: "", windowK: 0, outcome: null, tooSmall: false };
    if (route !== null) byRow.set(row, { ...had, route: route[1], windowK: Number(route[2]) });
    else if (line.outcome.startsWith(WINDOW_TOO_SMALL)) byRow.set(row, { ...had, tooSmall: true });
    else byRow.set(row, { ...had, outcome: line.outcome });
  }
  return [...byRow.values()].filter((reading) => reading.route !== "");
}

/** Whether a row's compactions are a window too small. A row the store has no sessions for (`undefined`) is not one: absence is not a reading. */
export const isWindowTooSmall = (facts: WindowFacts | undefined): boolean => facts !== undefined && facts.compactions > WINDOW_TOO_SMALL_COMPACTIONS;

/** One line per route and window: the rows, their compactions (total and the most one took), the cost, the outcomes the log holds, and how many were too small. */
export function windowReportLines(readings: readonly WindowReading[], facts: ReadonlyMap<number, WindowFacts>): string[] {
  const groups = new Map<string, WindowReading[]>();
  for (const reading of readings) groups.set(`${reading.route} window ${reading.windowK}k`, [...(groups.get(`${reading.route} window ${reading.windowK}k`) ?? []), reading]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, rows]) => {
    const measured = rows.map((r) => facts.get(r.row)).filter((f): f is WindowFacts => f !== undefined);
    const compactions = measured.map((f) => f.compactions);
    const outcomes = rows.reduce((count, r) => count.set(r.outcome ?? "no outcome recorded", (count.get(r.outcome ?? "no outcome recorded") ?? 0) + 1), new Map<string, number>());
    return `${label}: ${rows.length} rows (${measured.length} in the store), compactions ${compactions.reduce((a, b) => a + b, 0)} (most in one row ${Math.max(0, ...compactions)}), `
      + `cost $${measured.reduce((a, f) => a + f.costUsd, 0).toFixed(2)}, too small ${rows.filter((r) => r.tooSmall || isWindowTooSmall(facts.get(r.row))).length}, `
      + `outcomes ${[...outcomes].map(([name, n]) => `${name} ${n}`).join(", ")}`;
  });
}

/** The verdict on a row, appended once to the decision log: `window too small` with what it measured. */
export function recordWindowTooSmall(row: number, { window, compactions }: { window: string; compactions: number }, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  recordOutcome("model-routing", `${ID_PREFIX}${row}`, `${WINDOW_TOO_SMALL}: ${compactions} compactions at ${window}`, deps);
}

async function windowReportMain(argv: readonly string[]): Promise<void> {
  const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
  const logPath = (argv.includes("--log") ? flag("--log") : undefined) ?? decisionLogPathFrom(stateEntryPath("wake-ledger"));
  // Dynamic, so the work tick that imports this module does not load the trace store for a report it never prints.
  const [{ eventsForRow, readStore, repriceEvents }, { defaultStore }, { measuresOf }] = await Promise.all([import("./trace/store.ts"), import("./trace/otel-receiver.ts"), import("./trace/haiku-tier-report.ts")]);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const events = repriceEvents(readStore((argv.includes("--store") ? flag("--store") : undefined) ?? defaultStore()));
  const readings = windowReadings(lines);
  const facts = new Map<number, WindowFacts>();
  for (const { row } of readings) {
    if (eventsForRow(events, { rows: [row], prs: [] }).length === 0) continue;
    const measured = measuresOf({ number: row, haiku: false, closedAt: 0, pr: null }, events);
    facts.set(row, { compactions: measured.compactions, costUsd: measured.costUsd });
  }
  process.stdout.write(`${windowReportLines(readings, facts).join("\n")}\n`);
  if (!argv.includes("--record")) return;
  for (const reading of readings) {
    if (reading.tooSmall || !isWindowTooSmall(facts.get(reading.row))) continue;
    recordWindowTooSmall(reading.row, { window: `${reading.windowK}k`, compactions: facts.get(reading.row)?.compactions ?? 0 }, { logPath });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await windowReportMain(process.argv.slice(2));
