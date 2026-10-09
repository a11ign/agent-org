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
/** `answers` are the five yes/no values composed into `route`, so a held order's log line says WHY it was held. */
export type Triage = { route: Label; via: "jev" | "none"; confidence?: number; reason: string; answers?: Record<string, string> };
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
/** One question in the provider's own vocabulary (#4628): `choice` among `criteria`, or a `score` from 1 to 5. */
export type ProviderQuestion = { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> } | { type: "score"; instructions: string };
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
  return { route, via: "jev", confidence: weakest(decision), reason: `jev: ${reason}`, answers };
}
