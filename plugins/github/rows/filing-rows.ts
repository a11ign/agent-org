// module: the GitHub plugin's rows for filing a row and promoting it (A11-160, step 7; moved from `src/row-file/`)
//
// `row-file` DECIDES what is filed, what a refusal says and in what order the filing is boarded, labelled and read back; the command that writes or reads each step, and the reading of GitHub's answer, are here. Each operation builds
// the argument list `row-file` built and reads the answer as it did, and throws when `gh` refuses unless its comment says otherwise.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { CommandRun, MilestoneRead, RoadmapFieldRead, RoadmapItemRead } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import { PROJECT_ITEMS_PAGE } from "./project-membership.ts";

/** The runner of this code host's program, made of a runner that takes a program and its arguments: `row-file`'s callers are handed one (`defaultRun`, a test's stub) and name no program of their own. */
export function argumentsRunOf(run: CommandRun): RowsRun {
  return (args) => run("gh", args);
}

/** A blocker's state and body, or `null` when it cannot be read: an unreadable blocker is an unknown, never an umbrella. */
export function blockerRowOf({ number, repo, run }: { number: number; repo: string; run: RowsRun }): { state: string; body: string } | null {
  try {
    const row = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "state,body"]));
    return typeof row?.state === "string" ? { state: row.state, body: String(row.body ?? "") } : null;
  } catch {
    return null;
  }
}

/** The newest `limit` open rows of `repo` with their numbers and titles, as the list printed them. THROWS when the read is refused. */
export function newestOpenRowsText({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): string {
  return run(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,title"]);
}

/** Sets the single-select option `optionId` of field `fieldId` of project `projectId` on the board item `itemId`. */
export function setBoardItemOption({ itemId, projectId, fieldId, optionId, run }: { itemId: string; projectId: string; fieldId: string; optionId: string; run: RowsRun }): void {
  run(["project", "item-edit", "--id", itemId, "--project-id", projectId, "--field-id", fieldId, "--single-select-option-id", optionId]);
}

/** Files a row from the arguments of `gh issue create`, unchanged, and answers its address, trimmed. THROWS when `gh` refuses. */
export function fileRowFromArguments({ argv, run }: { argv: string[]; run: RowsRun }): string {
  return run(["issue", "create", ...argv]).trim();
}

/** The milestones of `repo` as GitHub lists them. THROWS when the read is refused or is not JSON. */
export function milestonesOf({ repo, run }: { repo: string; run: RowsRun }): MilestoneRead[] {
  return JSON.parse(run(["api", `repos/${repo}/milestones`]));
}

/** The titles of the milestones of `repo`, without the blank ones. THROWS when the read is refused. */
export function milestoneTitlesOf({ repo, run }: { repo: string; run: RowsRun }): string[] {
  return run(["api", `repos/${repo}/milestones`, "--jq", ".[].title"]).split("\n").map((title) => title.trim()).filter(Boolean);
}

/** Puts every label of `labels` on row `number` of `repo`, in one edit. */
export function addLabelsToRowIn({ repo, number, labels, run }: { repo: string; number: number; labels: string[]; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
}

/** The body of row `number` of `repo`, as `gh` prints it. */
export function bodyTextOfRowIn({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string {
  return run(["issue", "view", String(number), "--repo", repo, "--json", "body", "--jq", ".body"]);
}

/** The title of the milestone of row `number` of `repo`, as `gh` prints it (an empty line for a row with none). */
export function milestoneTitleOfRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string {
  return run(["issue", "view", String(number), "--repo", repo, "--json", "milestone", "--jq", ".milestone.title // \"\""]);
}

/** Every project item of one row with its value of the single-select field `field`, paged. THROWS on a failed call or an unexpected shape. */
export function roadmapItemsOf({ repo, number, field, run }: { repo: string; number: number; field: string; run: RowsRun }): RoadmapItemRead[] {
  const [owner, name] = repo.split("/");
  const items: RoadmapItemRead[] = [];
  let cursor: string | null = null;
  do {
    const after = cursor === null ? "" : `, after: "${cursor}"`;
    const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) `
      + `{ projectItems(first: ${PROJECT_ITEMS_PAGE}${after}) { pageInfo { hasNextPage endCursor } `
      + `nodes { id project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "${field}") `
      + `{ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
    const page: any = JSON.parse(run(["api", "graphql", "-f", `query=${query}`]))?.data?.repository?.issue?.projectItems;
    if (!Array.isArray(page?.nodes)) throw new Error(`gh's Project-membership response for ${repo}#${number} did not have the expected shape (is the issue there?)`);
    for (const node of page.nodes) {
      items.push({ id: String(node?.id ?? ""), number: Number(node?.project?.number), owner: String(node?.project?.owner?.login ?? ""),
        value: typeof node?.fieldValueByName?.name === "string" ? node.fieldValueByName.name : null });
    }
    cursor = page.pageInfo?.hasNextPage === true ? (page.pageInfo.endCursor ?? null) : null;
  } while (cursor !== null);
  return items;
}

/** The single-select field `field` of a board, with the ids a write needs and the options the project holds now; `null` when the board has no such field. THROWS when the board cannot be read. */
export function roadmapFieldOf({ owner, boardNumber, field, run }: { owner: string; boardNumber: number; field: string; run: RowsRun }): RoadmapFieldRead | null {
  const project = `projectV2(number: ${boardNumber}) { id field(name: "${field}") { ... on ProjectV2SingleSelectField { id options { id name } } } }`;
  const query = `query { repositoryOwner(login: "${owner}") { ... on Organization { ${project} } ... on User { ${project} } } }`;
  const board: any = JSON.parse(run(["api", "graphql", "-f", `query=${query}`]))?.data?.repositoryOwner?.projectV2;
  if (typeof board?.id !== "string") throw new Error(`could not read ${owner}/projects/${boardNumber}`);
  const { id, options } = board.field ?? {};
  if (typeof id !== "string" || !Array.isArray(options)) return null;
  return { projectId: board.id, fieldId: id, options: options.map((option: any) => ({ id: String(option.id), name: String(option.name) })) };
}

/** The operations of this file, as the plugin's rows carry them. */
export const filingRows = {
  argumentsRunOf, blockerRowOf, newestOpenRowsText, setBoardItemOption, fileRowFromArguments, milestonesOf, milestoneTitlesOf, addLabelsToRowIn, bodyTextOfRowIn, milestoneTitleOfRow, roadmapItemsOf, roadmapFieldOf,
};
