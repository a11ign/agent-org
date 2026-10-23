// a11ign#5109: what the merge guard's Tests-first rule reads off a pull request and the rows it closes -- the test files the rows name, the files of the
// PR's first commit, what changed since, and who approved a change to them -- through an injected `run` (`gh`, as the caller hands it in). Like
// `approval-reads.ts`, this file names no `gh` and spawns nothing: `index.test.ts` holds this folder to that, and the spawn stays with the
// guard, which owns the runner. A read the runner refuses THROWS, and the caller turns that into "could not ask".

import type { RowsRun as Run, TestsFirstFacts } from "../../../src/plugins/contracts/code-host-rows.ts";

function jsonArrays(output: string): string[] {
  return output.split("\n").filter(Boolean).flatMap((line) => JSON.parse(line) as string[]);
}

/** Files that differ between `base` and `head`, one array per page of the compare. */
function filesBetween({ repo, base, head, run }: { repo: string; base: string; head: string; run: Run; }): string[] {
  if (base === head) return [];
  return jsonArrays(run(["api", `repos/${repo}/compare/${base}...${head}`, "--paginate", "--jq", "[.files[]?.filename]"]));
}

/** Who approved WITH the line, not being the author, and with nothing named moved since -- what they read is what will merge. */
function approversOf({ repo, number, head, author, paths, isApproval, run }: {
  repo: string; number: number; head: string; author: string | null; paths: string[]; isApproval: (body: string) => boolean; run: Run;
}): string[] {
  const reviews: { reviewer: string; state: string; body: string | null; commitId: string; }[] =
    run(["api", `repos/${repo}/pulls/${number}/reviews`, "--paginate", "--jq",
      ".[] | {reviewer: .user.login, state, body, commitId: .commit_id}"])
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const approvers = reviews.filter((review) => review.state === "APPROVED" && review.reviewer !== author
    && isApproval(review.body ?? ""));
  const read = approvers.filter((review) =>
    !filesBetween({ repo, base: review.commitId, head, run }).some((file) => paths.includes(file)));
  return [...new Set(read.map((review) => review.reviewer))];
}

/**
 * THE FACTS for PR `number` of `repo` closing `rows` (each read in its own repository), or `undefined` when no row names a test file -- never an
 * empty `paths`. `pathsOf` is how a row body names its tests and `isApproval` is how a review body carries the line: both are the guard's, handed
 * in so this file imports nothing. Throws when a read is refused or an answer does not parse.
 */
export function testsFirstReadsOf({ repo, number, head, author, rows, pathsOf, isApproval }: {
  repo: string; number: number; head: string; author: string | null; rows: { repo: string; number: number; }[];
  pathsOf: (rowBody: string) => string[]; isApproval: (reviewBody: string) => boolean;
}, run: Run): TestsFirstFacts | undefined {
  const paths = [...new Set(rows.flatMap((row) =>
    pathsOf(JSON.parse(run(["api", `repos/${row.repo}/issues/${row.number}`])).body ?? "")))];
  if (paths.length === 0) return undefined;
  const first = run(["api", `repos/${repo}/pulls/${number}/commits?per_page=1`, "--jq", ".[0].sha"]).trim();
  if (!first) throw new Error("the PR has no first commit to read");
  const firstCommitFiles = jsonArrays(run(["api", `repos/${repo}/commits/${first}`, "--paginate", "--jq", "[.files[]?.filename]"]));
  const changedSinceFirst = filesBetween({ repo, base: first, head, run });
  const approvedBy = approversOf({ repo, number, head, author, paths, isApproval, run });
  return { paths, firstCommitFiles, changedSinceFirst, approvedBy };
}
