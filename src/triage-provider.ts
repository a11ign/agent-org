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
import { decide, type Decision, type DecisionUse, type Question } from "./decision-provider.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const TRIAGE_UNAVAILABLE = "triage-unavailable";
const NO_PROVIDER = "no triage provider is declared";
const TIMEOUT_MS = 10_000;
/** The sampler prints this for an order whose ledger line is gone (`triage-sample.ts`); it is no cause, like an absent one. */
const NO_CAUSE = "(no cause)";
/** How recent a delivery of the same cause to the same seat makes a new offer of it a repeat; `triage-route.ts`'s flush uses the same hour. */
export const REPEAT_WINDOW_MINUTES = 60;
const ALWAYS_WAKES = "main is red or a chairman direction is attached, so it wakes whatever the provider would say";

/** TypeSafe's Choice option shape (`what`, `not_for`, `examples`; docs.typesafe.ai/primitives/advanced, "Structured Choice options"), as `wire()` sends it. `examples` is left off when there is none. */
type Option = { what: string; notFor: string; examples?: readonly string[] };
const optionOf = ({ what, notFor, examples = [] }: Option) => ({ what, not_for: notFor, ...(examples.length === 0 ? {} : { examples: [...examples] }) });

const PLAIN = { yes: "the statement is true of this event.", no: "the statement is not true of this event." };
const yesNo = (instructions: string, fallback: "yes" | "no", options?: Record<"yes" | "no", Option>): Question => ({
  type: "choice", instructions, fallback,
  criteria: options === undefined ? PLAIN : { yes: optionOf(options.yes), no: optionOf(options.no) },
});

// THE TWO QUESTIONS THE PROVIDER WAS UNSURE OF (#4878). Measured 2026-10-10 over 30 recent orders asked with the plain criteria above: `repeat`, `names-red-main` and
// `names-chairman-direction` answered at 1.0 and never fell back, while `asks-this-seat` fell under the 0.7 floor on 16 of 30 (mean 0.49) and `informational-only` on 21 of 30 (mean 0.41).
// THE FLOOR IS NOT WHAT MOVED. These two questions are given the one set of orders whose answer is KNOWN: the frozen sheet of #4074 (`trace/triage-labels-4074.json`, 94 orders the
// product-manager labelled `wake`, `digest` or `drop` on 2026-10-08), as what/not_for/examples in the shape TypeSafe reads (agent-org#564, #4752). `triage-provider.test.ts` re-counts every
// example against the sheet, so a number here that the sheet does not hold fails there. The label is a JUDGMENT of a seat's reader and not an outcome of action: the four `needed-action`
// lines of the digest log say only that a cause STOOD (their own `proxy` line), and `host-units-stale` is both labelled digest and offered again, so they are not used as examples.
/** `n` rows of the sheet carry `label` for this cause at this seat, of `of` rows the sheet holds for the pair (the rest are `drop`). */
type Labelled = { cause: string; seat: string; label: "wake" | "digest"; n: number; of: number };
const exampleOf = ({ cause, seat, label, n, of }: Labelled): string => `${cause} to ${seat}: labelled ${label} ${n} of ${of} (product-manager, a11ign#4074)`;
const pair = (label: Labelled["label"], rows: readonly (readonly [string, string, number, number])[]): readonly Labelled[] =>
  Object.freeze(rows.map(([cause, seat, n, of]) => ({ cause, seat, label, n, of })));
