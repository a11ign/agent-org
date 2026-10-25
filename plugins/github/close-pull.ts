// module: closing a pull request with a comment (contract 1.23, A11-248) -- what the board does for a member of a stack that holds nothing of its own
//
// ONE CALL, as the plugin's default `gh` runner makes it: the workers' identity, as `updateBranch` acts, and no worker turn. `gh pr close` posts the comment and closes the pull request, and says it is closed already (exit 0) for one that is.
// It THROWS, in GitHub's own first line, for a call GitHub refuses and for an address that is no pull request, so a caller never reads a refusal as a close.
import type { Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";

/** The first line `gh` printed that says something, with the command `execFileSync`-style messages begin with left out. */
function firstLine(err: unknown): string {
  const { stderr } = err as { stderr?: unknown };
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String((err as Error)?.message ?? err);
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("Command failed:")) ?? "GitHub refused to close the pull request";
}

/** Closes the pull request at `url`, with `comment` posted on it. THROWS, in GitHub's own first line, for an address that is no pull request and for a close GitHub refuses. */
export function closePull(url: string, comment: string, gh: Gh): void {
  const pull = pullOf(url);
  if (pull === null) throw new Error(`${url} is not a GitHub pull request address`);
  try {
    gh(["pr", "close", String(pull.number), "--repo", `${pull.owner}/${pull.repo}`, "--comment", comment]);
  } catch (err) {
    throw new Error(firstLine(err));
  }
}
