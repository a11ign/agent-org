// @ts-check
// module: how many calls the board made to Linear and to GitHub in the last hour, and how many failed (A11-363) -- the figure `/api/health` calls failures per 100 calls
//
// THE CALLS ARE COUNTED WHERE THEY LEAVE THE PROCESS, not where they are written: `realExec` and `realExecAsync` count each `gh` program, the `fetch` core hands every plugin counts each request to `api.github.com`
// (which the GitHub plugin never calls today), and the loader hands the TRACKER plugin a `fetch` and `freshFetch` that count every request it makes as the `linear` figure (`trackerDeps` in `src/plugins/loader.ts`).
// Core names no tracker's address (`src/plugins/boundary.test.ts`): the figure is the tracker's, whichever plugin that is. Nothing at a call site changes, and a call that no seam sees is not counted.
//
// A FAILURE IS A CALL THAT DID NOT REACH THE SERVICE, OR THE SERVICE FAILED IT: a `fetch` that threw (a reset socket, a timeout), a 429 or a 5xx; a `gh` that could not start, was cut at its limit, or exited non-zero
// with stderr that names the network or the service failing (`HTTP 502`, `connection reset`, `timeout`). A `gh` exits non-zero for plenty the service answered (`gh pr checks` while checks are pending, a 404), and
// those are not a sick board. Each thread counts its own calls; the board thread's are the figure.
import { basename } from "node:path";
import { rollingCount, type RollingCount } from "./rolling-count.ts";

export type CallService = "linear" | "github";
export const CALL_SERVICES: readonly CallService[] = ["linear", "github"];
/** How far back the figure looks, in ms. */
export const CALL_WINDOW_MS = 3_600_000;

/** One service's calls over the window: how many, how many failed, and the failures per 100 calls to one decimal place (0 when there were no calls). */
export type CallFigure = Readonly<{ calls: number; failures: number; failuresPer100: number }>;
export type CallFigures = Readonly<Record<CallService, CallFigure>>;

/** When the last call to a service succeeded and when the last failed, in the ledger's clock: undefined for a kind that has not happened in the window (A11-399). */
export type LastCalls = Readonly<{ ok?: number; failed?: number }>;

export type CallLedger = Readonly<{
  /** Counts one call to `service`, and whether it failed. */
  record: (service: CallService, failed: boolean) => void;
  figures: () => CallFigures;
  /** When the last good and the last failed call to `service` were made, within the window. */
  lastCalls: (service: CallService) => LastCalls;
}>;

/** The failures per 100 calls, to one decimal place. PURE. */
export const per100 = (failures: number, calls: number): number => (calls === 0 ? 0 : Math.round((failures / calls) * 1000) / 10);

/** A ledger of calls over the last CALL_WINDOW_MS as `now` says. */
export function createCallLedger(now: () => number = Date.now): CallLedger {
  const counts = Object.fromEntries(CALL_SERVICES.map((service) => [service, { calls: rollingCount(CALL_WINDOW_MS, now), failures: rollingCount(CALL_WINDOW_MS, now) }])) as Record<CallService, { calls: RollingCount; failures: RollingCount }>;
  const last = Object.fromEntries(CALL_SERVICES.map((service) => [service, {} as { ok?: number; failed?: number }])) as Record<CallService, { ok?: number; failed?: number }>;
  const inWindow = (at: number | undefined): number | undefined => (at !== undefined && at > now() - CALL_WINDOW_MS ? at : undefined);
  return {
    record: (service, failed) => {
      counts[service].calls.add();
      if (failed) counts[service].failures.add();
      last[service][failed ? "failed" : "ok"] = now();
    },
    lastCalls: (service) => ({ ok: inWindow(last[service].ok), failed: inWindow(last[service].failed) }),
    figures: () => Object.fromEntries(CALL_SERVICES.map((service) => {
      const calls = counts[service].calls.total();
      const failures = counts[service].failures.total();
      return [service, { calls, failures, failuresPer100: per100(failures, calls) }];
    })) as CallFigures,
  };
}

/** This thread's ledger, which the seams count into and `/api/health` reads. */
export const callOutcomes: CallLedger = createCallLedger();

/** The service a request's address names: GitHub's API, or null. The tracker's calls are counted by the fetch the loader gives it, not by address. PURE. */
export function serviceOfUrl(input: string | URL | Request): CallService | null {
  let host: string;
  try {
    host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
  } catch {
    return null;
  }
  return host === "api.github.com" ? "github" : null;
}

/** Whether an HTTP status is the service failing the call: too many requests, or its own error. PURE. */
export const statusFailed = (status: number): boolean => status === 429 || status >= 500;

/**
 * `fetchImpl` counting requests into `ledger`: every request as `as` when it is given, else each request to GitHub's API. A throw and a failing status are failures, and the answer, or the throw, is passed on
 * unchanged.
 */
export function countedFetch<F extends typeof fetch>(fetchImpl: F, ledger: CallLedger = callOutcomes, as?: CallService): F {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const service = as ?? serviceOfUrl(input);
    if (service === null) return fetchImpl(input, init);
    try {
      const response = await fetchImpl(input, init);
      ledger.record(service, statusFailed(response.status));
      return response;
    } catch (err) {
      ledger.record(service, true);
      throw err;
    }
  }) as F;
}

/** What `gh` answered, as far as telling a failed call from a refused one needs it. */
export type ProgramAnswer = Readonly<{ status: number | null; stderr: string }>;

/** What `gh` prints when the network or GitHub failed the call, not when GitHub answered it. */
const SERVICE_FAILURE = /\bHTTP (?:429|5\d\d)\b|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection (?:reset|refused)|unexpected EOF|TLS|no such host|dial tcp|rate limit|temporarily unavailable/i;

/** Whether a `gh` call failed: it could not start or was cut (no status), or it exited non-zero saying the network or GitHub failed it. PURE. */
export function ghFailed({ status, stderr }: ProgramAnswer): boolean {
  if (status === 0) return false;
  return status === null || SERVICE_FAILURE.test(stderr);
}

/** Counts a finished program into `ledger` when it is `gh`; any other program is not a call to GitHub. */
export function countProgram(file: string, answer: ProgramAnswer, ledger: CallLedger = callOutcomes): void {
  if (basename(file) === "gh") ledger.record("github", ghFailed(answer));
}

/** Two threads' figures added together, the failures per 100 worked out again from the sums. PURE. */
export function addCallFigures(a: CallFigures, b: CallFigures): CallFigures {
  return Object.fromEntries(CALL_SERVICES.map((service) => {
    const calls = a[service].calls + b[service].calls;
    const failures = a[service].failures + b[service].failures;
    return [service, { calls, failures, failuresPer100: per100(failures, calls) }];
  })) as CallFigures;
}

/** Whether `service`'s latest call within the window was a failure: a failure with no good call at or after it. */
const lastFailed = ({ ok, failed }: LastCalls): boolean => failed !== undefined && (ok === undefined || failed >= ok);

/**
 * Whether the board's own network calls work again after `crashedAt` (A11-399): some call to a service succeeded after it, and neither service's latest call failed. A service the board has not called in the window is
 * not failing. PURE.
 */
export function networkUpSince(ledger: CallLedger, crashedAt: number): boolean {
  const calls = CALL_SERVICES.map((service) => ledger.lastCalls(service));
  return calls.some(({ ok }) => ok !== undefined && ok > crashedAt) && !calls.some(lastFailed);
}
