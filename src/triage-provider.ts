// #4384: THE TRIAGE SEAM. Jev (TypeSafe's System One model) is an OPTIONAL reader of a wake order: agent-org is a project-agnostic tool (ADR 0040), and a host
// that does not want a third-party model reading its orders declares `triage: { provider: "none" }` or no `triage` at all, and gets today's behaviour exactly.
//
// THIS MODULE ROUTES NOTHING. `triageOrder` returns `{ route, via, reason }` as DATA for the wake path to use (row B); nothing here edits, sends or labels, and Jev
// only routes or digests, it never acts. The one Jev client in the tool is this one (#4187's sheet scorer imports it).
//
// FIVE ATOMIC QUESTIONS, COMPOSED IN CODE (#4631). #4385's one broad question (`wake|digest|drop` over the order's cause) came back under the 0.7 line 69% of the time, so
// the provider is asked five yes/no questions over a handful of structured fields and {@link compose} turns the answers into a route. Every question's fallback is the
// answer that WAKES, so a question the provider could not answer confidently costs a turn and never an order. The state is whitelisted by {@link STATE_FIELDS}: no order
// text can reach the provider, because no field of it is named there.
//
// A FAILED READ NEVER DROPS AN ORDER. Every way this can go wrong -- no provider, no key, a refusal, a timeout, a malformed answer, a confidence under the floor,
// an order whose cause cannot be read -- answers `wake`, because a router that is unsure must cost a turn and not an order.
//
// THE KEY is read by `readKey(path)` at call time, once per process, and lives only in the closure that builds the request header. It is never printed, logged or
// returned; a key that cannot be read is recorded as the reason `triage-unavailable` and nothing else (not the error's text, which names the path).
import { readFileSync } from "node:fs";
import { decide, type Answer, type Decision, type DecisionUse, type Question } from "./decision-provider.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const TRIAGE_UNAVAILABLE = "triage-unavailable";
const NO_PROVIDER = "no triage provider is declared";
const TIMEOUT_MS = 10_000;
/** The sampler prints this for an order whose ledger line is gone (`triage-sample.ts`); it is no cause, like an absent one. */
const NO_CAUSE = "(no cause)";
/** How recent a delivery of the same cause to the same seat makes a new offer of it a repeat; `triage-route.ts`'s flush uses the same hour. */
export const REPEAT_WINDOW_MINUTES = 60;
/** The cause `trunk-red.ts` gives the one order a red main produces: the order that IS the red main, as opposed to any order sent while main is red. */
export const RED_MAIN_CAUSE = "trunk-red";
const ALWAYS_WAKES = "this is the red main's own order or a chairman direction is attached, so it wakes whatever the provider would say";

const yesNo = (instructions: string, fallback: "yes" | "no"): Question => ({
  type: "choice", instructions, fallback,
  criteria: { yes: "the statement is true of this event.", no: "the statement is not true of this event." },
});

/**
 * The five questions, each atomic. The `fallback` of each is the answer that WAKES: a question the provider did not answer at or over the floor must never be the
 * reason an order is held, so the two that can only hold an order when answered `yes` fall back to `no`, and the three that can only force a wake fall back to `yes`.
 */
export const QUESTIONS = Object.freeze({
  "asks-this-seat": yesNo("Does this event ask something only the seat named in `session` can answer, or a row write nobody else will make?", "yes"),
  "repeat": yesNo("Is this event a repeat of one already delivered to this same seat within the last 60 minutes? `lastDeliveredMinutesAgo` is the minutes since this same `causeKey` was last delivered to `session`, and is null or absent when no such delivery is known.", "no"),
  "names-red-main": yesNo("Does this event name a red main, a failing build of the trunk? `mainRed` says whether the trunk is red at this moment, and absent means not known.", "yes"),
  "names-chairman-direction": yesNo("Does this event carry a direction from the chairman? `chairmanDirection` says whether one is attached.", "yes"),
  "informational-only": yesNo("Is this event informational only: true, but asking nobody to do or decide anything?", "no"),
} satisfies Record<string, Question>);
export type QuestionName = keyof typeof QUESTIONS;
const QUESTION_NAMES = Object.keys(QUESTIONS) as QuestionName[];

/** `drop` is still a label the route understands (it is held, the same as `digest`), but {@link triageOrder} composes only `wake` and `digest`. */
export type Label = "wake" | "digest" | "drop";
/**
 * What the provider sees of one order: structured facts and never its text. `lastDeliveredMinutesAgo` is `null` when no delivery of the same `causeKey` to the same seat is known,
 * and a field a caller does not know is left ABSENT, because "not known" and "no" are different states and must not share a value.
 */
