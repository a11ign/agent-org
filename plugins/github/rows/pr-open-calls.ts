// module: the GitHub operations `pr-open` asks (A11-160, step 9; moved from `src/pr-open.ts`)
//
// `pr-open` DECIDES: which body to refuse, which owner a pull request has, whether a held create travels with its arm and its label. What it asks of GitHub, and the command that asks it, is here. The four builders
// answer the argument lists `pr-open` hands to its own executor (the one that gives `gh` the terminal and the environment the gate's wrapper reads), because the wrapper may HOLD a rate-limited create and the arm and the
// label that follow it are then written down, as argument lists, to be made after it. The reads take the runner their caller made with its policy and THROW when `gh` refuses.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AuthoringLogin, PullHead } from "../../../src/plugins/contracts/code-host-rows-pullwork.ts";

/** The value after a `--flag` (or `--flag=value`) of the arguments the author gave `gh pr create`, or `null`. */
function flagAfter(args: readonly string[], flag: string): string | null {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** `--repo <repo>` when the call was made for one, else nothing: the arm and the label of a pull request opened in another repository are aimed there too (agent-org#753). */
function repoFlagOf(rest: readonly string[]): string[] {
  const repo = flagAfter(rest, "--repo");
  return repo === null ? [] : ["--repo", repo];
}

/**
 * The selector the arm and the label name the pull request by, after a create (agent-org#952): `--head` when it was passed. Otherwise the tree's own branch, but only with `--repo`: gh refuses `--repo` with no
 * selector ("argument required when using the --repo flag"), and without `--repo` gh reads the checkout's branch itself. `null` when `--repo` is given and no branch is known.
 */
function selectorOf(rest: readonly string[], branch: string | null): string[] | null {
  const head = flagAfter(rest, "--head");
  if (head) return [head];
  if (repoFlagOf(rest).length === 0) return [];
  return branch === null ? null : [branch];
}

export const pullWriteArgs = (mode: string, rest: readonly string[]): string[] => ["pr", mode, ...rest];

export function armArgsAfterCreate({ rest, branch }: { rest: readonly string[]; branch: string | null }): string[][] {
  const selector = selectorOf(rest, branch);
  return selector === null ? [] : [["pr", "merge", "--auto", "--merge", ...selector, ...repoFlagOf(rest)]];
}

export function labelArgsAfterCreate({ rest, branch, label }: { rest: readonly string[]; branch: string | null; label: string }): string[][] {
  const selector = selectorOf(rest, branch);
  return selector === null ? [] : [["pr", "edit", ...selector, ...repoFlagOf(rest), "--add-label", label]];
}

export const labelCreateArgs = ({ name, description, repo }: { name: string; description: string; repo: string | null }): string[] =>
  ["label", "create", name, "--description", description, ...(repo === null ? [] : ["--repo", repo])];

/** What `gh` printed on stderr, as the error carries it. */
const stderrOf = (error: unknown): string => `${(error as { stderr?: unknown }).stderr ?? ""}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** GitHub's own way to say a thing is not there. */
const NOT_FOUND = /HTTP 404|Not Found/i;

export function labelExistsForOpening({ name, repo = "{owner}/{repo}", run }: { name: string; repo?: string; run: RowsRun }): boolean {
  try {
    run(["api", `repos/${repo}/labels/${encodeURIComponent(name)}`, "--silent"]);
    return true;
  } catch (error) {
    if (NOT_FOUND.test(stderrOf(error))) return false;
    throw error;
  }
}

export const pullHeadForOpening = ({ repo, number, run }: { repo: string; number: string; run: RowsRun }): PullHead | null =>
  JSON.parse(run(["api", `repos/${repo}/pulls/${number}`, "--jq", "{ref: .head.ref, oid: .head.sha}"]));

export const rowBodyForOpening = ({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string =>
  run(["api", `repos/${repo}/issues/${number}`, "--jq", ".body"]);

export function branchHeadForOpening({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): string | null {
  try {
    const path = branch.split("/").map(encodeURIComponent).join("/");
    return run(["api", `repos/${repo}/branches/${path}`, "--jq", ".commit.sha"]).trim() || null;
  } catch (error) {
    if (NOT_FOUND.test(`${stderrOf(error)}${messageOf(error)}`)) return null;
    throw error;
  }
}

/** `gh`'s own failure line: its stderr when it said one, else the error's first line. */
const failureLine = (error: unknown): string => stderrOf(error).trim().split("\n")[0] || messageOf(error).split("\n")[0];

/** The two reads that can say who a pull request is authored as, in the order they are tried: the second runs only after the first fails, so a user token pays one call. */
const LOGIN_READS: readonly (readonly [string, readonly string[]])[] = [
  ["`gh api user`", ["api", "user", "--jq", ".login"]],
  ["the GraphQL `viewer` read", ["api", "graphql", "-f", "query={ viewer { login } }", "--jq", ".data.viewer.login"]],
];

export function authoringLoginOf({ run }: { run: RowsRun }): AuthoringLogin {
  const failures: string[] = [];
  for (const [name, args] of LOGIN_READS) {
    try {
      const login = run([...args]).trim();
      if (login) return { login };
      failures.push(`${name} answered no login`);
    } catch (error) {
      failures.push(`${name}: ${failureLine(error)}`);
    }
  }
  return { failures };
}
