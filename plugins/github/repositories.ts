// module: the repositories a person can pick at onboard, as GitHub holds them (A11-186) -- the accounts and organisations, their repositories, the repository a remote names, and the clone
//
// Every call is the person's own `gh` login, with no role environment (the contract says onboard's repository calls run "as the person's own login"): a GitHub App's installation token cannot list a person's
// organisations. Every read goes through the plugin's one runner (`gh.ts`), so this file spawns nothing. A read answers `null` for "could not ask", never for "there is none".
import type { CodeHostRepositories, HostRepository, RepositoryOwner } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";
import { GhFailure, ghRunner, type Gh } from "./gh.ts";
import { readOwnLogin } from "./pull-feedback.ts";
import { repoCloneArgs } from "./repo-args.ts";

/** The most repositories one `gh repo list` returns. A list AT this length may be cut short, so it is no reading (`null`), as `openPullUrlsOf`'s is not. */
export const REPOSITORY_LIST_LIMIT = 1000;

/** How long one clone may run: `GH_TIMEOUT_MS` is meant for API reads, and would cut off a large repository. */
export const CLONE_TIMEOUT_MS = 600_000;

const SEGMENT = "[A-Za-z0-9._-]+";
/** `https://github.com/o/n`, `http://`, `git+https://`, `ssh://git@github.com/o/n` and `git://`, each with an optional user and port. */
const URL_REMOTE = new RegExp(`^(?:git\\+)?(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com(?::\\d+)?/(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`, "i");
/** `git@github.com:o/n`. */
const SCP_REMOTE = new RegExp(`^(?:[^@/\\s]+@)?github\\.com:(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`, "i");

/** The repository a git remote URL names, as written in it, or null for another host's URL. */
export function repositoryOfRemote(url: string): HostRepository | null {
  const match = URL_REMOTE.exec(url.trim()) ?? SCP_REMOTE.exec(url.trim());
  return match === null ? null : { name: match[2], fullName: `${match[1]}/${match[2]}` };
}

/** A word of a command as a person would type it: quoted when a shell would split or expand it. */
const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** The command `cloneRepository` runs, as a person would type it. */
export const cloneCommand = (fullName: string, path: string): string => ["gh", ...repoCloneArgs(fullName, path)].map(shellWord).join(" ");

/** The first line of `text` that says something, or "". */
const firstLineOf = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/** The signed-in account first, then the organisations it belongs to, by login; null when either call fails. */
export function readOwners(gh: Gh): readonly RepositoryOwner[] | null {
  try {
    const login = readOwnLogin(gh);
    if (login === null) return null;
    const organisations = gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"]).split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();
    return [{ login, kind: "account" }, ...organisations.map((org): RepositoryOwner => ({ login: org, kind: "organisation" }))];
  } catch (error) {
    void error; // "could not ask": the caller says so, and acts on nothing
    return null;
  }
}

/** The owner's repositories, archived ones left out, by name; null when the call fails, answers another shape, or is cut off at its limit. */
export function readRepositories(owner: RepositoryOwner, gh: Gh): readonly HostRepository[] | null {
  try {
    // With no owner, `gh repo list` lists the signed-in account's own repositories, private ones included.
    const listed: unknown = JSON.parse(gh(["repo", "list", ...(owner.kind === "account" ? [] : [owner.login]), "--no-archived", "--limit", String(REPOSITORY_LIST_LIMIT), "--json", "name,nameWithOwner"]));
    if (!Array.isArray(listed) || listed.length >= REPOSITORY_LIST_LIMIT) return null;
    const repositories = listed.map((entry: { name?: unknown; nameWithOwner?: unknown }): HostRepository | null =>
      (typeof entry?.name === "string" && typeof entry.nameWithOwner === "string" ? { name: entry.name, fullName: entry.nameWithOwner } : null));
    return repositories.includes(null) ? null : (repositories as HostRepository[]).sort((a, b) => a.name.localeCompare(b.name) || a.fullName.localeCompare(b.fullName));
  } catch (error) {
    void error; // "could not ask"
    return null;
  }
}

/** Clones `fullName` to `path`: null once cloned, else the first line of why not. `gh repo clone` hands git its own credential helper, so a private repository clones with the same login. */
function cloneAs(gh: Gh, fullName: string, path: string): string | null {
  try {
    gh(repoCloneArgs(fullName, path));
    return null;
  } catch (error) {
    const said = error instanceof GhFailure ? firstLineOf(error.stderr) : "";
    return said !== "" ? said : firstLineOf((error as Error).message) || "gh failed";
  }
}

/** The `repositories` group of the GitHub code host (contract 1.14). */
export function createRepositories(deps: Pick<PluginDeps, "exec">): CodeHostRepositories {
  const gh = ghRunner(deps);
  const cloning = ghRunner(deps, {}, { timeoutMs: CLONE_TIMEOUT_MS });
  return {
    readOwners: () => readOwners(gh),
    readRepositories: (owner) => readRepositories(owner, gh),
    repositoryOfRemote,
    cloneCommand,
    cloneRepository: (fullName, path) => cloneAs(cloning, fullName, path),
  };
}
