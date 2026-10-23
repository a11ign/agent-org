// module: the GitHub plugin's rows for the board's reads and posts (A11-160, step 8; moved from `src/board-data.ts`, `board-discussion.ts`, `board-document.ts`, `board-report.ts`, `board-schedule-liveness.ts`,
// `board-snapshot.ts`, `board-snapshot-scope.ts`, `board-summary-check.ts` and `board-truth-audit.ts`)
//
// The board decides what a row, a milestone, a run or an edition means and what to do when a read is refused; the command or the query that asks GitHub is here, with the GraphQL documents the board has always sent. Each
// takes the `run` its caller hands it (the board's own: behind the leak guard and the buffer the board has always had), builds the argument list the caller built, and THROWS when the read is refused or its answer is not JSON
// where JSON is read.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

// --- the issues, paged to exhaustion (board-data) ---------------------------------------------------------------------------------------

const ISSUES_QUERY = "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){"
  + "issues(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{number title state createdAt closedAt url "
  + "labels(first:100){totalCount nodes{name}} milestone{number title description dueOn}}}}}";

/** One page of the repository's issues, from `after` (a cursor) or the first. THROWS when the read is refused or is not JSON; the page's shape is the caller's to check. */
export function issuePageOf({ repo, after, run }: { repo: string; after: string | null; run: RowsRun }): any {
  const [owner, name] = repo.split("/");
  const args = ["api", "graphql", "-f", `query=${ISSUES_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
  if (after) args.push("-f", `after=${after}`);
  return JSON.parse(run(args));
}

/** Every milestone of `repo`, open and closed. THROWS when the read is refused or is not JSON. */
export function allMilestonesOf({ repo, run }: { repo: string; run: RowsRun }): any[] {
  return JSON.parse(run(["api", `repos/${repo}/milestones?state=all`]));
}

// --- the editions as Discussions (board-discussion) ------------------------------------------------------------------------------------

const CATEGORIES = "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id "
  + "discussionCategories(first:50){ nodes{ id slug } } } }";
const EDITIONS = "query($owner:String!,$name:String!,$categoryId:ID!){ repository(owner:$owner,name:$name){ "
  + "discussions(first:100,categoryId:$categoryId,orderBy:{field:CREATED_AT,direction:DESC}){ "
  + "nodes{ id title url } } } }";
const CREATE = "mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){ createDiscussion("
  + "input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){ discussion{ url } } }";
const UPDATE = "mutation($discussionId:ID!,$body:String!){ "
  + "updateDiscussion(input:{discussionId:$discussionId,body:$body}){ discussion{ url } } }";

/** One GraphQL document and its variables, the response's `data`. THROWS on a refusal: a GraphQL error exits non-zero as well as a refused request, so a failed read is never an empty list of editions. */
function graphql(run: RowsRun, query: string, vars: Record<string, string>): any {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push("-f", `${key}=${value}`);
  return JSON.parse(run(args)).data;
}

/** The repository and its Discussion categories (id and slug of each). */
export function discussionCategoriesOf({ owner, name, run }: { owner: string; name: string; run: RowsRun }): any {
  return graphql(run, CATEGORIES, { owner, name });
}

/** The newest hundred Discussions of a category (id, title, url of each). */
export function discussionEditionsOf({ owner, name, categoryId, run }: { owner: string; name: string; categoryId: string; run: RowsRun }): any {
  return graphql(run, EDITIONS, { owner, name, categoryId });
}

/** Creates a Discussion; answers the response's `data` (`createDiscussion.discussion.url`). */
export function createDiscussion({ repositoryId, categoryId, title, body, run }: { repositoryId: string; categoryId: string; title: string; body: string; run: RowsRun }): any {
  return graphql(run, CREATE, { repositoryId, categoryId, title, body });
}

/** Replaces the body of a Discussion; answers the response's `data`. */
export function updateDiscussion({ discussionId, body, run }: { discussionId: string; body: string; run: RowsRun }): any {
  return graphql(run, UPDATE, { discussionId, body });
}

// --- the PDF as a draft release (board-document) --------------------------------------------------------------------------------------

/** Whether the tag has a release, and if so whether it is a draft; `null` when there is none, or it cannot be read. */
export function draftReleaseOf({ repo, tag, run }: { repo: string; tag: string; run: RowsRun }): { isDraft: boolean } | null {
  try {
    return JSON.parse(run(["release", "view", tag, "--repo", repo, "--json", "isDraft"]));
  } catch {
    return null;
  }
}

/** Creates a DRAFT release for `tag` with `file` attached. */
export function createDraftRelease({ repo, tag, file, title, notes, run }: { repo: string; tag: string; file: string; title: string; notes: string; run: RowsRun }): void {
  run(["release", "create", tag, file, "--repo", repo, "--draft", "--title", title, "--notes", notes]);
}

/** Uploads `file` to the release of `tag`, replacing an asset of the same name. */
export function uploadReleaseAsset({ repo, tag, file, run }: { repo: string; tag: string; file: string; run: RowsRun }): void {
  run(["release", "upload", tag, file, "--repo", repo, "--clobber"]);
}

// --- the rows listed, the window of rows touched, the editions posted (board-report, board-summary-check, board-truth-audit) ---------------

/** The newest `limit` rows of `repo` in `state` with the JSON fields `fields` names. THROWS when the read is refused or is not JSON. */
export function rowsListedIn({ repo, state, limit, fields, run }: { repo: string; state: "open" | "closed"; limit: number; fields: string; run: RowsRun }): any[] {
  return JSON.parse(run(["issue", "list", "--repo", repo, "--state", state, "--limit", String(limit), "--json", fields]));
}

/** The newest `limit` pull requests of `repo` in `state` with the JSON fields `fields` names. THROWS when the read is refused or is not JSON. */
export function pullsListedIn({ repo, state, limit, fields, run }: { repo: string; state: "open" | "merged"; limit: number; fields: string; run: RowsRun }): any[] {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", state, "--limit", String(limit), "--json", fields]));
}

/**
 * Every issue of `repo` updated since `since`, one JSON object per line, pull requests (which carry a `pull_request` key) left out: paged REST, not capped. Everything filed or closed in the window was UPDATED in the
 * window, so this holds every such row.
 */
export function windowRowsTextOf({ repo, since, run }: { repo: string; since: string; run: RowsRun }): string {
  return run(["api", "--paginate", `repos/${repo}/issues?state=all&since=${since}&per_page=100`, "--jq", ".[] | select(.pull_request == null) | { number, state: (.state | ascii_upcase), createdAt: .created_at, closedAt: .closed_at, labels: [.labels[] | { name }] }"]);
}

/** How many comments of row `issue` since `since` open with the title `title`, summed over the pages. THROWS when the read is refused. */
export function editionCommentCountOf({ repo, issue, since, title, run }: { repo: string; issue: string; since: string; title: string; run: RowsRun }): number {
  const counts = run(["api", "--paginate", `repos/${repo}/issues/${issue}/comments?since=${since}&per_page=100`, "--jq", `[.[] | select(.body | startswith(${JSON.stringify(title)}))] | length`]);
  return counts.split("\n").reduce((sum, count) => sum + (Number(count) > 0 ? Number(count) : 0), 0);
}

/** The bodies of the comments on row `number` of `repo`. THROWS when the read is refused or is not JSON. */
export function commentBodiesOfIssue({ repo, number, run }: { repo: string; number: string | number; run: RowsRun }): string[] {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "comments"])).comments.map((comment: { body: string }) => comment.body);
}

// --- the schedule's liveness (board-schedule-liveness) ------------------------------------------------------------------------------

/** The newest `limit` runs of a workflow with the JSON fields `fields` names. THROWS when the read is refused or is not JSON. */
export function workflowRunListOf({ repo, workflow, fields, limit, run }: { repo: string; workflow: string; fields: string; limit: number; run: RowsRun }): any[] {
  return JSON.parse(run(["run", "list", "--repo", repo, "--workflow", workflow, "--json", fields, "--limit", String(limit)]));
}

/** When a workflow was first registered, or `null` when GitHub gave none. THROWS when the read is refused or is not JSON. */
export function workflowCreatedAtOf({ repo, workflow, run }: { repo: string; workflow: string; run: RowsRun }): string | null {
  return JSON.parse(run(["api", `repos/${repo}/actions/workflows/${workflow}`])).created_at ?? null;
}

// --- the board's items (board-snapshot, board-snapshot-scope) -----------------------------------------------------------------------------

const ITEMS_QUERY = `
  query($owner: String!, $number: Int!, $cursor: String) {
    organization(login: $owner) {
      projectV2(number: $number) {
        # #1996: THE LIVE VOCABULARY, IN THE QUERY THAT WAS ALREADY BEING SENT -- so the drift check
        # below costs no extra call and cannot be skipped for budget. Nothing read the option list until
        # this row, which is how the board came to offer no "Done" at all while the code wrote it on
        # every close.
        #
        # CHECKED AGAINST #747's WARNING rather than assumed past it: that header is about a CONNECTION
        # nested inside items(first: 100) being narrowed to a shared budget without saying so. This is a
        # single node with a plain list, not a connection, and it sits beside items rather than inside
        # it -- but the empirical check is the one that counts, and it is free: readyRowsMissingStatus
        # refuses the whole snapshot if any open ready row comes back without a Status, and a full run
        # against the live board after this landed did not refuse.
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { options { name } }
        }
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content { ... on Issue { number title state } }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * #1275: ONE ISSUE'S ITEM ON THIS PROJECT, AND THE PROJECT ITSELF, IN ONE REQUEST.
 *
 * `user.projectV2` is asked for although only its presence is read. CI's token cannot read the user-owned
 * Project (#546), and the close path classifies that refusal by GraphQL's own
 * `NOT_FOUND (organization.projectV2): Could not resolve to a ProjectV2 with the number N` (`settle-closed-status.ts`'s
 * `refusalCause`). Measured live 2026-09-13 with project 999: exit 1, `data.organization.projectV2: null`, and exactly
 * that error, while `repository.issue` still answered. What a token that cannot see the Project gets back for
 * `projectItems` ALONE is not measured -- this host's token can read it -- so the Project is named in the request,
 * where its refusal is already classified, rather than inferred from an item list.
 *
 * `totalCount` is asked for so a list shorter than its own count refuses rather than reads as "not on the board".
 */
const TOUCHED_ITEM_QUERY = `
  query($owner: String!, $name: String!, $project: Int!, $issue: Int!) {
    organization(login: $owner) { projectV2(number: $project) { id } }
    repository(owner: $owner, name: $name) {
      issue(number: $issue) {
        number title state
        projectItems(first: 10) {
          totalCount
          nodes {
            id
            project { number }
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
      }
    }
  }
`;

/** One page of the project's items, from `cursor` or the first, as the text GitHub answered. THROWS when the read is refused; the failed process's stdout carries GraphQL's own error. */
export function boardItemsPageOf({ owner, number, cursor, run }: { owner: string; number: number; cursor: string | null; run: RowsRun }): string {
  const args = ["api", "graphql", "-f", `query=${ITEMS_QUERY}`, "-f", `owner=${owner}`, "-F", `number=${number}`];
  if (cursor) args.push("-f", `cursor=${cursor}`);
  return run(args);
}

/** One issue's item on the project, and the project itself, in one request, as the text GitHub answered. THROWS when the read is refused. */
export function touchedItemTextOf({ owner, repo, project, issue, run }: { owner: string; repo: string; project: number; issue: number; run: RowsRun }): string {
  return run(["api", "graphql", "-f", `query=${TOUCHED_ITEM_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${repo.split("/")[1]}`, "-F", `project=${project}`, "-F", `issue=${issue}`]);
}

// --- the truth audit (board-truth-audit) --------------------------------------------------------------------------------------------

const ROADMAP_FIELD = "Roadmap";
const ROADMAP_ITEMS_ASKED = 20;
const ROADMAP_ISSUE_FIELDS = `number repository { nameWithOwner } projectItems(first: ${ROADMAP_ITEMS_ASKED}) { totalCount nodes {
  project { number owner { ... on Organization { login } ... on User { login } } }
  value: fieldValueByName(name: "${ROADMAP_FIELD}") { ... on ProjectV2ItemFieldSingleSelectValue { name } ... on ProjectV2ItemFieldTextValue { text } } } }`;

/**
 * The `Roadmap` facts of the rows `numbers` in ONE aliased request: each row's project items and its parent's and grandparent's. Answers the response's `data.repository`, an object keyed `r<number>`. THROWS when the read
 * is refused, is not JSON, or has no repository in it.
 */
export function roadmapFactsOf({ repo, numbers, run }: { repo: string; numbers: readonly number[]; run: RowsRun }): Record<string, any> {
  const [owner, name] = repo.split("/");
  const aliases = numbers.map((number) => `r${number}: issue(number: ${number}) { ...F parent { ...F parent { ...F } } }`).join("\n");
  const query = `fragment F on Issue { ${ROADMAP_ISSUE_FIELDS} }\nquery($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${aliases}\n} }`;
  const answer = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]))?.data?.repository;
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error("roadmap read: no repository in the answer");
  return answer;
}

/** The login that posted comment `id` of `repo`. */
export function commentAuthorOf({ repo, id, run }: { repo: string; id: string; run: RowsRun }): string {
  return run(["api", `repos/${repo}/issues/comments/${id}`, "--jq", ".user.login"]).trim();
}

/** The ids of the comments of row `row` since `since` that open with `heading`, one per line. THROWS when the read is refused. */
export function headedCommentIdsText({ repo, row, since, heading, run }: { repo: string; row: string; since: string; heading: string; run: RowsRun }): string {
  return run(["api", "--paginate", `repos/${repo}/issues/${row}/comments?per_page=100&since=${since}`, "--jq", `.[] | select(.body | startswith("${heading}")) | .id`]);
}

/** Parses the one-JSON-object-per-line output `--paginate` prints for a `--jq` that emits objects. */
function jsonLines(text: string): any[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** Every comment of `repo` since `since` by a login that starts with `loginPrefix`, as `{ number, author: { login }, body, createdAt, url }`: paged REST on the core pool. */
export function orgCommentsSinceOf({ repo, since, loginPrefix, run }: { repo: string; since: string; loginPrefix: string; run: RowsRun }): any[] {
  return jsonLines(run(["api", "--paginate", `repos/${repo}/issues/comments?since=${since}&per_page=100`, "--jq", `.[] | select(.user.login | startswith(${JSON.stringify(loginPrefix)}))
      | {number: (.issue_url | split("/") | last | tonumber), author: {login: .user.login}, body: .body, createdAt: .created_at, url: .html_url}`]));
}

/** Every issue of `repo` (pull requests left out) updated since `since`, as `{ number, state, author, createdAt, text }` with the title and body as one text. */
export function issuesSinceOf({ repo, since, run }: { repo: string; since: string; run: RowsRun }): any[] {
  return jsonLines(run(["api", "--paginate", `repos/${repo}/issues?state=all&since=${since}&per_page=100`, "--jq", ".[] | select(.pull_request | not) | {number: .number, state: .state, author: .user.login, createdAt: .created_at, text: (.title + \"\\n\" + (.body // \"\"))}"]));
}

/** The `labeled` events of row `number`, as `{ number, label, actor, createdAt }`. */
export function labeledEventsOfRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): any[] {
  return jsonLines(run(["api", "--paginate", `repos/${repo}/issues/${number}/events?per_page=100`, "--jq", `.[] | select(.event == "labeled") | {number: ${number}, label: .label.name, actor: .actor.login, createdAt: .created_at}`]));
}

/** The operations of this group. */
export const boardRows = {
  issuePageOf, allMilestonesOf, discussionCategoriesOf, discussionEditionsOf, createDiscussion, updateDiscussion, draftReleaseOf, createDraftRelease, uploadReleaseAsset, rowsListedIn, pullsListedIn, windowRowsTextOf,
  editionCommentCountOf, commentBodiesOfIssue, workflowRunListOf, workflowCreatedAtOf, boardItemsPageOf, touchedItemTextOf, roadmapFactsOf, commentAuthorOf, headedCommentIdsText, orgCommentsSinceOf, issuesSinceOf, labeledEventsOfRow,
};
