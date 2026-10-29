// module: the stale base of a stacked pull request (A11-106). A run stacked on a blocker's pull request keeps that pull request's branch as its base; when the blocker
// squash-merges and its branch is not deleted, GitHub does not retarget the stacked one, so it stays aimed at a dead branch. The sweep here moves such a pull request
// to the repository's default branch with `gh pr edit --base`, reads the base back, and never touches its head: no push, rebase or merge. A base with no merged
// pull request behind it is not moved, since its work may never have landed: it is said as needing a retarget by hand. A base no pull request ever came from (a
// long-lived branch) is nothing to say. Every call goes through the `gh` it is handed, which is the instance's, with the workers' account.
import type { AsyncGh, Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";

export type { AsyncGh, Gh };

/**
 * What a pull request's base is, as GitHub and the repository say: `current` for the default branch or one an open pull request builds on, `merged` for one
 * whose pull request merged, `gone` for a branch that is deleted with nothing merged on it, and `kept` for a branch that exists and no pull request came from.
 */
export type BaseKind = "current" | "merged" | "gone" | "kept";

/** Whether the branch has to be looked for to tell the kind of a base: not for the default branch, nor for a base some pull request is open or merged from. PURE. */
export const branchDecides = ({ base, defaultBranch, heads }: { base: string; defaultBranch: string; heads: readonly string[] }): boolean =>
  base !== defaultBranch && !heads.includes("OPEN") && !heads.includes("MERGED");

/** The kind of a base, from its name, the states of the pull requests whose head it is, and whether its branch still exists. PURE, `branchExists` only when {@link branchDecides} says it decides. */
export function baseKindOf({ base, defaultBranch, heads, branchExists }: { base: string; defaultBranch: string; heads: readonly string[]; branchExists: () => boolean }): BaseKind {
  if (base === defaultBranch || heads.includes("OPEN")) return "current";
  if (heads.includes("MERGED")) return "merged";
  return branchExists() ? "kept" : "gone";
}

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

// THE SWEEP IS WRITTEN ONCE, AS STEPS THAT ASK `gh` AND ARE TOLD ITS ANSWER (A11-282). A step is a generator: it yields the arguments of a `gh` call, receives what `gh` printed (or has the failure thrown into it, where
// it can catch it), and returns its result. `sweepRetargets` drives the steps with the synchronous runner, as it always has; `sweepRetargetsAsync` drives the same steps with the asynchronous one, so the instance's loop
// is not held while GitHub answers. One body of rules, two ways to ask.
type Step<T> = Generator<string[], T, string>;

/** Runs `steps` against a synchronous `gh`. */
function driven<T>(steps: Step<T>, gh: Gh): T {
  let next = steps.next();
  while (!next.done) {
    let printed: string;
    try {
      printed = gh(next.value);
    } catch (err) {
      next = steps.throw(err);
      continue;
    }
    next = steps.next(printed);
  }
  return next.value;
}

/** Runs `steps` against an asynchronous `gh`, so the process is not held still while it runs. */
async function drivenAsync<T>(steps: Step<T>, gh: AsyncGh): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    let printed: string;
    try {
      printed = await gh(next.value);
    } catch (err) {
      next = steps.throw(err);
      continue;
    }
    next = steps.next(printed);
  }
  return next.value;
}

/** The pull request's base and state as GitHub gives them. Throws when GitHub does not name a base. */
function* readPull(url: string): Step<{ base: string; state: string }> {
  const answer = JSON.parse(yield ["pr", "view", url, "--json", "baseRefName,state"]);
  if (typeof answer?.baseRefName !== "string") throw new Error("its base could not be read");
  return { base: answer.baseRefName, state: String(answer.state) };
}

/** The repository's default branch, which a stacked pull request is retargeted to. Throws when GitHub does not name one. */
function* defaultBranchOf(repo: string): Step<string> {
  const branch = (yield ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).trim();
  if (branch === "") throw new Error(`${repo} names no default branch`);
  return branch;
}

/** The states of the pull requests in `repo` whose head is `branch`, all of them. */
function* headStates(repo: string, branch: string): Step<string[]> {
  const pulls: { state: string }[] = JSON.parse(yield ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "state"]);
  return pulls.map(({ state }) => state);
}

