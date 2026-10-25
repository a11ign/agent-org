// @ts-check
// module: the board's and the terminal's serves are checked and put back by the instance, at its start and as it runs (A11-279)
//
// THE SERVES WERE SET ONLY BY `agent-org start`. After the 15:20Z crash tailscaled came back with only :443 and :8443, so the board's :9443 and the terminals' :9444 were dead until the chairman's session served them again by
// hand, and a second time at 16:18:42 when a test removed them. `reapplyServes` (install/service.ts) is the check: this module runs it on the instance's first pass (the instance starts after the host, tailscaled and herdr) and again
// every {@link EXPOSURE_EVERY_MS} after that, and says each change once: a serve it put back, a port another entry holds (never touched), and a serve it could not make, with the sentence to act on. A pool made without
// `deps.serveCheck` (every test; the instance passes the machine's) checks nothing. The last result is kept for the board's alert.
import { defaultServiceDeps, reapplyServes, runWithin, type ServeCheck } from "../install/service.ts";
import { type PoolContext } from "./pool-context.ts";
import { log } from "./pool-state.ts";

/** The least time between two checks: the instance ticks every 30 s, and a request to the board wakes a tick sooner, so a check is not made for each. */
export const EXPOSURE_EVERY_MS = 25_000;

/** The longest one `tailscale` call of the check may take: it runs inside the tick, which waits for it. */
const SERVE_CALL_MS = 5_000;

/** How many checks apart the next is when the last one could not read or serve a port: a tailscaled that does not answer is not asked every time, since each call waits for it inside the tick. */
const REFUSED_BACKOFF = 5;

/** What the pool last read of its serves: when, and each service's check. Kept in memory: an instance that starts checks at once. */
export type ExposureState = { at: number | null; checks: readonly ServeCheck[]; said: Map<string, string> };

/** The machine's own check: the exposure the host file enables, asked about each registered service, with a time limit on every `tailscale` call. The instance passes it as `serveCheck`; no test does. */
export const liveServeCheck = (): Promise<readonly ServeCheck[]> => reapplyServes({ ...defaultServiceDeps(), run: (file, args) => runWithin(file, args, SERVE_CALL_MS) });

/** What the log says of one check, or null when there is nothing to say: this board's entry in its place. PURE. */
function lineOf(check: ServeCheck): string | null {
  const where = check.port === null ? check.service : `${check.service} (port ${check.port})`;
  if (check.state === "reapplied") return `the ${where} serve was gone, and the board put it back`;
  if (check.state === "foreign") return `the ${where} serve is held by another entry, which the board leaves alone: ${check.why}`;
  return check.state === "refused" ? `the ${where} serve is not in place and the board could not put it back: ${check.why}` : null;
}

/** Say each check's line once: the same line again is not said, and a service that is back in place forgets its last line, so a later loss is said. */
function say(state: ExposureState, checks: readonly ServeCheck[]): void {
  for (const check of checks) {
    const line = lineOf(check);
    if (line === null) state.said.delete(check.service);
    else if (state.said.get(check.service) !== line) {
      state.said.set(check.service, line);
      log(line);
    }
  }
}

/** Check the serves if none was checked in the last {@link EXPOSURE_EVERY_MS}, and keep the result. A check that throws is said, and tried again at the next. */
export async function reconcileExposure(ctx: PoolContext): Promise<void> {
  const check = ctx.deps.serveCheck;
  const { exposure } = ctx;
  const every = exposure.checks.some(({ state }) => state === "refused") ? EXPOSURE_EVERY_MS * REFUSED_BACKOFF : EXPOSURE_EVERY_MS;
  if (check === undefined || (exposure.at !== null && ctx.now() - exposure.at < every)) return;
  exposure.at = ctx.now();
  try {
    exposure.checks = await check();
  } catch (err) {
    log(`the serves could not be checked: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return;
  }
  say(exposure, exposure.checks);
}