// EVERY (cause, seat) the sheet labels one way and only one way, `wake` or `digest`, at least twice: `triage-provider.test.ts` re-derives both lists from the sheet and fails on a
// pair added, dropped or miscounted. A pair the sheet splits (`org-health` to ceo is 6 digest to 3 wake) is not an example of either, and one seen once is not a pattern.
// `pr-checks-failing` is `wake` at product-manager and `digest` at ceo, where product-manager is the first reader: the seat is part of the answer.
/** Orders the sheet labels `wake`: a judgment or a row write nobody else makes. */
export const LABELLED_WAKE = pair("wake", [
  ["answer-owed", "orchestrator", 2, 2], ["answer-owed", "product-manager", 12, 14], ["blocker-cleared", "orchestrator", 2, 2], ["fleet-batch-due", "orchestrator", 2, 2],
  ["pr-checks-failing", "product-manager", 2, 2], ["pr-green-unarmed", "product-manager", 2, 2], ["pr-merge-conflict", "product-manager", 2, 2],
  ["ready-queue-empty", "product-manager", 2, 3], ["ready-row-incomplete", "product-manager", 2, 2], ["row-branch-unshipped", "product-manager", 2, 2],
  ["row-off-board", "product-manager", 2, 2], ["unclaimed-blocker-cleared", "product-manager", 4, 4],
]);
/** Orders the sheet labels `digest`: true but not urgent, or one of the repeating detectors read in one batch. */
export const LABELLED_DIGEST = pair("digest", [
  ["pr-checks-failing", "ceo", 4, 4], ["pr-codeowner-review-missing", "ceo", 5, 5], ["pr-review-blocked", "product-manager", 4, 4], ["ready-row-unclaimed", "orchestrator", 2, 2],
  ["repeating-log-line", "orchestrator", 2, 2], ["row-call-count-signal", "product-manager", 4, 4], ["verdict-not-convinced", "ceo", 2, 2],
]);
const ASKS_THIS_SEAT: Record<"yes" | "no", Option> = {
  yes: { what: "the event asks for a judgment or a row write that nobody else will make: this seat is the first reader and the one who must rule, label, promote or answer",
    notFor: "a detector's list this seat reads in one batch, or an event another seat reads first and this seat is told of afterwards",
    examples: LABELLED_WAKE.map(exampleOf) },
  no: { what: "another seat is the first reader of this event, or it is one of the repeating detectors whose list is read in one batch, and nothing in it is this seat's to answer today",
    notFor: "a reading that names a row to promote, tier, rule on or answer, which is this seat's whatever the cause is called, and an event that says something finished when this seat is to read it and answer",
    examples: LABELLED_DIGEST.map(exampleOf) },
};
const INFORMATIONAL_ONLY: Record<"yes" | "no", Option> = {
  yes: { what: "true but not urgent: a repeating detector's list, or a reading the same seat can take in one batch with its next order",
    notFor: "an event that names a judgment or a row write only this seat can make, or that says something finished which this seat is to read and answer",
    examples: LABELLED_DIGEST.map(exampleOf) },
  no: { what: "the event asks for a judgment or a row write now",
    notFor: "a repeating detector's list",
    examples: LABELLED_WAKE.map(exampleOf) },
};

/**
 * The five questions, each atomic. The `fallback` of each is the answer that WAKES: a question the provider did not answer at or over the floor must never be the
 * reason an order is held, so the two that can only hold an order when answered `yes` fall back to `no`, and the three that can only force a wake fall back to `yes`.
 */
