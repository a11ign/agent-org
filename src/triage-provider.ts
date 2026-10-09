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
import { DEFAULT_TRIAGE_MIN_CONFIDENCE } from "./host-config.mjs";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const TRIAGE_UNAVAILABLE = "triage-unavailable";
const QUESTION = "q";
const TIMEOUT_MS = 10_000;
/** The sampler prints this for an order whose ledger line is gone (`triage-sample.mjs`); it is no cause, like an absent one. */
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
export type TriageState = { key?: string; keyFailed: boolean };
export type TriageDeps = {
  host: { triage?: Readonly<{ provider: string; keyPath?: string; minConfidence?: number }> };
  fetch?: typeof fetch;
  readKey?: (path: string) => string;
  diagnostic?: (line: string) => void;
  state?: TriageState;
  timeoutMs?: number;
};
type Asked = { answer: unknown } | { failed: string };

export const freshState = (): TriageState => ({ keyFailed: false });
const processState = freshState();

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

function requestBody(order: TriageOrder) {
  const { cause, causeKey, session, cost } = order;
  return {
    state: { cause, causeKey, session, cost },
    model: JEV_MODEL,
    questions: { [QUESTION]: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA } },
  };
}

/**
 * One `POST`, or a reason it failed. Never throws: a timeout, a refusal and a body that is not JSON all come back as `{ failed }`.
 */
async function ask(order: TriageOrder, key: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Asked> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Asked>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ failed: "the API timed out" }); }, timeoutMs); });
  const call = (async (): Promise<Asked> => {
    const response = await fetchFn(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(order)),
      signal: controller.signal,
    });
    if (!response.ok) return { failed: `the API answered HTTP ${response.status}` };
    const body = (await response.json()) as { answers?: Record<string, unknown> } | null;
    return { answer: body?.answers?.[QUESTION] };
  })().catch((): Asked => ({ failed: "the API call failed" }));
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
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
  const { host, fetch: fetchFn = fetch, readKey = readKeyFile, diagnostic = (line: string) => console.error(line), state = processState, timeoutMs = TIMEOUT_MS } = deps;
  const { provider, keyPath, minConfidence = DEFAULT_TRIAGE_MIN_CONFIDENCE } = host.triage ?? { provider: "none" };
  if (provider !== "jev" || keyPath === undefined) return wake("none", "no triage provider is declared");
  if (!hasCause(order)) return wake("none", "the order has no cause, and an order that cannot be read is never routed");
  const key = keyFor(keyPath, { readKey, diagnostic, state });
  if (key === undefined) return wake("none", TRIAGE_UNAVAILABLE);
  const result = await ask(order, key, fetchFn, timeoutMs);
  if ("failed" in result) return wake("none", result.failed);
  const read = readAnswer(result.answer);
  if (read === undefined) return wake("none", "the API's answer was not a choice with a confidence");
  if (read.confidence < minConfidence) return { route: "wake", via: "jev", confidence: read.confidence, reason: `${read.label} at ${read.confidence}, under the floor ${minConfidence}` };
  return { route: read.label, via: "jev", confidence: read.confidence, reason: `jev answered ${read.label}` };
}
