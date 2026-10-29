// @ts-check
// module: the herdr seam -- the calls the pool makes to herdr and their defaults, herdr's server command, and the names its runs are given

import { herdrAgentName, herdrRefusal, herdrRun } from "../herdr-agents.ts";
import { execFile, spawn } from "node:child_process";
import { defaultServiceDeps, serviceState, unitFor, type ServiceDeps } from "../install/service.ts";

export type Herdr =(args: string[], timeoutMs?: number) => string;

export const defaultHerdr: Herdr = (args, timeoutMs = 30_000) => herdrRun(args, timeoutMs);

/** herdr without holding the loop: the one slow call, `agent start`, so a start does not stop the board answering, and (A11-282) the listings every pass of the tick makes. */
export type HerdrAsync = (args: string[], timeoutMs: number) => Promise<string>;

export const defaultHerdrAsync: HerdrAsync = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("herdr", args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)));
});

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
