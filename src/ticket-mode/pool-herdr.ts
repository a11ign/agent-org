// @ts-check
// module: the herdr seam -- the calls the pool makes to herdr and their defaults, herdr's server command, and the names its runs are given

import { herdrReason, herdrRun } from "../herdr-agents.ts";
import { execFile, spawn } from "node:child_process";

export type Herdr =(args: string[], timeoutMs?: number) => string;

export const defaultHerdr: Herdr = (args, timeoutMs = 30_000) => herdrRun(args, timeoutMs);

/** herdr for the one slow call, `agent start`, so a start does not stop the board answering. */
export type HerdrAsync = (args: string[], timeoutMs: number) => Promise<string>;

export const defaultHerdrAsync: HerdrAsync = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("herdr", args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)));
});

export const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The command that starts a session's headless herdr server so it OUTLIVES THIS PROCESS AND ITS SERVICE (A11-78). PURE.
 *
 * `detached` alone is not enough under systemd. A detached child leaves the instance's process group, and launchd, which ends a job's process
 * group, then leaves it alone; but systemd ends a unit by its CONTROL GROUP, and a child stays in its parent's cgroup whatever its process group.
 * Measured on a Linux host 2026-10-17: `herdr --session tickets server`, every pane's shell and every worker's `claude` were listed under
 * `agent-org-instance.service`, so `systemctl --user restart` (which `agent-org update` runs every hour) sent each of them SIGTERM. The server
 * died, the next instance started a new one, herdr restored the workspaces and resumed each worker with `claude --resume`, and the pane showed
 * "Interrupted · What should Claude do instead?" with the worker sitting at its prompt; a reviewer the instance had started was gone.
 *
 * So under systemd (`INVOCATION_ID`, which systemd sets for every unit it runs) the server is started through `systemd-run --user --scope`,
 * which moves it into a scope of its own before it runs: it keeps this process's environment, and the instance's unit no longer holds it. A
 * process started by hand, or by launchd, starts herdr directly, as before.
 */
export function herdrServerCommand(session: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): { file: string; args: string[] } {
  const herdrArgs = ["--session", session, "server"];
  if (platform !== "linux" || !env.INVOCATION_ID) return { file: "herdr", args: herdrArgs };
  const unit = `agent-org-herdr-${session.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return { file: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--description=herdr server for agent-org ticket mode", "herdr", ...herdrArgs] };
}

/** Start a session's headless herdr server, detached and outside this service, so it outlives this process as the org's does under its own unit. */
export const defaultStartServer = (session: string): void => {
  const { file, args } = herdrServerCommand(session, process.env, process.platform);
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
};

/**
 * A ticket's name in herdr, for its workspace and its agent: herdr refuses an agent name that is not a lowercase letter followed by up to 31
 * lowercase letters, digits, `-` or `_` (measured 2026-10-13, `invalid_agent_name` for `SMOKE-1`), and a tracker's keys are upper case.
 */
export const herdrName = (key: string): string => `t-${key.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);

/** Why herdr refused: it answers a refusal as JSON on stdout (`{"error":{"message":...}}`), which `herdrReason` (stderr) does not read. */
export function herdrRefusal(err: unknown): string {
  try {
    const message = JSON.parse(String((err as { stdout?: unknown })?.stdout ?? "")).error?.message;
    if (typeof message === "string") return message;
  } catch {
    // not herdr's JSON
  }
  return herdrReason(err);
}
