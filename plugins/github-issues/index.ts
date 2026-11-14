// @ts-check
// module: the GitHub Issues plugin -- the tracker, behind the tracker contract, for the issues of one GitHub repository (A11-447)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`), the second tracker beside `linear`. `package.json`'s `agentOrg` field is the manifest's data half; this is the code half: `create`
// builds the source from the block's `repo`, `prefix` and `key` settings, and the deps core gives it. How Linear's states, labels and sub-issues map onto GitHub Issues is in README.md.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). GitHub is asked, and the token read, through `deps` (`exec`, `readFile`, `fetch`), so the contract suite runs it without the network.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import type { TicketSource } from "../../src/plugins/contracts/tracker.ts";
import { tokenCheck } from "./checks.ts";
import { issuesSettings, readToken } from "./settings.ts";
import { issuesSource } from "./source.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The GitHub Issues source for a tracker block. REFUSES, by name, a block whose settings are of the wrong shape, and a token that cannot be read. */
export function create(settings: PluginSettings, deps: PluginDeps): TicketSource {
  const read = issuesSettings(settings);
  const request = deps.freshFetch ?? deps.fetch;
  const client = { token: readToken(read.token, deps), request, retryRequest: deps.retryFetch ?? request, sleep: wait, log: deps.log };
  return issuesSource({ owner: read.owner, repo: read.repo, prefix: read.prefix, client, pick: deps.pick, readFile: deps.readFile });
}

/** The rows doctor shows for the plugin: the settings and the token. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] => [tokenCheck(settings, deps)];

/** Onboard asks nothing for it yet: a person sets `repo` and the token as README.md says. */
export const onboardSteps = [];
