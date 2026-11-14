// @ts-check
// module: the one client for calls that leave the board for an outside service, and the one rule for which of their failures are transient (A11-436, R3)
//
// BEFORE THIS, Linear, GitHub and herdr calls each had their own timeout, their own retries and their own idea of "transient": runs crashed on a `fetch failed` one path retried and another did not
// (A11-345, A11-399), and Linear's retry needed two fixes of its own. Every outside call now goes through {@link createOutsideClient}: one attempt is cut at its service's time, a failed attempt is tried again
// only when its KIND says another try can get past it ({@link failureKindOf}, the one place a failure is classed), each service has a circuit breaker that refuses calls at once while the service keeps failing,
// and the call is counted ONCE in the board's call figure however often it is tried (A11-345's rule, now the client's). Services move onto it one per step: Linear first (the tracker plugin is handed it as
// `deps.outside` by the loader, since a plugin imports core's types only), then `gh`, then herdr.
import { callOutcomes, type CallLedger, type CallService } from "./call-outcomes.ts";

/**
 * What a failure is, as far as trying again goes. `network`: the service was not reached or did not answer (a reset, a refused connection, a DNS failure, `fetch failed`, an undici socket error, a timeout).
 * `server`: the service answered that it failed (a 5xx). `rate-limit`: it asked to be called later (a 429). `unavailable`: the breaker refused the call because the service keeps failing. `refused`:
 * anything else, the service answering the request itself (a 4xx such as a 401, a GraphQL error, a programming error), which no retry can change.
 */
export type FailureKind = "network" | "server" | "rate-limit" | "unavailable" | "refused";

const NETWORK_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);
/** undici's own codes (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_SOCKET`, ...) start with this. */
const UNDICI_CODE_PREFIX = "UND_ERR_";
const TOO_MANY_REQUESTS = 429;
const SERVER_ERRORS = { from: 500, to: 599 } as const;

/** `err` and the error it names as its `cause`, one level down: Node's `fetch` throws `TypeError("fetch failed")` and puts the reason in the cause. PURE. */
export const withCause = (err: unknown): unknown[] => [err, (err as { cause?: unknown } | null | undefined)?.cause];

/** Which kind wins when an error and its cause are of different kinds: a transient one first, then a 429, then a refusal. */
const KIND_ORDER: readonly FailureKind[] = ["unavailable", "network", "server", "rate-limit", "refused"];

/** The kind of one error, not its cause. PURE. */
function kindOfOne(err: unknown): FailureKind {
  if (err instanceof ServiceUnavailable) return "unavailable";
  if (err instanceof TypeError && err.message === "fetch failed") return "network";
  const { name, code, status } = (err ?? {}) as { name?: unknown; code?: unknown; status?: unknown };
  if (typeof name === "string" && NETWORK_ERROR_NAMES.has(name)) return "network";
  if (typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || code.startsWith(UNDICI_CODE_PREFIX))) return "network";
  if (status === TOO_MANY_REQUESTS) return "rate-limit";
  if (typeof status === "number" && status >= SERVER_ERRORS.from && status <= SERVER_ERRORS.to) return "server";
  return "refused";
}

/**
 * THE ONE RULE for what a failure of an outside call is ({@link FailureKind}). It reads the error and its cause: their type, their `code`, and the numeric `status` a service's answer carries (an error a client
 * throws with the status on it, or `{ status }` for an answer that was not thrown), never the message text. Where the error and its cause differ, the kind earliest in {@link KIND_ORDER} wins, so an error
 * that is transient on either level is transient, as the plan attach's rule always read it (A11-216). PURE.
 */
export function failureKindOf(err: unknown): FailureKind {
  const kinds = new Set(withCause(err).map(kindOfOne));
  return KIND_ORDER.find((kind) => kinds.has(kind)) ?? "refused";
}

/** The kinds the client tries again within a call: a later attempt can get past each. A breaker's refusal is not tried again within the call: the breaker is what stops the next try. */
const RETRIED: ReadonlySet<FailureKind> = new Set(["network", "server", "rate-limit"]);

/**
 * Whether a failure is transient: the network, the service failing, or a service the breaker holds off for now. A run that crashed on one is started again by itself (`crash-retry.ts`), and a tracker write that
 * failed on one is tried again later (`attach-retry.ts`). A 429 is the service answering, and a caller that waits for it says so itself (`result-write-retry.ts`). PURE.
 */
