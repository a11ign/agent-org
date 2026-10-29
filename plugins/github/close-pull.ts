// module: closing a pull request with a comment (contract 1.23, A11-248) -- what the board does for a member of a stack that holds nothing of its own
//
// TWO CALLS, as the plugin's default `gh` runner makes them: the workers' identity, as `updateBranch` acts, and no worker turn. The pull request is closed FIRST and the comment posted after, because `gh pr close --comment` posts the comment before it closes, and a close GitHub
// refuses (which the board tries again on its next sweep) would leave a "closed by agent-org" comment on a pull request that is open, once for each try. A comment that cannot be posted after the close does not undo it, and is not an error.
// It THROWS, in GitHub's own first line, for a close GitHub refuses and for an address that is no pull request, so a caller never reads a refusal as a close.
import type { AsyncGh, Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";

/** The first line `gh` printed that says something, with the command `execFileSync`-style messages begin with left out. */
function firstLine(err: unknown): string {
  const { stderr } = err as { stderr?: unknown };
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String((err as Error)?.message ?? err);
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("Command failed:")) ?? "GitHub refused to close the pull request";
}

/** The pull request at `url`. THROWS for an address that is no pull request. */
function pullAt(url: string): { owner: string; repo: string; number: number } {
  const pull = pullOf(url);
  if (pull === null) throw new Error(`${url} is not a GitHub pull request address`);
  return pull;
}

/** The `gh` arguments that close pull request `number` of `repo`, and that post `comment` on it. */
const closeArgs = (repo: string, number: number): string[] => ["api", "-X", "PATCH", `repos/${repo}/pulls/${number}`, "-f", "state=closed"];
const commentArgs = (repo: string, number: number, comment: string): string[] => ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${comment}`];

/** Closes the pull request at `url`, then posts `comment` on it. THROWS, in GitHub's own first line, for an address that is no pull request and for a close GitHub refuses. */
export function closePull(url: string, comment: string, gh: Gh): void {
  const pull = pullAt(url);
  const repo = `${pull.owner}/${pull.repo}`;
  try {
    gh(closeArgs(repo, pull.number));
  } catch (err) {
    throw new Error(firstLine(err));
  }
  postComment(repo, pull.number, comment, gh);
}

/** {@link closePull} without holding the process still (A11-395): the close first, and the comment after it. */
export async function closePullAsync(url: string, comment: string, gh: AsyncGh): Promise<void> {
  const pull = pullAt(url);
  const repo = `${pull.owner}/${pull.repo}`;
  try {
    await gh(closeArgs(repo, pull.number));
  } catch (err) {
    throw new Error(firstLine(err));
  }
  try {
    await gh(commentArgs(repo, pull.number, comment));
  } catch (err) {
    void err; // closed without its comment
  }
}

/** Posts `comment` on the pull request at `url` (contract 1.26, A11-290), as the workers' account. THROWS, in GitHub's own first line, for an address that is no pull request and for a comment GitHub refuses. */
export function commentOnPull(url: string, comment: string, gh: Gh): void {
  const pull = pullAt(url);
  try {
    gh(commentArgs(`${pull.owner}/${pull.repo}`, pull.number, comment));
  } catch (err) {
    throw new Error(firstLine(err));
  }
}

/** {@link commentOnPull} without holding the process still (A11-395). */
export async function commentOnPullAsync(url: string, comment: string, gh: AsyncGh): Promise<void> {
  const pull = pullAt(url);
  try {
    await gh(commentArgs(`${pull.owner}/${pull.repo}`, pull.number, comment));
  } catch (err) {
    throw new Error(firstLine(err));
  }
}

/** Posts `comment` on the pull request that was just closed. A refusal is left unsaid: the pull request is closed, which is what was asked. */
function postComment(repo: string, number: number, comment: string, gh: Gh): void {
  try {
    gh(commentArgs(repo, number, comment));
  } catch (err) {
    void err; // closed without its comment
  }
}
