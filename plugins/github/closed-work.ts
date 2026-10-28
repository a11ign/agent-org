// module: what a pull request closed without merging still held, as the code host reads it (contract 1.20, A11-249)
//
// Two reads: the pull request from its repository's snapshot (`pull-snapshot.ts`, A11-365: its state, its base and branch names, and its head COMMIT), then, through the plugin's `gh`, the compare of the base with that commit. It compares against the SHA and not the branch, so the read still
// works after someone deleted the branch. GitHub's compare answers the commits ahead of the base, a page of up to 100 at a time, and the files they change in its first page only, up to 300: a list that reaches the cap is read in part, and says so.
// Null is "could not ask": a refused `gh`, an answer that does not parse, a pull request that is not closed and a list of commits shorter than the compare's own total are all null, never "it held nothing".
import type { ClosedCommit, ClosedWork } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";
import type { PullSnapshots } from "./pull-snapshot.ts";

/** The most files GitHub's compare lists. A list this long may be cut short, so it is read in part. */
export const COMPARE_FILE_CAP = 300;

/** A pull request's address: its repository (`owner/name`) and number. */
const PULL_ADDRESS = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

/** The jq program run on each page of the compare: one line per commit, per file and one for the total, each `<letter> <JSON>`, so no commit message or path is ever split on a separator. */
const COMPARE_PAGE = '"T \\(.total_commits)", (.commits[]? | "C " + ({ sha: .sha, subject: (.commit.message | split("\\n")[0]) } | @json)), (.files[]? | "F " + (.filename | @json))';

type Pull = { number?: unknown; state?: unknown; baseRefName?: unknown; headRefName?: unknown; headRefOid?: unknown };

/** The compare's answer, line by line: its commits and files without repeats, and the total it counted. THROWS for a line that is none of the three kinds. */
function readCompare(text: string): { commits: ClosedCommit[]; files: string[]; total: number } {
  const commits = new Map<string, ClosedCommit>();
  const files = new Set<string>();
  let total = Number.NaN; // no total line is no reading: an empty answer must never read as "nothing is ahead"
  for (const line of text.split("\n").filter((each) => each !== "")) {
    const body = line.slice(2);
    if (line.startsWith("T ")) total = Number(body);
    else if (line.startsWith("C ")) {
      const commit: ClosedCommit = JSON.parse(body);
      commits.set(commit.sha, commit);
    } else if (line.startsWith("F ")) files.add(JSON.parse(body));
    else throw new Error(`a line of the compare is none of a total, a commit or a file: ${line}`);
  }
  return { commits: [...commits.values()], files: [...files], total };
}

/** Whether `value` is non-empty text. */
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The pull request as the snapshot holds it, when it is the closed pull request numbered `number` and names its base, its branch and its head commit. */
const isClosedPull = (pull: Pull, number: string): pull is Pull & Record<"baseRefName" | "headRefName" | "headRefOid", string> =>
  pull.state === "CLOSED" && pull.number === Number(number) && isText(pull.baseRefName) && isText(pull.headRefName) && isText(pull.headRefOid);

/**
 * WHAT THE CLOSED PULL REQUEST AT `url` STILL HELD, or `null` for "could not ask". A pull request that is open or merged is null, since what it holds is not final or is on its base. A pull request whose compare finds no commit ahead of its base is a
 * {@link ClosedWork} with none, which says "nothing is unique", and is never null. PURE over `gh`.
 */
export function readClosedWork(url: string, snapshots: PullSnapshots, gh: Gh): ClosedWork | null {
  try {
    const address = PULL_ADDRESS.exec(url);
    if (address === null) return null;
    const [, repository, number] = address;
    const pull: Pull = snapshots.pull(repository, Number(number))?.node ?? {};
    if (!isClosedPull(pull, number)) return null;
    const { baseRefName: base, headRefName: branch, headRefOid: head } = pull;
    const compared = readCompare(gh(["api", "--paginate", `repos/${repository}/compare/${encodeURI(base)}...${head}?per_page=100`, "--jq", COMPARE_PAGE]));
    // A page the host did not give leaves fewer commits than it counted: the list is a part, and a part is no reading of what the pull request held.
    if (!Number.isInteger(compared.total) || compared.commits.length !== compared.total) return null;
    return { number: Number(number), url, base, branch, head, commits: compared.commits, files: compared.files, filesComplete: compared.files.length < COMPARE_FILE_CAP };
  } catch (error) {
    void error; // no read is "cannot say", which the caller asks again on
    return null;
  }
}
