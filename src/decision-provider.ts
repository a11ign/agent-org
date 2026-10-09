// #4628: THE DECISION SEAM. Every use of the structured-decision provider (Jev, in a11ign's setup) goes through `decide`, so no use grows its own client, key read or switch.
// The one client, key read and timeout stay in `triage-provider.ts` (`askProvider`); this module adds what the uses share: a per-use switch, a fallback per question, a floor
// per answer and a log. `triageOrder` (#4384) is the first caller and keeps its signature and behaviour.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). No provider declared, no key, the use switched off, a refusal, a timeout, a malformed answer or a confidence under the floor:
// each answers the DETERMINISTIC FALLBACK the caller supplied with the question, and none of them throws or nags. Nothing here merges, approves, grants or acts: the provider only
// routes and classifies, and a caller turns an answer into an action in its own code.
//
// QUESTIONS ARE ATOMIC AND THE STATE IS TRIMMED. A caller composes small `choice` or `score` questions over a structured `state` of a few fields, never an agent-written body;
// `decide` refuses to send a state over {@link MAX_STATE_BYTES}, and the log keeps the state's field NAMES and never its values.
//
// THE SWITCHES are `.agent-org/decisions.json`: `{ "<use>": true }`, one boolean per use, absent meaning off. A malformed file turns every use off and says which file, never what
// it held. The provider and its key are the host declaration's `triage` block (#4384), not this file's business.
//
// THE LOG is append-only JSON lines beside the wake ledger. A line is written when the provider was ASKED (a use that is off, or a host with no key, asked nobody and writes
// nothing), and `recordOutcome` appends what came of a decision later, so a floor is tuned from results and not from a guess.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TRIAGE_MIN_CONFIDENCE } from "./host-config.ts";
// (`triage-provider.ts` imports `decide` back for `triageOrder`: a cycle, and safe because neither module uses the other at load, only inside a call.)
import { askProvider, printDiagnostic, processState, TRIAGE_UNAVAILABLE, type ProviderQuestion, type TriageDeps } from "./triage-provider.ts";

export const DECISION_USES = Object.freeze(["model-routing", "wake-triage", "ci-failure-class", "failure-class-match", "duplicate-row", "review-depth"] as const);
export type DecisionUse = (typeof DECISION_USES)[number];
/** More than this is not a trimmed state, and is not sent. */
export const MAX_STATE_BYTES = 4096;
const SWITCHES_FILE = join(".agent-org", "decisions.json");
const MIN_SCORE = 1;
const MAX_SCORE = 5;

/** A `choice` among `criteria` or a `score` from 1 to 5, with the deterministic `fallback` this use takes in the provider's place and an optional floor of its own. */
export type Question = (
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>>; fallback: string }
  | { type: "score"; instructions: string; fallback: number }
) & { minConfidence?: number };
export type Value = string | number;
/** `asked` is what the provider said when `fellBack` replaced it (an answer under the floor); `reason` says why it was replaced. */
export type Answer = { value: Value; confidence?: number; fellBack: boolean; reason?: string; asked?: Value };
/** `via` is `jev` when at least one answer came from the provider, else `none` with the `reason`. The answers are always there: the fallback is a value, not an absence. */
export type Decision = { use: DecisionUse; via: "jev" | "none"; fellBack: boolean; reason?: string; answers: Record<string, Answer> };
export type DecisionDeps = TriageDeps & {
  /** The switches already read (a caller whose own declaration is its switch); otherwise they are read from `switchesPath`. */
  switches?: Readonly<Partial<Record<DecisionUse, boolean>>>;
  switchesPath?: string;
  logPath?: string;
  /** The caller's name for the subject (a causeKey, a row number): what `recordOutcome` is later given. */
  id?: string;
  now?: () => number;
  read?: typeof readFileSync;
};

/** The project's switch file, relative to the project root. */
export const decisionSwitchesPath = (projectDir: string): string => join(projectDir, SWITCHES_FILE);
/** The decision log sits beside the wake ledger, the way the digest does. */
export const decisionLogPathFrom = (ledgerPath: string): string => join(dirname(ledgerPath), "decisions");

type Switches = Readonly<Partial<Record<DecisionUse, boolean>>>;
type Env = Required<Pick<TriageDeps, "diagnostic">> & { state: NonNullable<TriageDeps["state"]>; read: typeof readFileSync };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The switches in `path`. Absent file: every use off, quietly. Unreadable, not JSON, not an object or a value that is not a boolean: every use off and ONE line naming the file,
 * which is all the line says -- the file's text is configuration somebody wrote and the line is not the place to echo it.
 */
export function readSwitches(path: string, { diagnostic, state, read }: Env): Switches {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(read(path, "utf8")));
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") warnOnce(`${path} could not be read as JSON`, diagnostic, state);
    return {};
  }
  if (!isRecord(parsed) || Object.values(parsed).some((v) => typeof v !== "boolean")) {
    warnOnce(`${path} is not an object of booleans`, diagnostic, state);
    return {};
  }
  return parsed as Switches;
}

function warnOnce(what: string, diagnostic: (line: string) => void, state: NonNullable<TriageDeps["state"]>): void {
  if (state.switchesWarned) return;
  state.switchesWarned = true;
  diagnostic(`agent-org: decision-provider: ${what}, so every decision use is off and takes its deterministic rule`);
}

const wire = (question: Question): ProviderQuestion => question.type === "choice"
  ? { type: "choice", instructions: question.instructions, criteria: question.criteria }
  : { type: "score", instructions: question.instructions };

const fallbacks = (questions: Readonly<Record<string, Question>>, reason: string): Record<string, Answer> =>
  Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { value: q.fallback, fellBack: true, reason }]));

