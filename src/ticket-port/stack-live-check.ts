// module: the live check of the stacked-pull-request retarget, run on GitHub before merge (A11-106). It proves the whole chain on a real repository without touching
// its default branch: a scratch branch stands in for the default branch, base pull request A is opened on it, stacked pull request B on A's branch, A is merged
// (squash, its branch kept, as the stale-base case needs), and the retarget sweep (`sweepRetargets`) runs with the scratch branch as the default. B's base must
// read back as the scratch branch, and B's head must not move. Every branch and pull request it makes is removed afterwards, even when a step fails.
// PURE over the `gh` it is handed: this file names no GitHub CLI command and spawns nothing (the port's rule). The command that runs it hands in the instance's
// runner, and the workers' account is what it acts as.
import { sweepRetargets, type Gh } from "./stack-retarget.ts";

export type LiveCheckNames = Readonly<{ scratch: string; base: string; stacked: string }>;

/** The three branches a run makes, under one prefix, so nothing else is left behind by a run that stops halfway. PURE. */
export function liveCheckNames(runId: string): LiveCheckNames {
  const root = `agent-org-live-check/${runId}`;
  return { scratch: `${root}/scratch`, base: `${root}/base`, stacked: `${root}/stacked` };
}

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

/** A pull request's state and branches as GitHub gives them. */
function viewOf(url: string, gh: Gh): { state: string; base: string; head: string; headOid: string } {
  const answer = JSON.parse(gh(["pr", "view", url, "--json", "state,baseRefName,headRefName,headRefOid"]));
  return { state: String(answer.state), base: String(answer.baseRefName), head: String(answer.headRefName), headOid: String(answer.headRefOid) };
}

/** The commit a branch of `repo` points at. Throws when GitHub has no such branch, which is how a deleted branch shows. */
function shaOf(repo: string, branch: string, gh: Gh): string {
  return gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]).trim();
}

