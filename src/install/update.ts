#!/usr/bin/env node
// @ts-check
// command: update -- move this install to the newest release (or `--version vX.Y.Z`, or `--channel main`), and restart each service that was running
//
// THE MOVE IS `update-tool.ts`'s, not a second one. `updateTool` fetches the tags, refuses a dirty checkout, picks the newest release tag or the pinned
// one, puts the release's dependencies in place first and detaches at the tag. `--channel main` follows `origin/main` instead, for a person testing what
// has merged and not been released. Only this command moves the checkout `install.sh` made, so a running service holds the old modules until it restarts:
// each service that was RUNNING before the move is restarted after it, and a stopped one is left stopped.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isReleaseTag, LATEST } from "../lib/release-tag.ts";
import { pnpmCliInvocation } from "../lib/npm-cli-executable.ts";
import { installDependencies, updateTool, type DependencyInstall } from "../update-tool.ts";
import { defaultServiceDeps, restartService, SERVICE_NAMES, serviceState, type ServiceName, type ServiceState } from "./service.ts";
import { TOOL_ROOT } from "./paths.ts";

export type Channel = "release" | "main";
export type Git = (args: string[]) => string;

export type UpdateDeps = Readonly<{
  root: string;
  git: Git;
  /** The release path's dependency install, before the checkout moves. */
  installForTag: (tag: string) => DependencyInstall;
  /** `--channel main`'s dependency install, in the checkout once it has moved. */
  installInPlace: () => void;
  state: (name: ServiceName) => ServiceState;
  restart: (name: ServiceName) => void;
  out: Pick<Console, "log" | "error">;
}>;

export class UpdateRefusal extends Error {}

/** Move the checkout and restart what ran. @returns whether the checkout moved */
export function update({ version, channel }: { version: string | undefined; channel: Channel }, deps: UpdateDeps): boolean {
  if (version !== undefined && channel === "main") throw new UpdateRefusal("--version picks a release, and --channel main follows main: give one of them");
  if (version !== undefined && !isReleaseTag(version)) throw new UpdateRefusal(`--version ${version} is not a release tag such as v0.3.0`);
  // Read BEFORE the move: a restart is for a service that ran the old version, and nothing else.
  const running = SERVICE_NAMES.filter((name) => deps.state(name) === "running");
  const before = deps.git(["rev-parse", "HEAD"]).trim();
  if (channel === "main") {
    if (deps.git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
      throw new UpdateRefusal(`${deps.root} has changes to tracked files, so it was not moved. Discard them, or run update where they belong.`);
    }
    deps.git(["fetch", "--quiet", "origin", "main"]);
    deps.git(["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
    deps.installInPlace();
    deps.out.log(`agent-org main (${deps.git(["rev-parse", "HEAD"]).trim()})`);
  } else {
    deps.out.log(updateTool(deps.root, deps.git, version ?? LATEST, () => [], deps.installForTag));
  }
  const moved = deps.git(["rev-parse", "HEAD"]).trim() !== before;
  if (!moved) return false;
  for (const name of running) {
    deps.restart(name);
    deps.out.log(`restarted the ${name} service so it runs the version above`);
  }
  return true;
}

function defaultUpdateDeps(): UpdateDeps {
  const root = TOOL_ROOT;
  const git: Git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const services = defaultServiceDeps();
  return {
    root, git,
    installForTag: (tag) => installDependencies({ root, tag, run: git }),
    installInPlace: () => {
      const { command, args } = pnpmCliInvocation(["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"]);
      execFileSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    },
    state: (name) => serviceState(name, services),
    restart: (name) => restartService(name, services),
    out: console,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { version: { type: "string" }, channel: { type: "string", default: "release" } } });
    if (values.channel !== "release" && values.channel !== "main") throw new UpdateRefusal(`--channel ${values.channel} is not release or main`);
    update({ version: values.version, channel: values.channel }, defaultUpdateDeps());
  } catch (err) {
    console.error(`agent-org update: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
