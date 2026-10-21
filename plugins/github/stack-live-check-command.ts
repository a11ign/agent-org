#!/usr/bin/env node
// @ts-check
// command: ticket:stack-live-check -- prove the stacked-pull-request retarget on GitHub before merge: a scratch branch stands in for the default branch, A is
// merged into it, stacked B is retargeted by the same sweep the board runs, and B's base is read back. Removes every branch and pull request it made, even when
// a step fails. Run it from the branch you want proved. Its one reading of GitHub is as the workers' account, the one the board's sweep acts as.
//
// Usage: agent-org ticket:stack-live-check [--repo <owner/repo>]   (default a11ign/agent-org)
//
// THE COMMAND LIVES IN THE PLUGIN (A11-160): it is all GitHub, and the command table (`src/commands.ts`) names it by its path. It runs `gh` through the plugin's own runner, with a
// real `spawnSync` for `deps.exec`, since a plugin imports core's types only (ADR 0001).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ghRunner } from "./gh.ts";
import { runLiveCheck } from "./stack-live-check.ts";

const DEFAULT_REPO = "a11ign/agent-org";
const REFUSED = 2;
const USAGE = "agent-org ticket:stack-live-check [--repo <owner/repo>]";

/** Runs a program for real: its status (null when it could not start, with the reason in stderr) and what it printed. */
const exec = (file: string, args: readonly string[], options: { timeoutMs?: number; env?: Readonly<Record<string, string>> } = {}) => {
  const result = spawnSync(file, [...args], { encoding: "utf8", timeout: options.timeoutMs, env: { ...process.env, ...options.env }, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg, index) => arg.startsWith("-") && arg !== "--repo" && !(index > 0 && args[index - 1] === "--repo"));
  if (unknown.length > 0) {
    console.error(`${USAGE}: ${unknown[0]} is not a flag this command reads`);
    process.exitCode = REFUSED;
  } else {
    const at = args.indexOf("--repo");
    const repo = at === -1 ? DEFAULT_REPO : args[at + 1] ?? "";
    if (/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      const passed = runLiveCheck({ repo, runId: Date.now().toString(36), gh: ghRunner({ exec }), log: (line) => console.log(line) });
      process.exitCode = passed ? 0 : 1;
    } else {
      console.error(`agent-org ticket:stack-live-check: --repo ${repo} is not owner/repo`);
      process.exitCode = REFUSED;
    }
  }
}