/** Every answer is the fallback and nobody was asked. */
const unasked = (use: DecisionUse, questions: Readonly<Record<string, Question>>, reason: string): Decision =>
  ({ use, via: "none", fellBack: true, reason, answers: fallbacks(questions, reason) });

/** The provider's reading of one answer, or `undefined` when it is not a value this question allows with a confidence from 0 to 1. */
function readAnswer(question: Question, raw: unknown): { value: Value; confidence: number } | undefined {
  const { choice, score, confidence } = (isRecord(raw) ? raw : {}) as { choice?: unknown; score?: unknown; confidence?: unknown };
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return undefined;
  if (question.type === "choice") return typeof choice === "string" && Object.hasOwn(question.criteria, choice) ? { value: choice, confidence } : undefined;
  return typeof score === "number" && score >= MIN_SCORE && score <= MAX_SCORE ? { value: score, confidence } : undefined;
}

function settle(question: Question, raw: unknown, floorDefault: number): Answer {
  const read = readAnswer(question, raw);
  if (read === undefined) return { value: question.fallback, fellBack: true, reason: `the API's answer was not ${question.type === "choice" ? "a choice" : "a score from 1 to 5"} with a confidence` };
  const floor = question.minConfidence ?? floorDefault;
  if (read.confidence < floor) return { value: question.fallback, confidence: read.confidence, fellBack: true, asked: read.value, reason: `${read.value} at ${read.confidence}, under the floor ${floor}` };
  return { value: read.value, confidence: read.confidence, fellBack: false };
}

function writeLine(path: string, line: object, diagnostic: (line: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    // The error names the path; a log that cannot be written must not take the decision with it, so the line says only that.
    diagnostic("agent-org: decision-provider: the decision log could not be written");
  }
}

const logged = (decision: Decision, state: Readonly<Record<string, unknown>>, deps: DecisionDeps, at: number) => ({
  use: decision.use,
  ...(deps.id === undefined ? {} : { id: deps.id }),
  fields: Object.keys(state),
  questions: Object.keys(decision.answers),
  answers: decision.answers,
  via: decision.via,
  fellBack: decision.fellBack,
  ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  at,
});

async function decideAsked(use: DecisionUse, state: Readonly<Record<string, unknown>>, questions: Readonly<Record<string, Question>>, deps: DecisionDeps): Promise<Decision> {
  const { host, diagnostic = printDiagnostic, state: processLocal = processState, read = readFileSync, now = Date.now } = deps;
  if (!DECISION_USES.includes(use)) return unasked(use, questions, "the use is not one this tool knows");
  if (Object.keys(questions).length === 0) return unasked(use, questions, "no question was asked");
  if (host.triage?.provider !== "jev") return unasked(use, questions, "no triage provider is declared");
  const switches = deps.switches ?? (deps.switchesPath === undefined ? {} : readSwitches(deps.switchesPath, { diagnostic, state: processLocal, read }));
  if (switches[use] !== true) return unasked(use, questions, "the use is switched off");
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return unasked(use, questions, "the state is too large to send");
  const reply = await askProvider({ state, questions: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, wire(q)])) }, deps);
  const decision = "failed" in reply ? unasked(use, questions, reply.failed) : answered(use, questions, reply.answers, host.triage.minConfidence ?? DEFAULT_TRIAGE_MIN_CONFIDENCE);
  // A key that cannot be read asked nobody, so there is nothing to log; every other outcome went out as a request.
  const wasAsked = !("failed" in reply) || reply.failed !== TRIAGE_UNAVAILABLE;
  if (wasAsked && deps.logPath !== undefined) writeLine(deps.logPath, logged(decision, state, deps, now()), diagnostic);
  return decision;
}

function answered(use: DecisionUse, questions: Readonly<Record<string, Question>>, raw: Record<string, unknown>, floorDefault: number): Decision {
  const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, settle(q, raw[name], floorDefault)]));
  const all = Object.values(answers);
  const fellBack = all.some((a) => a.fellBack);
  // `via` says whether the provider answered at all: an answer held back by the floor was still its own (it carries a confidence), a malformed one was not.
  if (all.every((a) => a.confidence === undefined)) return { use, via: "none", fellBack, reason: all[0]?.reason, answers };
  return { use, via: "jev", fellBack, answers };
}

/**
 * ASK THE PROVIDER A SET OF ATOMIC QUESTIONS, OR TAKE THE DETERMINISTIC RULE. Never throws, never asks when the use is off, and always returns a value for every question:
 * the provider's when it answered at or over the floor, the question's `fallback` otherwise.
 */
export async function decide(use: DecisionUse, state: Readonly<Record<string, unknown>>, questions: Readonly<Record<string, Question>>, deps: DecisionDeps): Promise<Decision> {
  try {
    return await decideAsked(use, state, questions, deps);
  } catch {
    // The error is not carried into the line: it may name a path, and a read that failed has already cost the provider its say.
    (deps.diagnostic ?? printDiagnostic)(`agent-org: decision-provider: the ${use} decision failed, so it takes its deterministic rule`);
    return unasked(use, questions, "the decision read failed");
  }
}

/**
 * RECORD WHAT CAME OF A DECISION. `id` is the one `decide` was given in `deps.id`; the outcome is a short label the caller chooses (`merged`, `reopened`, `wrong-class`), so a
 * floor is tuned from real results. Without a `logPath` it records nothing, and it never throws.
 */
export function recordOutcome(use: DecisionUse, id: string, outcome: string, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  if (deps.logPath === undefined) return;
  writeLine(deps.logPath, { use, id, outcome, at: (deps.now ?? Date.now)() }, deps.diagnostic ?? printDiagnostic);
}