export type TriageOrder = {
  cause?: string; causeKey?: string; session?: string;
  lastDeliveredMinutesAgo?: number | null; mainRed?: boolean; chairmanDirection?: boolean;
};
/** What the provider said to one question, before any floor: its `value` and `confidence`. Each is absent when the provider gave none (a refusal, a malformed answer). */
export type Said = { value?: string; confidence?: number };
/**
 * `answers` are the five yes/no values composed into `route`, so a held order's log line says WHY it was held; `said` is what the provider actually answered to each, which differs from
 * `answers` wherever a floor replaced it with a fallback, so a floor can be tuned from a replay.
 */
export type Triage = { route: Label; via: "jev" | "none"; confidence?: number; reason: string; answers?: Record<string, string>; said?: Record<string, Said>; probabilities?: Readings };
/** The only fields of an order that are ever sent: a whitelist, so a field added to {@link TriageOrder} later is not sent by accident. */
const STATE_FIELDS = ["cause", "causeKey", "session", "lastDeliveredMinutesAgo", "mainRed", "chairmanDirection"] as const;
/** What is true of THIS process; a test passes a fresh one. */
export type TriageState = { key?: string; keyFailed: boolean; switchesWarned?: boolean };
/** `switches` is the caller's own say over the use; absent, the host's `triage` declaration is the switch (see {@link triageOrder}). */
export type TriageDeps = {
  host: { triage?: Readonly<{ provider: string; keyPath?: string; minConfidence?: number }> };
  fetch?: typeof fetch;
  readKey?: (path: string) => string;
  diagnostic?: (line: string) => void;
  state?: TriageState;
  timeoutMs?: number;
  switches?: Readonly<Partial<Record<DecisionUse, boolean>>>;
};
/**
 * What the API accepts as one description in a question's `criteria` (its OpenAPI schema: `string`, `object` or `array`, #4752): text, or JSON structure the model is trained to read,
 * such as a Choice option's `what`, `not_for` and `examples` or a Score level's `summary` and `signals`. Passed through as given, never interpreted here.
 */
export type Described = string | Readonly<Record<string, unknown>> | readonly unknown[];
/**
 * One question in the provider's own vocabulary (#4628): `choice` among `criteria` (an object of descriptions by choice), or a `score` over `criteria` (an ORDERED ARRAY of level
 * descriptions: the API scores a level by its position, from zero, and rejects a `score` question without it with HTTP 422, agent-org#564).
 */
export type ProviderQuestion = { type: "choice"; instructions: string; criteria: Readonly<Record<string, Described>> } | { type: "score"; instructions: string; criteria: readonly Described[] };
/** What goes to the provider: a trimmed structured `state` and the atomic questions asked of it. */
export type ProviderRequest = { state: Readonly<Record<string, unknown>>; questions: Readonly<Record<string, ProviderQuestion>> };
/** The provider's raw `answers` by question name, or why none came back. Never thrown. */
export type ProviderReply = { answers: Record<string, unknown> } | { failed: string };

export const freshState = (): TriageState => ({ keyFailed: false });
/** What is true of THIS process when a caller passes no state: the key is read once per process, whoever asks. */
export const processState = freshState();
export const printDiagnostic = (line: string): void => console.error(line);

const readKeyFile = (path: string): string => readFileSync(path, "utf8").trim();

const wake = (via: Triage["via"], reason: string): Triage => ({ route: "wake", via, reason });

/**
 * The key, or `undefined` once it cannot be had. The attempt is made ONCE per process, a failure included (`keyFailed` is what makes the diagnostic one line and not one per order), and that line says only that triage is unavailable.
 */
function keyFor(keyPath: string, { readKey, diagnostic, state }: Required<Pick<TriageDeps, "readKey" | "diagnostic" | "state">>): string | undefined {
  if (state.key !== undefined) return state.key;
  if (state.keyFailed) return undefined;
  try {
    const key = readKey(keyPath);
    if (key === "") throw new Error("empty");
    state.key = key;
    return key;
  } catch {
    // The error is NOT carried into the line: a read error names the path, and the line is the only thing this module says about the key.
    state.keyFailed = true;
    diagnostic(`agent-org: ${TRIAGE_UNAVAILABLE}: the triage key could not be read, so every order wakes as it did before triage`);
    return undefined;
  }
}

const hasCause = (order: TriageOrder): boolean => typeof order.cause === "string" && order.cause !== "" && order.cause !== NO_CAUSE;

function requestBody({ state, questions }: ProviderRequest) {
  return { state, model: JEV_MODEL, questions };
}

/**
 * One `POST`, or a reason it failed. Never throws: a timeout, a refusal and a body that is not JSON all come back as `{ failed }`.
 */
