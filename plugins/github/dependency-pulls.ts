// module: the open pull requests the dependency bot opened, as the code host reads them (contract 1.19, A11-255)
//
// Read from the repository's snapshot of its open pull requests (`pull-snapshot.ts`, A11-365) and filtered by each pull request's AUTHOR here, never by its title: that is the trust boundary of the board's dependency tickets, because the title and body of a pull request are
// outside input that a privileged ticket-writing run is later briefed from. It passes no author to GitHub: a `gh` flag for it is sent as a GitHub SEARCH, whose allowance is separate from and far smaller than the GraphQL points, and a
// scheduler installation has spent it before (`src/packaging/no-search-reads.test.ts`). Null is "could not ask": a repository that cannot be read, a pull request this cannot read and a list read in part are all
// null, never "there are none".
import type { DependencyPull } from "../../src/plugins/contracts/code-host.ts";
import type { PullNode, PullSnapshots } from "./pull-snapshot.ts";

/** The account the contract names (`DEPENDENCY_PULL_AUTHOR`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
const DEPENDENCY_PULL_AUTHOR: DependencyPull["author"] = "dependabot[bot]";

/** The ways the bot's login is spelled: `app/dependabot` as `gh pr list --json author` spells it, `dependabot` in older output, and `dependabot[bot]` as GitHub's API names it. */
const BOT_LOGINS: readonly string[] = ["app/dependabot", "dependabot", DEPENDENCY_PULL_AUTHOR];

type Listed = { number?: unknown; title?: unknown; headRefName?: unknown; headRefOid?: unknown; url?: unknown; body?: unknown; author?: { login?: unknown; __typename?: unknown } | null };

/** Whether a listed pull request's author is the dependency bot: a login for it, and an account GitHub types as a bot, never a person who holds the same name. */
const byTheBot = ({ author }: Listed): boolean => typeof author?.login === "string" && BOT_LOGINS.includes(author.login) && author.__typename === "Bot";

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
export async function openDependencyPulls(repo: string, snapshots: PullSnapshots): Promise<readonly DependencyPull[] | null> {
  const snapshot = await snapshots.snapshot(repo);
  if (snapshot === null || !snapshot.complete) return null;
  const pulls = [...snapshot.pulls.values()].filter((node: PullNode) => byTheBot(node)).map(dependencyPullOf);
  return pulls.includes(null) ? null : (pulls as DependencyPull[]);
}
