// #4384: THE TRIAGE SEAM. Jev (TypeSafe's System One model) is an OPTIONAL reader of a wake order: agent-org is a project-agnostic tool (ADR 0040), and a host
// that does not want a third-party model reading its orders declares `triage: { provider: "none" }` or no `triage` at all, and gets today's behaviour exactly.
//
// THIS MODULE ROUTES NOTHING. `triageOrder` returns `{ route, via, reason }` as DATA for the wake path to use (row B); nothing here edits, sends or labels, and Jev
// only routes or digests, it never acts. The one Jev client in the tool is this one (#4187's sheet scorer imports it).
//
// A FAILED READ NEVER DROPS AN ORDER. Every way this can go wrong -- no provider, no key, a refusal, a timeout, a malformed answer, a confidence under the floor,
// an order whose cause cannot be read -- answers `wake`, because a router that is unsure must cost a turn and not an order.
//
// THE KEY is read by `readKey(path)` at call time, once per process, and lives only in the closure that builds the request header. It is never printed, logged or
// returned; a key that cannot be read is recorded as the reason `triage-unavailable` and nothing else (not the error's text, which names the path).
import { readFileSync } from "node:fs";
import { decide, type Question } from "./decision-provider.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const TRIAGE_UNAVAILABLE = "triage-unavailable";
const QUESTION = "q";
const NO_PROVIDER = "no triage provider is declared";
const TIMEOUT_MS = 10_000;
/** The sampler prints this for an order whose ledger line is gone (`triage-sample.ts`); it is no cause, like an absent one. */
const NO_CAUSE = "(no cause)";

/** The three labels of the #4074 fixture (`trace/triage-labels-4074.json`, `definitions`), which are Jev's `criteria`. */
export const CRITERIA = Object.freeze({
  wake: "the event asks for a judgment or a row write that nobody else will make.",
  digest: "true but not urgent, or something the same seat can read in one batch (the repeating detectors: `pr-codeowner-review-missing`, `org-health` overdue lists, `pr-review-blocked`, `row-call-count-signal`, and `pr-checks-failing` when it goes to `ceo` and `product-manager` is first reader).",
  drop: "nothing to do or already moot.",
});
const INSTRUCTIONS = "A manager session of an AI agent organisation is about to be woken by this order, which costs a model turn. Which label is it?";

export type Label = "wake" | "digest" | "drop";
/** What a labeller saw; the store holds no order text, so there is none. */
export type TriageOrder = { cause?: string; causeKey?: string; session?: string; cost?: string };
export type Triage = { route: Label; via: "jev" | "none"; confidence?: number; reason: string };
/** What is true of THIS process; a test passes a fresh one. */
export type TriageState = { key?: string; keyFailed: boolean; switchesWarned?: boolean };
export type TriageDeps = {
  host: { triage?: Readonly<{ provider: string; keyPath?: string; minConfidence?: number }> };
  fetch?: typeof fetch;
  readKey?: (path: string) => string;
  diagnostic?: (line: string) => void;
  state?: TriageState;
  timeoutMs?: number;
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

function readAnswer(answer: unknown): { label: Label; confidence: number } | undefined {
  const { choice, confidence } = (answer ?? {}) as { choice?: unknown; confidence?: unknown };
  if (typeof choice !== "string" || !Object.hasOwn(CRITERIA, choice)) return undefined;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return undefined;
  return { label: choice as Label, confidence };
}

/**
 * Where should this order go, according to the host's declared triage provider?
 */
export async function triageOrder(order: TriageOrder, deps: TriageDeps): Promise<Triage> {
  const { provider, keyPath } = deps.host.triage ?? { provider: "none" };
  if (provider !== "jev" || keyPath === undefined) return wake("none", NO_PROVIDER);
  if (!hasCause(order)) return wake("none", "the order has no cause, and an order that cannot be read is never routed");
  const { cause, causeKey, session, cost } = order;
  const question: Question = { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA, fallback: "wake" };
  // `wake-triage` is switched on by the host's own `triage` declaration (#4384), which is already the opt-in: reading `.agent-org/decisions.json` as well would quietly turn off
  // a triage somebody set up, so this caller hands `decide` the switch it has already read.
  const decision = await decide("wake-triage", { cause, causeKey, session, cost }, { [QUESTION]: question }, { ...deps, switches: { "wake-triage": true } });
  const answer = decision.answers[QUESTION];
  if (decision.via === "none") return wake("none", decision.reason ?? NO_PROVIDER);
  if (answer.fellBack) return { route: "wake", via: "jev", confidence: answer.confidence, reason: answer.reason ?? "" };
  return { route: answer.value as Label, via: "jev", confidence: answer.confidence, reason: `jev answered ${answer.value}` };
}