export const QUESTIONS = Object.freeze({
  "asks-this-seat": yesNo("Does this event ask something only the seat named in `session` can answer, or a row write nobody else will make?", "yes", ASKS_THIS_SEAT),
  "repeat": yesNo("Is this event a repeat of one already delivered to this same seat within the last 60 minutes? `lastDeliveredMinutesAgo` is the minutes since this same `causeKey` was last delivered to `session`, and is null or absent when no such delivery is known.", "no"),
  "names-red-main": yesNo("Does this event name a red main, a failing build of the trunk? `mainRed` is true when the trunk is red and this event is the one that reports it, and absent means not known.", "yes"),
  "names-chairman-direction": yesNo("Does this event carry a direction from the chairman? `chairmanDirection` says whether one is attached.", "yes"),
  "informational-only": yesNo("Is this event informational only: true, but asking nobody to do or decide anything?", "no", INFORMATIONAL_ONLY),
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
/** What the provider said of one question, under the floor or not: its choice and its confidence. Absent for a question it did not answer (a malformed answer has no confidence). */
export type Reading = { said: string; confidence: number };
/**
 * `answers` are the five yes/no values composed into `route`, so a held order's log line says WHY it was held. `readings` are what the provider SAID of each question it answered,
 * so a floor can be read question by question: `answers` is the value used (a fallback when the reading is under the floor), `confidence` only the weakest of them (#4878).
 */
export type Triage = { route: Label; via: "jev" | "none"; confidence?: number; reason: string; answers?: Record<string, string>; readings?: Record<string, Reading> };
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

/** Each question the provider answered, as it answered it: an answer held back by the floor shows its own choice here and its fallback in `answers`. */
function readingsOf(decision: Decision): Record<string, Reading> {
  const given = Object.entries(decision.answers).flatMap(([name, a]) => (a.confidence === undefined ? [] : [[name, { said: String(a.asked ?? a.value), confidence: a.confidence }] as const]));
  return Object.fromEntries(given);
}

/** The lowest confidence among the answers the provider gave (an answer under the floor included), or `undefined` when it gave none. */
function weakest(decision: Decision): number | undefined {
  const given = Object.values(decision.answers).flatMap((a) => (a.confidence === undefined ? [] : [a.confidence]));
  return given.length === 0 ? undefined : Math.min(...given);
}

/**
 * THE COMPOSITION, in code and over the answers alone. A red main or a chairman direction always wakes; a repeat of a delivery inside {@link REPEAT_WINDOW_MINUTES}, or an event that is
 * informational only and asks nothing of this seat, is held for the digest; anything else wakes. `repeat` counts only when the state itself holds a delivery inside the window: an
 * answer the facts contradict is not a reason to hold an order. There is no `drop`: held is held.
 */
export function compose(answers: Readonly<Record<QuestionName, string>>, repeatAgeMinutes: number | null | undefined): { route: "wake" | "digest"; reason: string } {
  const yes = (name: QuestionName): boolean => answers[name] === "yes";
  if (yes("names-red-main")) return { route: "wake", reason: "it names a red main" };
  if (yes("names-chairman-direction")) return { route: "wake", reason: "it carries a chairman direction" };
  if (yes("repeat") && typeof repeatAgeMinutes === "number" && repeatAgeMinutes < REPEAT_WINDOW_MINUTES) {
    return { route: "digest", reason: `a repeat of one delivered ${repeatAgeMinutes} minute(s) ago` };
  }
  if (yes("informational-only") && !yes("asks-this-seat")) return { route: "digest", reason: "informational only, and it asks nothing of this seat" };
  return { route: "wake", reason: "nothing says it can wait" };
}

/**
 * Where should this order go, according to the host's declared triage provider?
 *
 * The host's own `triage` declaration is already the opt-in for `wake-triage` (#4384), so the use is on unless the caller passes `switches` saying otherwise: reading
 * `.agent-org/decisions.json` as well would quietly turn off a triage somebody set up. A red main or a chairman direction in the state wakes BEFORE anything is asked.
 */
export async function triageOrder(order: TriageOrder, deps: TriageDeps): Promise<Triage> {
  const { provider, keyPath } = deps.host.triage ?? { provider: "none" };
  if (provider !== "jev" || keyPath === undefined) return wake("none", NO_PROVIDER);
  if (!hasCause(order)) return wake("none", "the order has no cause, and an order that cannot be read is never routed");
  if (order.mainRed === true || order.chairmanDirection === true) return wake("none", ALWAYS_WAKES);
  const state = Object.fromEntries(STATE_FIELDS.filter((field) => order[field] !== undefined).map((field) => [field, order[field]]));
  const decision = await decide("wake-triage", state, QUESTIONS, { ...deps, switches: { "wake-triage": true, ...deps.switches } });
  if (decision.via === "none") return wake("none", decision.reason ?? NO_PROVIDER);
  const answers = valuesOf(decision);
  const { route, reason } = compose(answers, order.lastDeliveredMinutesAgo);
  return { route, via: "jev", confidence: weakest(decision), reason: `jev: ${reason}`, answers, readings: readingsOf(decision) };
}