/** Whether `branch` exists in `repo`: false on GitHub's 404, and an error for any other answer, so the pull request is asked again. */
function* branchExists(repo: string, branch: string): Step<boolean> {
  try {
    yield ["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--jq", ".name"];
    return true;
  } catch (err) {
    if (/HTTP 404/.test(String((err as Error)?.message ?? err))) return false;
    throw err;
  }
}

/** Moves the pull request's base to `branch`, and reads it back. @returns the reason it did not move, or undefined when it did. */
function* retarget(url: string, branch: string): Step<string | undefined> {
  try {
    yield ["pr", "edit", url, "--base", branch];
    const after = (yield* readPull(url)).base;
    return after === branch ? undefined : `GitHub still says the base is ${after}`;
  } catch (err) {
    return firstLine(err);
  }
}

export type RetargetSweep = Readonly<{
  urls: readonly string[];
  previous: Readonly<Record<string, string>>;
  /** The branches the run's blockers' pull requests are on: the only bases this run was stacked on, so the only ones a retarget may move. */
  stacked: ReadonlySet<string>;
  /** The default branch of each repository, read once for the sweep (by `owner/repo`). */
  defaults: Map<string, string>;
  log: (line: string) => void;
}>;

/** A sweep to run against a synchronous `gh`. */
export type SyncRetargetSweep = RetargetSweep & Readonly<{ gh: Gh }>;



/**
 * The steps of one sweep (see the note above): the note each open pull request in `urls` needs, by URL, after the retargets that are due are made. A merged base is moved to the default branch, and a base
 * whose branch is gone is said. A pull request whose base is not one of `stacked` is none of the board's to move, and is left alone. A pull request that cannot be
 * read keeps the note it had (`previous`), and is asked again on the next sweep. A pull request with no note needs nothing said. Its head is never touched.
 */
function* retargetSteps({ urls, previous, stacked, defaults, log }: RetargetSweep): Step<Record<string, string>> {
  const notes: Record<string, string> = {};
  for (const url of urls) {
    const pull = pullOf(url);
    if (pull === null) continue;
    const repo = `${pull.owner}/${pull.repo}`;
    try {
      const current = yield* readPull(url);
      if (current.state !== "OPEN" || !stacked.has(current.base)) continue;
      const defaultBranch = defaults.get(repo) ?? (yield* defaultBranchOf(repo));
      defaults.set(repo, defaultBranch);
      const heads = current.base === defaultBranch ? [] : yield* headStates(repo, current.base);
      const exists = branchDecides({ base: current.base, defaultBranch, heads }) ? yield* branchExists(repo, current.base) : false;
      const kind = baseKindOf({ base: current.base, defaultBranch, heads, branchExists: () => exists });
      if (kind === "current" || kind === "kept") continue;
      if (kind === "gone") {
        notes[url] = `Needs retarget: ${url} still targets ${current.base}, whose branch is gone: retarget it by hand`;
        continue;
      }
      const failure = yield* retarget(url, defaultBranch);
      if (failure === undefined) {
        log(`${url}: its base ${current.base} merged, so it now targets ${defaultBranch}`);
        continue;
      }
      notes[url] = `Needs retarget: ${url} still targets ${current.base}, whose pull request merged; retarget failed, and agent-org tries again: ${failure}`;
      log(`${url}: could not be retargeted from ${current.base} to ${defaultBranch}: ${failure}`);
    } catch (err) {
      const kept = previous[url];
      if (kept !== undefined) notes[url] = kept;
      log(`${url}: its base could not be checked, so the next sweep asks again (${firstLine(err)})`);
    }
  }
  return notes;
}

/** The sweep against a synchronous `gh`: the note each open pull request in `urls` needs (see {@link retargetSteps}). */
export function sweepRetargets({ gh, ...sweep }: SyncRetargetSweep): Record<string, string> {
  return driven(retargetSteps(sweep), gh);
}

/** {@link sweepRetargets} without holding the process still (A11-282): the same rules, asked of GitHub through an asynchronous `gh`. */
export function sweepRetargetsAsync(sweep: RetargetSweep, gh: AsyncGh): Promise<Record<string, string>> {
  return drivenAsync(retargetSteps(sweep), gh);
}