async function ask(request: ProviderRequest, key: string, fetchFn: typeof fetch, timeoutMs: number): Promise<ProviderReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ProviderReply>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ failed: "the API timed out" }); }, timeoutMs); });
  const call = (async (): Promise<ProviderReply> => {
    const response = await fetchFn(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(request)),
      signal: controller.signal,
    });
    if (!response.ok) return { failed: `the API answered HTTP ${response.status}` };
    const body = (await response.json()) as { answers?: Record<string, unknown> } | null;
    return { answers: body?.answers ?? {} };
  })().catch((): ProviderReply => ({ failed: "the API call failed" }));
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE ONE JEV CLIENT (#4628): the key, the request and the timeout for every use of the provider, `triageOrder` and `decide` alike. Never throws. A host that declares no
 * `jev` provider, or whose key cannot be read, gets `{ failed }` without a request leaving the process.
 */
export async function askProvider(request: ProviderRequest, deps: TriageDeps): Promise<ProviderReply> {
  const { host, fetch: fetchFn = fetch, readKey = readKeyFile, diagnostic = printDiagnostic, state = processState, timeoutMs = TIMEOUT_MS } = deps;
  const { provider, keyPath } = host.triage ?? { provider: "none" };
  if (provider !== "jev" || keyPath === undefined) return { failed: NO_PROVIDER };
  const key = keyFor(keyPath, { readKey, diagnostic, state });
  if (key === undefined) return { failed: TRIAGE_UNAVAILABLE };
  return ask(request, key, fetchFn, timeoutMs);
}

/** The answer to every question as the string it was, or its fallback: `decide` always returns a value per question. */
const valuesOf = (decision: Decision): Record<QuestionName, string> =>
  Object.fromEntries(QUESTION_NAMES.map((name) => [name, String(decision.answers[name].value)])) as Record<QuestionName, string>;

/** The lowest confidence among the answers the provider gave (an answer under the floor included), or `undefined` when it gave none. */
function weakest(decision: Decision): number | undefined {
  const given = Object.values(decision.answers).flatMap((a) => (a.confidence === undefined ? [] : [a.confidence]));
  return given.length === 0 ? undefined : Math.min(...given);
}

/** What the provider said to every question, as the raw value and confidence it gave and not the fallback that may have replaced it. */
function saidOf(decision: Decision): Record<QuestionName, Said> {
  return Object.fromEntries(QUESTION_NAMES.map((name) => {
    const { value, asked, confidence } = decision.answers[name];
    // `asked` is the provider's value when a floor replaced it; with a confidence and no `asked`, `value` is the provider's own. With neither, nothing came back.
    const raw = asked ?? (confidence === undefined ? undefined : value);
    return [name, { ...(raw === undefined ? {} : { value: String(raw) }), ...(confidence === undefined ? {} : { confidence }) }];
  })) as Record<QuestionName, Said>;
}

// THE THRESHOLDS (#4889, the chairman's starting values, to be calibrated from the probabilities `probabilities` now carries). The composition reads P(yes), never the floored value:
// a flat floor over five answers meant an order was held only when ALL of them cleared 0.7 (p >= 0.85 for a binary choice), so about 1 in 200 digested. Each is a probability, and the
// price of being wrong is low: a digest drops nothing, it is delivered with the seat's next order or within the hour.
/** A digest needs P(informational only) of at least this... */
export const DIGEST_MIN_P_INFORMATIONAL = 0.65;
/** ...AND P(asks something only this seat can answer) BELOW this. */
export const DIGEST_MAX_P_ASKS = 0.3;
/** ...AND P(names a red main) BELOW this, and P(names a chairman direction) BELOW this: these only ever force a wake. */
export const DIGEST_MAX_P_GUARD = 0.2;
/** A repeat of a delivery the state holds inside the window digests at P(repeat) of at least this (the state's own age is the corroboration). */
export const DIGEST_MIN_P_REPEAT = 0.5;

/** P(yes) per question, or `null` for a distribution the provider did not give or that could not be read: "not given", never a probability of zero. */
export type Readings = Readonly<Record<QuestionName, number | null>>;

/** The reason an order wakes: the first condition of a digest that its readings do not meet. `null` when it meets them all. */
function whyNotDigest(p: Readings, deciding: readonly QuestionName[]): string | null {
  const limits: Record<string, number> = { "names-red-main": DIGEST_MAX_P_GUARD, "names-chairman-direction": DIGEST_MAX_P_GUARD, "asks-this-seat": DIGEST_MAX_P_ASKS };
  for (const name of deciding) {
    const value = p[name];
    if (value === null) return `${name} was not given a probability`;
    if (name === "informational-only" ? value < DIGEST_MIN_P_INFORMATIONAL : value >= limits[name]) return `${name} is at p=${value}`;
  }
  return null;
}

/**
 * THE COMPOSITION, in code and over P(yes) alone (#4889). The questions that decide are the only ones read, and a question that does not change the outcome cannot veto it.
 * DIGEST when P(informational only) >= {@link DIGEST_MIN_P_INFORMATIONAL}, P(asks this seat) < {@link DIGEST_MAX_P_ASKS}, and neither P(red main) nor P(chairman direction) reaches
 * {@link DIGEST_MAX_P_GUARD}; or when the state holds a delivery of this cause inside {@link REPEAT_WINDOW_MINUTES} and P(repeat) >= {@link DIGEST_MIN_P_REPEAT} with the same two guards
 * clear (an answer the facts contradict is not a reason to hold an order). Otherwise WAKE; a probability not given is never read as "no". There is no `drop`: held is held.
 */
export function compose(p: Readings, repeatAgeMinutes: number | null | undefined): { route: "wake" | "digest"; reason: string } {
  const guards = ["names-red-main", "names-chairman-direction"] as const;
  const guarded = whyNotDigest(p, guards);
  if (guarded !== null) return { route: "wake", reason: `${guarded}, so it is not held` };
  if (typeof repeatAgeMinutes === "number" && repeatAgeMinutes < REPEAT_WINDOW_MINUTES && (p.repeat ?? 0) >= DIGEST_MIN_P_REPEAT) {
    return { route: "digest", reason: `a repeat of one delivered ${repeatAgeMinutes} minute(s) ago` };
  }
  const why = whyNotDigest(p, ["informational-only", "asks-this-seat"]);
  if (why !== null) return { route: "wake", reason: `${why}, so nothing says it can wait` };
  return { route: "digest", reason: "informational only, and it asks nothing of this seat" };
}

/**
 * P(yes) of one answer. The provider's distribution when it gave one (a distribution that does not name `yes` is a probability of zero: it put nothing there); otherwise what its `choice` and
 * `confidence` say, since a binary choice's confidence is `(p_max - 0.5) / 0.5`; and `null`, "not given" and never zero, when it gave neither a distribution nor a readable choice.
 */
function pYes({ probabilities, confidence, value, asked }: Answer): number | null {
  if (probabilities !== undefined) return probabilities.yes ?? 0;
  const choice = asked ?? (confidence === undefined ? undefined : value);
  if (confidence === undefined || (choice !== "yes" && choice !== "no")) return null;
  const pMax = 0.5 + confidence / 2;
  return choice === "yes" ? pMax : 1 - pMax;
}

const readingsOf = (decision: Decision): Record<QuestionName, number | null> =>
  Object.fromEntries(QUESTION_NAMES.map((name) => [name, pYes(decision.answers[name])])) as Record<QuestionName, number | null>;

/**
 * Where should this order go, according to the host's declared triage provider?
 *
 * The host's own `triage` declaration is already the opt-in for `wake-triage` (#4384), so the use is on unless the caller passes `switches` saying otherwise: reading
 * `.agent-org/decisions.json` as well would quietly turn off a triage somebody set up. The red main's OWN order (its cause is {@link RED_MAIN_CAUSE}) and a chairman
 * direction wake BEFORE anything is asked. `mainRed` is the TRUNK's state and every order of a tick carries it, so it is a fact the provider is told and not a reason to
 * skip it: an order about something else, sent while main is red, is asked, and `names-red-main` is the question that wakes it (a11ign/a11ign#4887).
 */
export async function triageOrder(order: TriageOrder, deps: TriageDeps): Promise<Triage> {
  const { provider, keyPath } = deps.host.triage ?? { provider: "none" };
  if (provider !== "jev" || keyPath === undefined) return wake("none", NO_PROVIDER);
  if (!hasCause(order)) return wake("none", "the order has no cause, and an order that cannot be read is never routed");
  if (order.cause === RED_MAIN_CAUSE || order.chairmanDirection === true) return wake("none", ALWAYS_WAKES);
  const state = Object.fromEntries(STATE_FIELDS.filter((field) => order[field] !== undefined).map((field) => [field, order[field]]));
  const decision = await decide("wake-triage", state, QUESTIONS, { ...deps, switches: { "wake-triage": true, ...deps.switches } });
  if (decision.via === "none") return wake("none", decision.reason ?? NO_PROVIDER);
  const probabilities = readingsOf(decision);
  const { route, reason } = compose(probabilities, order.lastDeliveredMinutesAgo);
  return { route, via: "jev", confidence: weakest(decision), reason: `jev: ${reason}`, answers: valuesOf(decision), said: saidOf(decision), probabilities };
}