/** Opens a branch of `repo` at `sha`. The name is recorded by the caller first, so a create that half-succeeds is still cleaned up. */
function createBranch(repo: string, branch: string, sha: string, gh: Gh): void {
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`]);
}

/** Adds one file to `branch`, as one commit on it. */
function commitTo(repo: string, branch: string, gh: Gh): void {
  const content = Buffer.from(`live check of the stacked retarget: ${branch}\n`).toString("base64");
  gh(["api", "-X", "PUT", `repos/${repo}/contents/${branch}.txt`, "-f", `message=live check commit on ${branch}`, "-f", `content=${content}`, "-f", `branch=${branch}`]);
}

/** Opens a pull request of `head` into `base` in `repo`, and returns its address. */
function openPull(repo: string, base: string, head: string, gh: Gh): string {
  return gh(["pr", "create", "--repo", repo, "--base", base, "--head", head, "--title", `live check: ${head}`, "--body", "Live check of the stacked retarget. Closed by the check; not for merge."]).trim().split("\n").pop() ?? "";
}

/**
 * The chain itself: the scratch branch, A on it, B stacked on A, A merged, the sweep, and B's base and head read back. Returns whether every fact held. The
 * branches and pull requests it opens are recorded in `branches` and `pulls` as it opens them, for the caller's cleanup.
 */
function chain({ repo, names, gh, log, branches, pulls }: { repo: string; names: LiveCheckNames; gh: Gh; log: (line: string) => void; branches: string[]; pulls: string[] }): boolean {
  const defaultBranch = gh(["api", `repos/${repo}`, "--jq", ".default_branch"]).trim();
  const mainSha = shaOf(repo, defaultBranch, gh);
  branches.push(names.scratch);
  createBranch(repo, names.scratch, mainSha, gh);
  branches.push(names.base);
  createBranch(repo, names.base, mainSha, gh);
  commitTo(repo, names.base, gh);
  const baseUrl = openPull(repo, names.scratch, names.base, gh);
  pulls.push(baseUrl);
  branches.push(names.stacked);
  createBranch(repo, names.stacked, shaOf(repo, names.base, gh), gh);
  commitTo(repo, names.stacked, gh);
  const stackedUrl = openPull(repo, names.base, names.stacked, gh);
  pulls.push(stackedUrl);
  log(`opened ${baseUrl} (base ${names.scratch}) and ${stackedUrl} (base ${names.base})`);

  gh(["pr", "merge", baseUrl, "--repo", repo, "--squash"]);
  if (viewOf(baseUrl, gh).state !== "MERGED") throw new Error(`${baseUrl} did not merge`);
  // The stale-base case needs A's branch to survive its merge. A repository that deletes merged branches cannot show it, so that is said, not passed over.
  try {
    shaOf(repo, names.base, gh);
  } catch {
    throw new Error(`${names.base} was deleted when ${baseUrl} merged: the repository deletes merged branches, so the stale base does not occur here`);
  }
  log(`merged ${baseUrl}; its branch ${names.base} is kept`);

  const before = viewOf(stackedUrl, gh);
  if (before.base !== names.base) throw new Error(`${stackedUrl} starts on ${before.base}, not on ${names.base}`);
  const notes = sweepRetargets({ urls: [stackedUrl], previous: {}, stacked: new Set([names.base]), defaults: new Map([[repo, names.scratch]]), gh, log });
  const after = viewOf(stackedUrl, gh);
  log(`${stackedUrl}: base ${before.base} -> ${after.base}; head ${before.headOid.slice(0, 7)} -> ${after.headOid.slice(0, 7)}`);
  const noteSaid = Object.keys(notes).length > 0;
  if (noteSaid) log(`the sweep said something for ${stackedUrl}: ${Object.values(notes).join("; ")}`);
  return after.base === names.scratch && !noteSaid && after.headOid === before.headOid;
}

/**
 * Removes what the run opened: closes any pull request still open, and deletes each branch (a branch GitHub already deleted is not an error). Returns whether
 * every removal worked; one that did not is said, and makes the check fail, so nothing is left behind unseen.
 */
function cleanUp({ repo, branches, pulls, gh, log }: { repo: string; branches: string[]; pulls: string[]; gh: Gh; log: (line: string) => void }): boolean {
  let clean = true;
  for (const url of pulls) {
    try {
      if (viewOf(url, gh).state === "OPEN") gh(["pr", "close", url]);
    } catch (err) {
      clean = false;
      log(`cleanup: could not close ${url}: ${firstLine(err)}`);
    }
  }
  for (const branch of branches) {
    try {
      gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    } catch (err) {
      if (!/HTTP 404|Reference does not exist|Not Found/.test(String((err as Error)?.message ?? err))) {
        clean = false;
        log(`cleanup: could not delete ${branch}: ${firstLine(err)}`);
      }
    }
  }
  return clean;
}

/**
 * Runs the live check in `repo` as `runId`'s branches. Returns true only when the chain held and every branch and pull request was removed. Says each step, and
 * says the first thing that failed.
 */
export function runLiveCheck({ repo, runId, gh, log }: { repo: string; runId: string; gh: Gh; log: (line: string) => void }): boolean {
  const names = liveCheckNames(runId);
  const branches: string[] = [];
  const pulls: string[] = [];
  let held = false;
  try {
    held = chain({ repo, names, gh, log, branches, pulls });
    log(held ? "PASS: the stacked pull request's base is the scratch branch after its base merged, and its head did not move" : "FAIL: the retarget did not leave the stacked pull request on the scratch branch with its head unmoved");
  } catch (err) {
    log(`FAIL: ${firstLine(err)}`);
  }
  const clean = cleanUp({ repo, branches, pulls, gh, log });
  log(clean ? `cleaned up ${branches.length} branches and ${pulls.length} pull requests` : "FAIL: cleanup was incomplete; see the lines above");
  return held && clean;
}
