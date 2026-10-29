// module: bringing a pull request's branch up to date with its base (contract 1.15, A11-215) -- what the board does for a pull request it held as red on main once main is green again
//
// ONE CALL, as the plugin's default `gh` runner makes it: the workers' identity, the same one `rerunFailedChecks` acts as, and no worker turn. `expected_head_sha` makes GitHub refuse the update when the branch moved since the board read its head,
// so a worker's push is never raced. GitHub answers 202 when it has started the update, and a 422 whose message tells a conflict from a branch that has nothing to take from its base; everything else is a refusal in GitHub's own first line.
import type { UpdateBranchResult } from "../../src/plugins/contracts/code-host.ts";
import type { AsyncGh, Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";

/** What GitHub's 422 says when the branch and its base conflict. */
const CONFLICT = /merge conflict/i;
/** What GitHub's 422 says when the branch already has everything its base has. */
const UP_TO_DATE = /no new commits on the base branch|already up.to.date/i;

/** What `gh` printed when it failed: its stderr and stdout, which hold GitHub's message and, for `gh api`, the body it answered. */
const printedBy = (err: unknown): string => {
  const { stderr, stdout } = err as { stderr?: unknown; stdout?: unknown };
  const printed = [stderr, stdout].filter((text): text is string => typeof text === "string" && text.trim() !== "").join("\n");
  return printed === "" ? String((err as Error)?.message ?? err) : printed;
};

/** The first line of a message that says something, with the command `execFileSync`-style messages begin with left out. */
const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("Command failed:")) ?? "GitHub refused the update";

/** What the board does with a refusal `err` of the update: GitHub's 422 told a conflict from a branch that has nothing to take, and anything else is a refusal in its first line. */
function refusalOf(err: unknown): UpdateBranchResult {
  const printed = printedBy(err);
  if (CONFLICT.test(printed)) return { kind: "conflict" };
  if (UP_TO_DATE.test(printed)) return { kind: "up-to-date" };
  return { kind: "refused", reason: firstLine(printed) };
}

/** The `gh` arguments that update the branch of the pull request `pull`, provided its head is still `expectedHead`. */
const updateArgs = (pull: { owner: string; repo: string; number: number }, expectedHead: string): string[] =>
  ["api", "-X", "PUT", `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}/update-branch`, "-f", `expected_head_sha=${expectedHead}`];

/** What is answered for an address that is no pull request. */
const notAPull = (url: string): UpdateBranchResult => ({ kind: "refused", reason: `${url} is not a GitHub pull request address` });

/**
 * Brings the branch of the pull request at `url` up to date with its base, provided its head is still `expectedHead`. NEVER THROWS: an address that is no pull request, a head that moved, and any other
 * refusal are `refused` with GitHub's first line; a merge conflict is `conflict`, and the branch is left as it was; a branch that already has its base is `up-to-date`.
 */
export function updateBranch(url: string, expectedHead: string, gh: Gh): UpdateBranchResult {
  const pull = pullOf(url);
  if (pull === null) return notAPull(url);
  try {
    gh(updateArgs(pull, expectedHead));
    return { kind: "updated" };
  } catch (err) {
    return refusalOf(err);
  }
}

/** {@link updateBranch} without holding the process still (A11-395). */
export async function updateBranchAsync(url: string, expectedHead: string, gh: AsyncGh): Promise<UpdateBranchResult> {
  const pull = pullOf(url);
  if (pull === null) return notAPull(url);
  try {
    await gh(updateArgs(pull, expectedHead));
    return { kind: "updated" };
  } catch (err) {
    return refusalOf(err);
  }
}
