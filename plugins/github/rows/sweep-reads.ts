// module: the GitHub reads behind the AUTO-ARM SWEEP (A11-160, step 5; moved from `src/auto-arm-sweep.ts`)
//
// The sweep lists a repository's open pull requests, picks the unarmed ones, and arms each unless something refuses. What it DECIDES is core's; what it ASKS OF GITHUB is here: the candidate list (one GraphQL
// read), the facts of one candidate (labels, author, body, head, the head's check-run count), whether a pull request merged or is armed (the two reads that explain a refused arm), whether its head is
// in a fork, and the list the outside home of arming uses. Each takes the `run` its caller hands it and THROWS when `gh` refuses or the answer is not the shape.
import type { OpenPullNode, RowsRun, SweepFacts } from "../../../src/plugins/contracts/code-host-rows.ts";
import { armedNodeOf, armedFromApi } from "./armed-state.ts";
import { outsideArmListArgs } from "./outside-arm-calls.ts";
import { pullRequestFieldsOf } from "./pull-request-fields.ts";

const CANDIDATES_QUERY = "query($o:String!,$r:String!,$b:String!,$limit:Int!){repository(owner:$o,name:$r)"
  + "{pullRequests(states:OPEN,baseRefName:$b,first:$limit)"
  + "{nodes{number isDraft merged autoMergeRequest{enabledAt} mergeQueueEntry{state}}}}}";

/** The branch the sweep arms against, and how many open pull requests it reads. */
const CANDIDATE_BASE = "main";
const CANDIDATE_LIMIT = 100;

/** The `gh` arguments that list `repo`'s open pull requests against `main` with what the armed rule reads, jq'd down to the nodes. */
export function openPullRequestsQueryArgs(repo: string): string[] {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${CANDIDATES_QUERY}`,
    "-f", `o=${owner}`, "-f", `r=${name}`, "-f", `b=${CANDIDATE_BASE}`, "-F", `limit=${CANDIDATE_LIMIT}`,
    "--jq", ".data.repository.pullRequests.nodes"];
}

/** The open pull requests of `repo` against `main` as nodes of the armed rule's fields. THROWS when the read is refused or the answer is not JSON. */
export function readOpenPullNodes({ repo, run }: { repo: string; run: RowsRun }): OpenPullNode[] {
  return JSON.parse(run(openPullRequestsQueryArgs(repo)));
}

/** Did pull request `number` merge? THROWS when the read is refused. */
export function isMergedPull({ repo, number, run }: { repo: string; number: string; run: RowsRun }): boolean {
  return JSON.parse(run(["api", `repos/${repo}/pulls/${number}`, "--jq", "{merged: .merged}"]))?.merged === true;
}

/** Is pull request `number` armed (auto-merging, queued or merged)? THROWS when the read is refused. */
export function isArmedPull({ repo, number, run }: { repo: string; number: string; run: RowsRun }): boolean {
  return armedFromApi(armedNodeOf({ number, repo, run }));
}

/** What the sweep reads of one candidate: five reads in a row, so a candidate that vanishes between them is one failure. THROWS when any is refused. */
export function readSweepFacts({ repo, number, run }: { repo: string; number: string; run: RowsRun }): SweepFacts {
  const view = (field: string, jq: string): string => run(["pr", "view", number, "--repo", repo, "--json", field, "-q", jq]).trim();
  const labels = JSON.parse(view("labels", "[.labels[].name]"));
  const author = view("author", ".author.login");
  const prBody = view("body", ".body");
  const head = view("headRefOid", ".headRefOid");
  const checkRunCount = Number(run(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", ".total_count"]).trim());
  return { labels, author, prBody, head, checkRunCount };
}

/** Is the head of pull request `number` in a fork? `null` when it could not be read: absence is not proof, and a caller treats it as a fork. */
export function isCrossRepositoryPull({ repo, number, run }: { repo: string; number: string; run: RowsRun }): boolean | null {
  const read = pullRequestFieldsOf({ repo, number: Number(number), fields: "isCrossRepository", run })?.isCrossRepository;
  return typeof read === "boolean" ? read : null;
}

/** The open pull requests of `repo` with the fields the outside home of arming decides on (`gh pr list` has no field for the armed state, which {@link readOpenPullNodes} reads). THROWS when the read is refused or is not JSON. */
export function readOutsideArmListed({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): unknown {
  return JSON.parse(run(outsideArmListArgs(repo, limit)));
}
