// module: the GitHub plugin's doctor checks -- the stacking extension for the workers' account, and whether GitHub makes stacked pull requests available (A11-160)
//
// Moved out of `install/doctor.ts` (`stackChecks`, `stacksChecks`) with the rows' names and words unchanged: `gh stack` and `stacked pull requests`. The code host block's `stack` setting
// says whether the extension is required (true unless it is false); a host that does not require it is asked nothing. The workers' account is the block's `gh.workers` folder, and the
// repositories asked are the GitHub remotes of the host's clones.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { accountRunner } from "./gh.ts";
import { type Account, githubRepoOf, installCommand, STACK_EXTENSION, stackExtensionIn, stackRequired, stacksOf, workerAccount } from "./stack-extension.ts";

const STACK_DOCS = "https://github.github.com/gh-stack/";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** The origin remote of a clone, or null when it has none or git cannot say. */
function originOf(path: string, deps: Pick<PluginDeps, "exec">): string | null {
  const result = deps.exec("git", ["-C", path, "remote", "get-url", "origin"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Each GitHub repository a clone of this host names, once, as `owner/name`: the repositories the board opens pull requests in. A host with no GitHub clone names none. */
export function githubRepositoriesOf(deps: Pick<PluginDeps, "clones" | "exec">): string[] {
  return [...new Set(Object.values(deps.clones).flatMap((path) => {
    const remote = originOf(path, deps);
    const repo = remote === null ? null : githubRepoOf(remote);
    return repo === null ? [] : [repo];
  }))];
}

/** Whether GitHub makes stacked pull requests available to each GitHub repository a clone names. A host with no GitHub clone adds no check. */
function stacksChecks(account: Account, deps: PluginDeps): PluginCheck[] {
  const name = "stacked pull requests";
  const repos = githubRepositoriesOf(deps);
  if (repos.length === 0) return [];
  const run = accountRunner(deps, account);
  const readings = repos.map((repo) => [repo, stacksOf(run, repo)] as const);
  const refused = readings.filter(([, reading]) => reading.kind === "refused").map(([repo]) => repo);
  if (refused.length > 0) {
    return [failed(name, `GitHub refuses stacked pull requests for ${refused.join(", ")}`,
      `stacked pull requests are a GitHub preview that must be available to each repository: confirm ${refused.join(", ")} has access, or, where your organization controls previews, the organization, and that the workers' account can see it; see ${STACK_DOCS}`)];
  }
  const unread = readings.flatMap(([repo, reading]) => (reading.kind === "unknown" ? [`${repo}: ${reading.reason}`] : []));
  if (unread.length > 0) {
    return [failed(name, `GitHub's answer could not be read for ${unread.join("; ")}`, "run `gh api repos/<owner>/<repo>/stacks` with the workers' GH_CONFIG_DIR to see why")];
  }
  return [ok(name, `available for ${repos.join(", ")}`)];
}

/**
 * The `github/gh-stack` extension a worker's `gh stack link` needs (A11-106), listed for the workers' account: a failure with the install command when it is missing. Once it is listed,
 * each GitHub repository a clone names is asked whether GitHub makes stacked pull requests available to it. Nothing on a host whose `stack` setting is false.
 */
export function stackChecks(settings: PluginSettings, deps: PluginDeps): PluginCheck[] {
  if (!stackRequired(settings)) return [];
  const name = "gh stack";
  const account = workerAccount(settings.gh, deps.env);
  const listing = accountRunner(deps, account)(["extension", "list"]);
  if (listing.status !== 0) {
    const why = listing.stderr.trim().split("\n")[0] || `exit ${listing.status}`;
    return [failed(name, `\`gh\` could not list its extensions, so the extension a worker links a stacked pull request with is not checked: ${why}`,
      "install the GitHub CLI and put `gh` on PATH, then run `agent-org onboard`")];
  }
  const found = stackExtensionIn(listing.stdout);
  if (found === null) {
    return [failed(name, "`gh stack` is not installed, so a worker cannot link a stacked pull request", `${installCommand(account)}, or run \`agent-org onboard\``)];
  }
  const scope = account.GH_CONFIG_DIR === undefined ? "this machine's gh account" : `GH_CONFIG_DIR=${account.GH_CONFIG_DIR}`;
  return [ok(name, `${STACK_EXTENSION} ${found.version} (for ${scope})`), ...stacksChecks(account, deps)];
}