export const isTransient = (err: unknown): boolean => ["network", "server", "unavailable"].includes(failureKindOf(err));

/** The services the client calls. */
export type OutsideService = CallService;

/** How a service is named where a person reads it. */
const SERVICE_NAMES: Readonly<Record<OutsideService, string>> = { linear: "Linear", github: "GitHub" };

/** How long one attempt of a call to each service may take, in ms. A fresh process reaches Linear in about 150 ms and the largest read the board makes answers in a few seconds; `gh` has always had 30 s. */
export const ATTEMPT_MS: Readonly<Record<OutsideService, number>> = { linear: 10_000, github: 30_000 };
/** The waits before the first, second and third retry of a failed call, in ms: a call is made at most four times. */
export const RETRY_WAITS_MS: readonly number[] = [200, 800, 2_000];
/** How many failed attempts in a row open a service's breaker. */
export const BREAKER_FAILURES = 10;
/** How long an open breaker refuses calls before it lets one through to see whether the service is back, in ms. */
export const BREAKER_OPEN_MS = 30_000;
const MS_PER_SECOND = 1_000;

/** The error a call fails with when its service's breaker is open: the service is unavailable, and it is not asked. Transient ({@link isTransient}). */
export class ServiceUnavailable extends Error {
  readonly service: OutsideService;
  /** When the breaker lets a call through again, in ms since the epoch. */
  readonly until: number;
  constructor(service: OutsideService, failures: number, until: number) {
    super(`${SERVICE_NAMES[service]} is unavailable: ${failures} calls in a row failed, so it is not asked again until ${new Date(until).toISOString()}`);
    this.name = "ServiceUnavailable";
    this.service = service;
    this.until = until;
  }
}

/** The error an attempt that ran past its time fails with: a `network` failure. */
const attemptTimedOut = (service: OutsideService, ms: number): Error => Object.assign(new Error(`${SERVICE_NAMES[service]} did not answer within ${ms / MS_PER_SECOND} s`), { name: "TimeoutError" });

/**
 * What one attempt came to, for a caller that keeps its own record of attempts: whether it failed, why and of what kind (null when it did not), whether it threw, and the wait before the next attempt (null when
 * there is none).
 */
export type AttemptOutcome = Readonly<{ failed: boolean; failure: unknown; kind: FailureKind | null; threw: boolean; retryInMs: number | null }>;

/** How a call reads its answer: the status of an answer that was not thrown, and what to do with an answer that is let go because the call is tried again. */
export type CallOptions<T> = Readonly<{
  /** The HTTP status of an answer, which the rule classes as a thrown error's would be. Without it every answer that is not thrown succeeded. */
  statusOf?: (value: T) => number | undefined;
  /** Lets go of an answer that is not used, because the call is tried again: a `fetch` answer's body is read so its connection closes now. */
  release?: (value: T) => Promise<unknown>;
  /** Told of every attempt as it ends. */
  onAttempt?: (outcome: AttemptOutcome) => void;
}>;

/** One call to `service`: `attempt` is run with a signal that aborts at the attempt's time, and is run again as {@link failureKindOf} says. */
export type OutsideCall = <T>(service: OutsideService, attempt: (signal: AbortSignal) => Promise<T>, options?: CallOptions<T>) => Promise<T>;

export type OutsideClient = Readonly<{ call: OutsideCall }>;

/** The seams of the client: the ledger the call figure is counted in, the clock, the wait between attempts, and the times, which a test shortens. */
export type OutsideClientDeps = Readonly<{
  ledger?: CallLedger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attemptMs?: Readonly<Record<OutsideService, number>>;
  retryWaitsMs?: readonly number[];
  breakerFailures?: number;
  breakerOpenMs?: number;
}>;

/** A service's circuit breaker: whether it refuses a call now, and what an attempt came to. */
type Breaker = Readonly<{
  /** The refusal for a call at this moment, or null when the call may be made. */
  refusal: () => ServiceUnavailable | null;
  /** Notes an attempt: a failure a retry could get past adds to the failures in a row, and anything else (an answer, or a refusal, which is the service answering) clears them. */
  note: (kind: FailureKind | null) => void;
}>;

