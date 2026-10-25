// @ts-check
// module: what a Dependabot pull request is to the board -- a major update, a group of updates, or something to leave alone (A11-255)
//
// PURE, and fed OUTSIDE INPUT: a pull request's title and branch are the bot's, but the bot copies a package's own text into them. A field is therefore read only when it matches a strict pattern, and anything that does not
// is `skip` with its reason, never guessed at. The pull request's AUTHOR is checked before this is called (`openDependencyPulls`), so this decides what a bot's pull request is and never whether it is the bot's.

/** An update the agent has to make by hand: the package, the versions as the title names them, and the semver major it moves to. */
export type MajorUpdate = Readonly<{ kind: "major"; package: string; from: string; to: string; major: number; ecosystem: string | null }>;
/** A grouped update: its name as the title or the branch gives it. */
export type GroupUpdate = Readonly<{ kind: "group"; group: string }>;
/** Anything else, with why: a minor, a patch, an Actions sha move, a title that does not parse. */
export type SkippedUpdate = Readonly<{ kind: "skip"; reason: string }>;
export type DependencyUpdate = MajorUpdate | GroupUpdate | SkippedUpdate;

/** A package name as npm, pip and GitHub Actions write one: `@scope/name`, `name`, `owner/repo`, `owner/repo/path`. */
export const PACKAGE_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
/** A version with a numeric major of at most four digits, so a commit sha (Actions' non-semver move) is never read as one. */
const VERSION = /^v?(\d{1,4})(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]+)?$/;
/** A group's name: a word, as `dependabot.yml` writes a key. */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The title without its commit-message prefix (`deps: `, `deps-dev: `, `chore(deps): `). */
const withoutPrefix = (title: string): string => title.trim().replace(/^[a-z][a-z-]*(?:\([^)]*\))?!?:\s*/i, "");

const GROUP_TITLE = /^bump the (\S+) group\b/i;
const BUMP_TITLE = /^bump (\S+) from (\S+) to (\S+?)(?: in \S+)?$/i;
/** A grouped update's branch: `dependabot/<ecosystem>[/<directory>]/<group>-<hash>`, where the hash is hexadecimal and a single update's branch ends in a version. */
const GROUP_BRANCH = /^dependabot\/[^/]+\/(?:.+\/)?([^/]+?)-[0-9a-f]{12,}$/i;
const ECOSYSTEM_BRANCH = /^dependabot\/([A-Za-z0-9_]+)\//;

/** The semver major of a version, or null when it is not one. */
const majorOf = (version: string): number | null => {
  const found = VERSION.exec(version);
  return found === null ? null : Number(found[1]);
};

/**
 * What a Dependabot pull request is. A GROUP is named by its title (`bump the <group> group`) or its branch. A MAJOR is an ungrouped `bump <package> from <a> to <b>` whose semver majors differ, as Dependabot's own `update-types` count
 * them: `0.1.7` to `0.10.2` is a minor, which the standard configuration groups, and a red group catches it if it breaks. Everything else is skipped, a non-semver Actions sha move among it.
 */
export function classifyDependencyPull({ title, headRefName }: Readonly<{ title: string; headRefName: string }>): DependencyUpdate {
  const text = withoutPrefix(title);
  const named = GROUP_TITLE.exec(text)?.[1] ?? GROUP_BRANCH.exec(headRefName)?.[1];
  if (named !== undefined) return GROUP_NAME.test(named) ? { kind: "group", group: named } : { kind: "skip", reason: `its group's name is not a word: ${JSON.stringify(named.slice(0, 40))}` };
  const bump = BUMP_TITLE.exec(text);
  if (bump === null) return { kind: "skip", reason: `its title is not "bump <package> from <a> to <b>": ${JSON.stringify(title.slice(0, 80))}` };
  const [, name, from, to] = bump;
  if (!PACKAGE_NAME.test(name)) return { kind: "skip", reason: `its package name is not one npm, pip or Actions writes: ${JSON.stringify(name.slice(0, 80))}` };
  const [before, after] = [majorOf(from), majorOf(to)];
  if (before === null || after === null) return { kind: "skip", reason: `${name} moves ${from.slice(0, 40)} to ${to.slice(0, 40)}, which are not both semver versions` };
  if (before === after) return { kind: "skip", reason: `${name} moves ${from} to ${to}, which is not a major` };
  return { kind: "major", package: name, from, to, major: after, ecosystem: ECOSYSTEM_BRANCH.exec(headRefName)?.[1] ?? null };
}

/** The key of a major in the state file: the repository, the package and the major it moves to, so a later pull request for the same major is the same ticket. */
export const majorKey = (repository: string, update: Pick<MajorUpdate, "package" | "major">): string => `${repository}:${update.package.toLowerCase()}@${update.major}`;

/** The key of a red group in the state file: the pull request and the head that stayed red, so a push that turns it red again is a new ticket only if it stays red after its own rerun. */
export const redGroupKey = (repository: string, number: number, head: string): string => `${repository}#${number}@${head}`;
