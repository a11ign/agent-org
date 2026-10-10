// #4629: THE ENGINEER ROUTE. A new engineer's model and effort were Sonnet/high for every row unless a human put `tier:haiku` on it. This module routes each row by atomic questions
// over the row's own text, and `tierOfRow` (wake.ts) asks it beside `haikuTierProfile`.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). Asked through `decide` (#4628), so there is one client, one switch (`model-routing` in `.agent-org/decisions.json`) and one log. With no
// provider, no key, the use switched off, a refusal, a timeout or a floor not met, the route is {@link fallbackRoute}: the Region's file count and the Acceptance's shape. The
// fallback NEVER picks Haiku -- that stays `tier:haiku`'s, a human's.
//
// THE PROVIDER ONLY CLASSIFIES. It answers five questions; {@link composeRoute}, which is pure, turns the answers into a route. Nothing the provider says can start anything
// but a worker the row was already going to get, one rung cheaper, and a worker's own CEILINGS (the Haiku switch and its refusals) are asked of the same code `tier:haiku` uses.
//
// THE STATE IS STRUCTURED AND TRIMMED: the title, the Region's entries, the Acceptance's command text and the Done-when list. Never the row's body, which an agent wrote.
import { extractAcceptanceSection } from "./acceptance-commands.ts";
import { decide, recordOutcome, type DecisionDeps, type Question } from "./decision-provider.ts";
import { LANE_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { extractLabeledSection, extractRegionSection } from "./region-paths.ts";
import { AUTOCOMPACT_WINDOW_TOKENS, haikuTierProfile, HAIKU_TIER_LABEL, type TierProfile } from "./worker-profile.ts";

export type Route = "haiku/high" | "sonnet/medium" | "sonnet/high";
/** `override` is a `tier:haiku` label deciding; `refused` is a row nothing may lower; `jev` is a provider's answers composed; `fallback` is the file-count rule. */
export type Via = "override" | "refused" | "jev" | "fallback";
export type RouteRow = { number: number; title: string; labels: readonly string[]; body: string };
export type Routed = { route: Route; via: Via; why: string; /** `null` is the ordinary Sonnet/high profile, byte-identical to before. */ profile: TierProfile | null;
  /** Why the provider did not decide this route (a fallback), or which answers it did not give (a `jev` route held to Sonnet/high); absent when it decided it. */ reason?: string };
/** One answer per question; `null` is an answer that was not given: malformed, or under the confidence floor. Any `null` composes Sonnet/high. */
export type Answers = { mechanical: boolean | null; subsystems: boolean | null; debugging: boolean | null; covered: boolean | null; score: number | null };

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
/** The five atomic questions. Every fallback is the answer that does NOT lower the route; {@link fallbackRoute} decides what a fallback row gets. */
export const QUESTIONS: Readonly<Record<keyof Answers, Question>> = Object.freeze({
  mechanical: { type: "choice", criteria: YES_NO, fallback: "no",
    instructions: "Is this row MECHANICAL: a rename, a move, a sweep or a one-line fix where every edit is stated by the row itself and nothing is left to design?" },
  subsystems: { type: "choice", criteria: YES_NO, fallback: "yes",
    instructions: "Does this row need reasoning ACROSS SUBSYSTEMS: its Region spans modules that interact, so a change in one must be understood against another?" },
  debugging: { type: "choice", criteria: YES_NO, fallback: "yes",
    instructions: "Does this row require DEBUGGING AN UNKNOWN FAILURE: the cause is not stated in the row and has to be found before anything is fixed?" },
  covered: { type: "choice", criteria: YES_NO, fallback: "no",
    instructions: "Does the Acceptance command FULLY COVER the Done-when: if the command passes, is every Done-when item shown to be true?" },
  // The provider scores a level by its POSITION in `levels` (from zero); `decide` hands the callers the 1-based level, so `fallback: 5` is the last description.
  score: { type: "score", fallback: 5,
    levels: ["one stated edit in one file", "a few stated edits, each independent", "a new small unit with a test, in one subsystem",
      "a change that touches how two modules agree", "a new seam, a migration or anything whose shape the row does not state"],
    instructions: "Complexity of the row, as the level whose description fits it. Signals: file count, whether the Acceptance is a command, whether the Done-when is checkable." },
});

const asBool = (value: unknown): boolean | null => (value === "yes" ? true : value === "no" ? false : null);

/**
 * THE ROUTE AN ANSWER SET COMPOSES, PURE. Haiku/high: mechanical, the Acceptance covers the Done-when, a score of at most {@link HAIKU_MAX_SCORE}, no subsystems and no debugging.
 * Sonnet/medium: a score of exactly {@link MEDIUM_SCORE}, covered, and neither subsystems nor debugging. ANYTHING ELSE, and any answer that is `null`, is Sonnet/high as before.
 */
export function composeRoute(answers: Answers): Route {
  const { mechanical, subsystems, debugging, covered, score } = answers;
  if (mechanical === null || subsystems === null || debugging === null || covered === null || score === null) return "sonnet/high";
  if (subsystems || debugging || !covered) return "sonnet/high";
  if (mechanical && score <= HAIKU_MAX_SCORE) return "haiku/high";
  if (score === MEDIUM_SCORE) return "sonnet/medium";
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
/** A route the provider did not decide, with the reason it did not: the journal line and the decision log's outcome line both say it, so a fallback is never silent. */
const withReason = (routed: Routed, reason: string): Routed => ({ ...routed, reason, why: `${routed.why}; the provider did not decide: ${reason}` });

function profiled(route: Route, via: Via, row: RouteRow, haikuSwitch: string | undefined): Routed {
  if (route === "sonnet/high") return ordinary(via, "the ordinary profile");
  if (route === "sonnet/medium") return decided(route, via, "a small row", SONNET_MEDIUM);
  const haiku = haikuProfileOf(row, haikuSwitch);
  return "profile" in haiku ? decided(route, via, "a mechanical row the Acceptance covers", haiku.profile) : ordinary(via, `Haiku was composed but refused: ${haiku.refused}`);
}

/**
 * THE ROUTE OF ONE ROW. Overrides decide before the provider is asked: a `tier:haiku` label (the Haiku profile, or the ordinary one when the existing refusals say so) and a row nothing
 * may lower. Otherwise the five questions go through `decide`; an answer under the floor or any failure takes {@link fallbackRoute}. Every route is a decision-log line.
 */
export async function routeEngineer(row: RouteRow, deps: RouteDeps): Promise<Routed> {
  const routed = await routeOnly(row, deps);
  recordOutcome("model-routing", `${ID_PREFIX}${row.number}`, `route ${routed.route} via ${routed.via}`, deps, routed.reason);
  return routed;
}

async function routeOnly(row: RouteRow, deps: RouteDeps): Promise<Routed> {
  if (row.labels.includes(HAIKU_TIER_LABEL)) {
    const haiku = haikuProfileOf(row, deps.haikuSwitchPath);
    return "profile" in haiku ? decided("haiku/high", "override", HAIKU_TIER_LABEL, haiku.profile) : { ...ordinary("override", haiku.refused), reason: haiku.refused };
  }
  const held = whyHeld(row);
  if (held !== null) return { ...ordinary("refused", held), reason: held };
  const decision = await decide("model-routing", routeState(row), QUESTIONS, { ...deps, id: `${ID_PREFIX}${row.number}` });
  if (decision.via === "none") return withReason(profiled(fallbackRoute(row), "fallback", row, deps.haikuSwitchPath), decision.reason ?? "the provider gave no answer and no reason");
  const given = (name: keyof Answers) => (decision.answers[name].fellBack ? null : decision.answers[name].value);
  const answers: Answers = { mechanical: asBool(given("mechanical")), subsystems: asBool(given("subsystems")), debugging: asBool(given("debugging")),
    covered: asBool(given("covered")), score: typeof given("score") === "number" ? (given("score") as number) : null };
  const routed = profiled(composeRoute(answers), "jev", row, deps.haikuSwitchPath);
  // A null answer is not a no: it composes Sonnet/high, and the line says which answers were not given and why (the provider's own line has the same, per question).
  const notGiven = Object.entries(decision.answers).filter(([, a]) => a.fellBack).map(([name, a]) => `${name}: ${a.reason ?? "no reason"}`);
  return notGiven.length === 0 ? routed : { ...routed, reason: `answers not given (${notGiven.join("; ")})` };
}

/** What came of a route, appended to the same log: `merged-first-pass` or `not-first-pass`, so the floor is tuned from results. */
export function recordRouteOutcome(row: number, outcome: string, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  recordOutcome("model-routing", `${ID_PREFIX}${row}`, outcome, deps);
}