/** A breaker that opens after `limit` failed attempts in a row and refuses calls for `openMs`; the first call after that goes through, and opens it again at once if it fails too. */
function breakerFor(service: OutsideService, limit: number, openMs: number, now: () => number): Breaker {
  let failures = 0;
  let openUntil = 0;
  return {
    refusal: () => (failures >= limit && now() < openUntil ? new ServiceUnavailable(service, failures, openUntil) : null),
    note: (kind) => {
      failures = kind !== null && RETRIED.has(kind) ? failures + 1 : 0;
      if (failures >= limit) openUntil = now() + openMs;
    },
  };
}

/** Runs `attempt` once, cut at `ms`: it fails even where `attempt` ignores the abort, so a connection that went silent never holds the caller. */
async function cut<T>(service: OutsideService, ms: number, attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(attemptTimedOut(service, ms)); }, ms);
  });
  try {
    return await Promise.race([attempt(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What an attempt came to: its answer, or what failed it (a throw, or an answer whose status the rule classes as failed), and that failure's kind. */
type Tried<T> = Readonly<{ value?: T; failure: unknown; kind: FailureKind | null; threw: boolean }>;

async function tryOnce<T>(service: OutsideService, ms: number, attempt: (signal: AbortSignal) => Promise<T>, options: CallOptions<T>): Promise<Tried<T>> {
  try {
    const value = await cut(service, ms, attempt);
    const status = options.statusOf?.(value);
    const kind = status === undefined ? null : failureKindOf({ status });
    return kind === null || kind === "refused" ? { value, failure: null, kind: null, threw: false } : { value, failure: Object.assign(new Error(`${SERVICE_NAMES[service]} answered ${status}`), { status }), kind, threw: false };
  } catch (err) {
    return { failure: err, kind: failureKindOf(err), threw: true };
  }
}

/**
 * The client. A call whose breaker is open fails at once with {@link ServiceUnavailable}, and is neither made nor counted. Otherwise each attempt is cut at the service's {@link ATTEMPT_MS}; a failure of a kind
 * in {@link RETRIED} is tried again after a wait that grows ({@link RETRY_WAITS_MS}), up to three times, and any other failure is the caller's at once. The last answer, or the last throw, is the caller's: an
 * answer whose status failed it after the last try is returned, for the caller to read as it reads any answer. The call is counted once in the ledger, as failed when its first attempt failed (A11-345: a host
 * that loses its network for half a minute fails one call four times, and that is one failed call); every later attempt is only observed, so the ledger still learns that the service answers again (A11-399).
 */
export function createOutsideClient(deps: OutsideClientDeps = {}): OutsideClient {
  const { ledger = callOutcomes, now = Date.now, sleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }), attemptMs = ATTEMPT_MS, retryWaitsMs = RETRY_WAITS_MS,
    breakerFailures = BREAKER_FAILURES, breakerOpenMs = BREAKER_OPEN_MS } = deps;
  const breakers = new Map<OutsideService, Breaker>();
  const breakerOf = (service: OutsideService): Breaker => breakers.get(service) ?? breakers.set(service, breakerFor(service, breakerFailures, breakerOpenMs, now)).get(service) as Breaker;
  async function call<T>(service: OutsideService, attempt: (signal: AbortSignal) => Promise<T>, options: CallOptions<T> = {}): Promise<T> {
    const breaker = breakerOf(service);
    for (let tries = 0; ; tries += 1) {
      const refusal = breaker.refusal();
      if (refusal !== null) throw refusal;
      const tried = await tryOnce(service, attemptMs[service], attempt, options);
      const failed = tried.failure !== null;
      breaker.note(tried.kind);
      // The first attempt is the call, counted once; each retry is only an observation (A11-345, A11-399).
      if (tries === 0) ledger.record(service, failed);
      else ledger.observe(service, failed);
      const retry = tried.kind !== null && RETRIED.has(tried.kind) && tries < retryWaitsMs.length;
      options.onAttempt?.({ failed, failure: tried.failure, kind: tried.kind, threw: tried.threw, retryInMs: retry ? retryWaitsMs[tries] : null });
      if (!retry) {
        if (tried.threw) throw tried.failure;
        return tried.value as T;
      }
      if (!tried.threw) await options.release?.(tried.value as T).catch(() => undefined);
      await sleep(retryWaitsMs[tries]);
    }
  }
  return { call };
}

/** This thread's client, which counts into this thread's ledger: one breaker per service for the whole thread. */
export const outsideClient: OutsideClient = createOutsideClient();
