// @ts-check
// module: how many calls the board made to Linear and to GitHub in the last hour, and how many failed (A11-363) -- the figure `/api/health` calls failures per 100 calls
//
// THE CALLS ARE COUNTED WHERE THEY LEAVE THE PROCESS, not where they are written: `realExec` and `realExecAsync` count each `gh` program, and the `fetch` core hands every plugin counts each request to `api.linear.app`
// (and to `api.github.com`, which the GitHub plugin never calls today). Nothing at a call site changes, and a call that no seam sees is not counted.
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

export type CallLedger = Readonly<{
  /** Counts one call to `service`, and whether it failed. */
  record: (service: CallService, failed: boolean) => void;
  figures: () => CallFigures;
}>;

/** The failures per 100 calls, to one decimal place. PURE. */
export const per100 = (failures: number, calls: number): number => (calls === 0 ? 0 : Math.round((failures / calls) * 1000) / 10);

/** A ledger of calls over the last CALL_WINDOW_MS as `now` says. */
export function createCallLedger(now: () => number = Date.now): CallLedger {
  const counts = Object.fromEntries(CALL_SERVICES.map((service) => [service, { calls: rollingCount(CALL_WINDOW_MS, now), failures: rollingCount(CALL_WINDOW_MS, now) }])) as Record<CallService, { calls: RollingCount; failures: RollingCount }>;
  return {
    record: (service, failed) => {
      counts[service].calls.add();
      if (failed) counts[service].failures.add();
    },
    figures: () => Object.fromEntries(CALL_SERVICES.map((service) => {
      const calls = counts[service].calls.total();
      const failures = counts[service].failures.total();
      return [service, { calls, failures, failuresPer100: per100(failures, calls) }];
    })) as CallFigures,
  };
}

/** This thread's ledger, which the seams count into and `/api/health` reads. */
export const callOutcomes: CallLedger = createCallLedger();

/** The service a request's address names, or null when it is neither. PURE. */
export function serviceOfUrl(input: string | URL | Request): CallService | null {
  let host: string;
  try {
    host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
  } catch {
    return null;
  }
  if (host === "api.linear.app") return "linear";
  return host === "api.github.com" ? "github" : null;
}

/** Whether an HTTP status is the service failing the call: too many requests, or its own error. PURE. */
export const statusFailed = (status: number): boolean => status === 429 || status >= 500;

/** `fetchImpl` counting each request to Linear or GitHub into `ledger`: a throw and a failing status are failures, and the answer, or the throw, is passed on unchanged. */
export function countedFetch<F extends typeof fetch>(fetchImpl: F, ledger: CallLedger = callOutcomes): F {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const service = serviceOfUrl(input);
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
