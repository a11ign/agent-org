// module: the pull requests that name a ticket, as the code host reads them (contract 1.18, A11-240)
//
// Read with `gh search prs "<key>" --repo <repo> ... --match title,body --json url,repository,state,body,title` through the plugin's own `gh`. GitHub's search is loose (it tokenises `A11-240` into `A11` and `240`), so what it
// returns is narrowed to the pull requests whose title or body holds the key on word boundaries. It names no more than that: whether a pull request is the ticket's or only mentions it is the caller's to judge. Null is "could not ask": a refused
// `gh`, an answer that does not parse, and a list at the search's limit are all null, never "none names it".
import type { NamingPull } from "../../src/plugins/contracts/code-host.ts";
import type { AsyncGh, Gh } from "./gh.ts";

/** The most one search returns. A list AT this length may be cut short, so it is no reading (`null`). */
export const TICKET_PULLS_LIMIT = 100;

/** The fields asked of `gh search prs`. */
export const TICKET_PULLS_FIELDS = "url,repository,state,body,title";

const STATES: readonly string[] = ["open", "merged", "closed"];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a search result has the address, repository, state and title the contract's pull request is read from. */
const isReadable = (url: unknown, repo: unknown, state: unknown, title: unknown): boolean => typeof url === "string" && typeof repo === "string" && STATES.includes(state as string) && typeof title === "string";

/** One pull request of the search's answer as the contract has it, or null for one this cannot read. */
function pullOf(found: any): NamingPull | null {
  const { url, state, body, title } = found ?? {};
  const repo = found?.repository?.nameWithOwner;
  return isReadable(url, repo, state, title) ? { url, repo, state, body: typeof body === "string" ? body : "" } : null;
}

/** The `gh` arguments that search `repositories` for the pull requests that mention `key`. */
const searchArgs = (key: string, repositories: readonly string[]): string[] =>
  ["search", "prs", `"${key}"`, ...repositories.flatMap((repo) => ["--repo", repo]), "--match", "title,body", "--limit", String(TICKET_PULLS_LIMIT), "--json", TICKET_PULLS_FIELDS];

/** The pull requests of the search's answer `text` that name `key`, or null when the list is no reading: not a list, at the search's limit, or holding a pull request this cannot read. */
function namingIn(text: string, key: string): readonly NamingPull[] | null {
  const found = JSON.parse(text);
  if (!Array.isArray(found) || found.length >= TICKET_PULLS_LIMIT) return null;
  const pulls = found.map(pullOf);
  if (pulls.includes(null)) return null;
  const names = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(key)}(?![A-Za-z0-9])`, "i");
  return found.flatMap((pull, index) => (names.test(`${pull.title}\n${pull.body ?? ""}`) ? [pulls[index]!] : []));
}

/**
 * The pull requests of `repositories` (`owner/name`) whose title or body names `key`, or null for "could not ask". No repository is nothing to ask, and an empty list. A pull request in a state this does not know, or
 * with no address, fails the whole read: it is no reading of what is there.
 */
export function pullsNaming(key: string, repositories: readonly string[], gh: Gh): readonly NamingPull[] | null {
  if (repositories.length === 0) return [];
  try {
    return namingIn(gh(searchArgs(key, repositories)), key);
  } catch (error) {
    void error; // a search the host will not answer is "could not ask", and the board asks again at its next start
    return null;
  }
}

/** {@link pullsNaming} without holding the process still (A11-395). */
export async function pullsNamingAsync(key: string, repositories: readonly string[], gh: AsyncGh): Promise<readonly NamingPull[] | null> {
  if (repositories.length === 0) return [];
  try {
    return namingIn(await gh(searchArgs(key, repositories)), key);
  } catch (error) {
    void error; // a search the host will not answer is "could not ask", and the board asks again at its next start
    return null;
  }
}
