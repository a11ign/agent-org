// @ts-check
// module: the herdr seam -- the calls the pool makes to herdr and their defaults, herdr's server command, and the names its runs are given
//
// THE POOL'S ASYNC herdr CALLS GO THROUGH THE BOARD'S OUTSIDE CLIENT (A11-436 step 3, `outside-client.ts`), as Linear's and `gh`'s do: one timeout, the one rule for which failures are transient, a breaker, and one counted
// call. Unlike theirs, each herdr call is made once ({@link herdrThroughClient} says why).
// The synchronous `defaultHerdr` makes its call once (a retry's wait would hold the loop) and is counted by `herdrRun`; the probe of whether the server is up is asked directly ({@link defaultHerdrProbe}).

import { herdrAgentName, herdrAnswer, herdrRefusal, herdrRun } from "../herdr-agents.ts";
import { spawn } from "node:child_process";
import { defaultServiceDeps, serviceState, unitFor, type ServiceDeps } from "../install/service.ts";
import type { ExecOptions, ExecResult } from "../plugins/manifest.ts";
import { realExecAsync } from "../plugins/real-seams.ts";
import { outsideClient, type OutsideClient } from "./outside-client.ts";

export type Herdr =(args: string[], timeoutMs?: number) => string;

export const defaultHerdr: Herdr = (args, timeoutMs = 30_000) => herdrRun(args, timeoutMs);

/** How long the board thread waits for one asynchronous herdr call, in ms: the cut the synchronous call has always had. The wait holds no loop (A11-282). */
export const HERDR_CALL_MS = 30_000;

/** herdr without holding the loop: the one slow call, `agent start`, so a start does not stop the board answering, and (A11-282) the listings every pass of the tick makes. */
export type HerdrAsync = (args: string[], timeoutMs: number) => Promise<string>;

/**
 * How much later than the program's own cut the client cuts an attempt, in ms: a herdr that runs past its time is stopped by `exec` and answers `ETIMEDOUT`, as it always did, and the client's cut only ends an
 * attempt whose `exec` never answers.
 */
const CLIENT_CUT_GRACE_MS = 1_000;

/** How a herdr call is run: the program, its arguments, and `exec`'s options. `realExecAsync` by default. */
export type ExecAsync = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

/**
 * herdr through the board's outside client (A11-436 step 3), the way the code host's `gh` goes through it: each attempt is cut at the call's own time, herdr's breaker refuses at once while herdr keeps failing
 * (the client's `ServiceUnavailable`, transient, which says herdr is unavailable), and the call counts once in the `herdr` figure, so `exec` is told not to count it again. A failure rejects with
 * {@link herdrAnswer}'s error, which carries the exit the one rule classes it by: a herdr that never answers fails as transient. `echo` says a refusal on this process's stderr.
 *
 * EVERY herdr CALL IS MADE ONCE: herdr is this host's own server, and a herdr that does not answer within a call's 30 s does not answer 200 ms later. Tried again, a hung herdr's listing would hold the pass four
 * times as long (about two minutes) before the pool reads the run as unknown and reads again on its next pass, which every caller of a herdr read already does.
 */
export function herdrThroughClient({ outside = outsideClient, exec = realExecAsync, echo = true }: { outside?: OutsideClient; exec?: ExecAsync; echo?: boolean } = {}): HerdrAsync {
  return async (args, timeoutMs) => {
    const answer = await outside.call("herdr", () => exec("herdr", args, { timeoutMs, countedByCaller: true }),
      { exitOf: (result) => result, attemptMs: timeoutMs + CLIENT_CUT_GRACE_MS, once: true });
    return herdrAnswer(args, answer, { echo });
  };
}

/** `agent start` through the board's outside client. Its refusal is not said: the busy-pane retry waits through `agent_pane_busy`, which it reads off the error's `stderr`. */
export const defaultHerdrAsync: HerdrAsync = herdrThroughClient({ echo: false });

/**
 * herdr without holding the loop, for the calls whose refusal is read or said (A11-282): the pane a start opens, the listings it settles on and the close of an ended run's workspace. The error carries herdr's own
 * stderr and says it on this process's stderr, as the synchronous `herdrRun` did, so a card quotes herdr's reason and not the command line. Through the board's outside client.
 */
export const defaultHerdrCall: HerdrAsync = herdrThroughClient();

/**
 * herdr asked directly, outside the board's client: the listing that says whether the session's server is up (`ensureSession`). It must say what herdr answers now, while herdr's breaker may be open from the
 * failures that made the board ask, and its tries while a server starts must not open the breaker for the rest of the pool. It is not counted in the figure either: up to twenty refusals of a server that is
 * starting are the board waiting for it, not herdr failing calls.
 */
export const defaultHerdrProbe: HerdrAsync = async (args, timeoutMs) => herdrAnswer(args, await realExecAsync("herdr", args, { timeoutMs, countedByCaller: true }));

export const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The command that starts a session's headless herdr server directly. It is the way of a machine whose herdr has no service of its own (someone running `ticket:serve` by hand): a machine that
 * runs the services starts herdr's UNIT instead (`herdrServiceOf`, A11-169), because a server the instance spawns lives in the instance's cgroup or in a transient scope the instance made, and carries
 * the instance's working directory, which is a version folder an update prunes. PURE.
 */
export const herdrServerCommand = (session: string): { file: string; args: string[] } => ({ file: "herdr", args: ["--session", session, "server"] });

/** Start a session's headless herdr server directly, detached so it outlives this process. Only for a machine with no herdr service. */
export const defaultStartServer = (session: string): void => {
  const { file, args } = herdrServerCommand(session);
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
};

/** The herdr service of this machine, when it has one registered: the instance starts the unit and never spawns the server itself. */
export type HerdrService = Readonly<{ registered: () => boolean; start: () => void }>;

/** This machine's herdr service: registered when its unit file exists, started with `start` (never a restart: a restart ends every pane). */
export function herdrServiceOf(services: ServiceDeps): HerdrService {
  return {
    registered: () => serviceState("herdr", services) !== "not-registered",
    start: () => {
      const unit = unitFor("herdr", services);
      if (unit.manager === "launchd") must(services.run("launchctl", ["kickstart", `gui/${services.uid}/${unit.id}`]), `launchctl kickstart ${unit.id}`);
      else must(services.run("systemctl", ["--user", "start", unit.id]), `systemctl --user start ${unit.id}`);
    },
  };
}

const must = (result: { status: number | null; stdout: string; stderr: string }, what: string): void => {
  if (result.status !== 0) throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`);
};

/**
 * A ticket's name in herdr, for its workspace and its agent: herdr refuses an agent name that is not a lowercase letter followed by up to 31
 * lowercase letters, digits, `-` or `_` (measured 2026-10-13, `invalid_agent_name` for `SMOKE-1`), and a tracker's keys are upper case. {@link herdrAgentName} makes it, shortening a long one with a hash (A11-241).
 */
export const herdrName = (key: string): string => herdrAgentName(`t-${key}`);

export { herdrRefusal };
