#!/usr/bin/env node
// @ts-check
// command: ticket:stack-live-check -- prove the stacked-pull-request retarget on GitHub before merge: a scratch branch stands in for the default branch, A is
// merged into it, stacked B is retargeted by the same sweep the board runs, and B's base is read back. Removes every branch and pull request it made, even when
// a step fails. Run it from the branch you want proved. Its one reading of GitHub is as the workers' account, the one the board's sweep acts as.
//
// Usage: agent-org ticket:stack-live-check [--repo <owner/repo>]   (default a11ign/agent-org)
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { runLiveCheck } from "../ticket-port/stack-live-check.ts";

const DEFAULT_REPO = "a11ign/agent-org";
const REFUSED = 2;

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--repo"], { entry: import.meta.url, command: "agent-org ticket:stack-live-check [--repo <owner/repo>]" });
  const args = process.argv.slice(2);
  const at = args.indexOf("--repo");
  const repo = at === -1 ? DEFAULT_REPO : args[at + 1] ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error(`agent-org ticket:stack-live-check: --repo ${repo} is not owner/repo`);
    process.exitCode = REFUSED;
  } else {
    const passed = runLiveCheck({ repo, runId: Date.now().toString(36), gh: defaultGh, log: (line) => console.log(line) });
    process.exitCode = passed ? 0 : 1;
  }
}
