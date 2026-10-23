// module: the GitHub plugin's rows for the claim's clock, the provenance audit, the reachability check, the duplicate-row check and the label strip (A11-160, step 7; moved from `src/claim-stall/`, `src/claim-provenance.ts`,
// `src/row-reachability.ts`, `src/duplicate-row.ts` and `src/claim-label-strip.ts`)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal (a `null` clock, "no PR", "refusing to report")
// stays in core. `run` is the caller's executor where it has one; absent, the code host runs `gh` itself.
import type { CodeHostRows, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { withOwnRun } from "./with-own-run.ts";
import type { BranchedPullState, LabelEventRead, PullState, RowFacts } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

/** The operations of this group. */
export type MiscRows = Pick<CodeHostRows, "labelEventsOf" | "removeLabelsFromRow" | "closingTimelineTextOf" | "closedRowListingTextOf" | "labelEventLogTextOf" | "pullStatesOf" | "pullStatesOfBranchIn" | "rowFactsIn"
  | "openRestListingOf" | "rowBodyIn">;

/** GitHub's largest page: a page that comes back shorter than this is the last one. */
const REST_PAGE_SIZE = 100;
/** The most pages one REST listing reads: past it the listing throws, so a caller reads it as INCONCLUSIVE rather than as a list that stopped short. */
const REST_MAX_PAGES = 100;

/** The projection of a row's events: `labeled` and `unlabeled` only, three fields each. */
const ROW_EVENTS_JQ = '.[] | select(.event == "labeled" or .event == "unlabeled") | {event: .event, label: .label.name, at: .created_at}';

/**
 * ONE COMPACT OBJECT PER LINE, not one array: `--slurp` and `--jq` cannot be combined, so `--paginate` concatenates each page's jq output and a per-page ARRAY would produce 57 arrays back to back, which is not a JSON
 * document. Every event embeds the whole issue, body included, so `--jq` runs inside `gh` and what crosses the pipe is four fields per label event. The `select` is a PROJECTION, not a filter on the population.
 */
const REPO_EVENTS_JQ = '.[] | select(.event == "labeled" or .event == "unlabeled")'
  + ' | { number: .issue.number, event: .event, label: .label.name, at: .created_at }';

/** The GraphQL query that reads the closing events of row `number`, last 30, with the pull request behind each. */
function closingTimelineQuery(repo: string, number: number): string {
  const [owner, name] = repo.split("/");
  return `query{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){`
    + "timelineItems(last:30,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{"
    + "... on PullRequest{number headRefName merged createdAt labels(first:50){nodes{name}}}}}}}}}}";
}

export function labelEventsOf({ repo, row, run }: { repo: string; row: number; run: RowsRun }): LabelEventRead[] {
  const out = run(["api", "--paginate", `repos/${repo}/issues/${row}/events`, "--jq", ROW_EVENTS_JQ]);
  return out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as LabelEventRead);
}

export function removeLabelsFromRow({ repo, number, labels, run }: { repo: string; number: number; labels: readonly string[]; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--repo", repo, ...labels.flatMap((label) => ["--remove-label", label])]);
}

export function closingTimelineTextOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string {
  return run(["api", "graphql", "-f", `query=${closingTimelineQuery(repo, number)}`]);
}

export function closedRowListingTextOf({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): string {
  // `stateReason` ASKED FOR, or a NOT_PLANNED row can never be seen (#848): the first version filtered on a field this listing never requested.
  return run(["issue", "list", "--repo", repo, "--state", "closed", "--limit", String(limit), "--json", "number,title,closedAt,stateReason"]);
}

export function labelEventLogTextOf({ repo, run }: { repo: string; run: RowsRun }): string {
  return run(["api", "--paginate", `repos/${repo}/issues/events?per_page=100`, "--jq", REPO_EVENTS_JQ]);
}

export function pullStatesOf({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): BranchedPullState[] {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(limit), "--json", "number,state,headRefName"]));
}

export function pullStatesOfBranchIn({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): PullState[] {
  const found = JSON.parse(run(["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number,state"]));
  return Array.isArray(found) ? found : [];
}

export function rowFactsIn({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RowFacts {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "body,labels,state,closedAt"]));
}

export function openRestListingOf({ repo, kind, run }: { repo: string; kind: "issues" | "pulls"; run: RowsRun }): object[] {
  const rows: object[] = [];
  for (let page = 1; page <= REST_MAX_PAGES; page++) {
    const batch: unknown = JSON.parse(run(["api", `repos/${repo}/${kind}?state=open&per_page=${REST_PAGE_SIZE}&page=${page}`]));
    if (!Array.isArray(batch)) throw new Error(`the open ${kind} of ${repo} did not come back as a list`);
    rows.push(...(batch as object[]).filter((row) => kind === "pulls" || !("pull_request" in row)));
    if (batch.length < REST_PAGE_SIZE) return rows;
  }
  throw new Error(`the open ${kind} of ${repo} run past ${REST_MAX_PAGES} pages`);
}

export function rowBodyIn({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string {
  return String(JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "body"]))?.body ?? "");
}

/** The operations of this group, each running on the `run` its caller hands it, or on `own` (the plugin's `gh`) when it hands none. */
export function miscRowsOf(own: RowsRun): MiscRows {
  return {
    labelEventsOf: withOwnRun(labelEventsOf, own), removeLabelsFromRow: withOwnRun(removeLabelsFromRow, own), closingTimelineTextOf: withOwnRun(closingTimelineTextOf, own), closedRowListingTextOf: withOwnRun(closedRowListingTextOf, own),
    labelEventLogTextOf: withOwnRun(labelEventLogTextOf, own), pullStatesOf: withOwnRun(pullStatesOf, own), pullStatesOfBranchIn: withOwnRun(pullStatesOfBranchIn, own), rowFactsIn: withOwnRun(rowFactsIn, own), openRestListingOf: withOwnRun(openRestListingOf, own),
    rowBodyIn: withOwnRun(rowBodyIn, own),
  };
}
