// module: the open pull requests the dependency bot opened, as the code host reads them (contract 1.19, A11-255)
//
// Read with a plain `gh pr list --state open` and filtered by each pull request's AUTHOR here, never by its title: that is the trust boundary of the board's dependency tickets, because the title and body of a pull request are
// outside input that a privileged ticket-writing run is later briefed from. It passes no `--author`: `gh` sends that flag as a GitHub SEARCH, whose allowance is separate from and far smaller than the GraphQL points, and a
// scheduler installation has spent it before (`src/packaging/no-search-reads.test.ts`). Null is "could not ask": a refused `gh`, an answer that does not parse, a pull request this cannot read and a list at the limit are all
// null, never "there are none".
import type { DependencyPull } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";

/** The most one read returns. A list AT this length may be cut short, so it is no reading (`null`). */
export const DEPENDENCY_PULLS_LIMIT = 200;

/** The fields asked of `gh pr list`. */
export const DEPENDENCY_PULLS_FIELDS = "number,title,headRefName,headRefOid,author,body,url";

/** The account the contract names (`DEPENDENCY_PULL_AUTHOR`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
const DEPENDENCY_PULL_AUTHOR: DependencyPull["author"] = "dependabot[bot]";

/** The ways `gh` prints the bot's login: `app/dependabot` as `gh pr list --json author` spells it, `dependabot` in older output, and `dependabot[bot]` as GitHub's API names it. */
const BOT_LOGINS: readonly string[] = ["app/dependabot", "dependabot", DEPENDENCY_PULL_AUTHOR];

type Listed = { number?: unknown; title?: unknown; headRefName?: unknown; headRefOid?: unknown; url?: unknown; body?: unknown; author?: { login?: unknown; is_bot?: unknown } | null };

/** Whether a listed pull request's author is the dependency bot: a login `gh` prints for it, and not marked as a person. */
const byTheBot = ({ author }: Listed): boolean => typeof author?.login === "string" && BOT_LOGINS.includes(author.login) && author.is_bot !== false;

/** The text of a field, or null when it is not text. */
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** One listed pull request as the contract has it, or null for one this cannot read. */
function dependencyPullOf(listed: Listed): DependencyPull | null {
  const fields = { url: textOf(listed.url), title: textOf(listed.title), headRefName: textOf(listed.headRefName), headSha: textOf(listed.headRefOid) };
  if (typeof listed.number !== "number" || Object.values(fields).includes(null)) return null;
  return { ...(fields as Record<keyof typeof fields, string>), number: listed.number, author: DEPENDENCY_PULL_AUTHOR, body: textOf(listed.body) ?? "" };
}

/**
 * THE OPEN PULL REQUESTS OF `repo` THE DEPENDENCY BOT OPENED, or `null` for "could not ask". A pull request by anyone else is left out, and one the bot opened that this cannot read fails the whole read: it is no reading of what is there.
 */
export function openDependencyPulls(repo: string, gh: Gh): readonly DependencyPull[] | null {
  try {
    const listed: Listed[] = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(DEPENDENCY_PULLS_LIMIT), "--json", DEPENDENCY_PULLS_FIELDS]));
    if (!Array.isArray(listed) || listed.length >= DEPENDENCY_PULLS_LIMIT) return null;
    const pulls = listed.filter(byTheBot).map(dependencyPullOf);
    return pulls.includes(null) ? null : (pulls as DependencyPull[]);
  } catch (error) {
    void error; // a list the host will not give is "could not ask", and the board asks again at its next sweep
    return null;
  }
}
