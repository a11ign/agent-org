// #5405: the Project-membership read a machine-filed row's retry needs. Kept out of `row-file.ts` on purpose: `row-file` imports `work-gate.ts`,
// which reaches `ci-failure-class.ts` again, so `ci-failure-class` importing `row-file` closes a cycle that crashes `claim-stall-tick.ts` at load.
// It spawns nothing: the caller hands in the `gh` reader, as the adapter does (#484).
import type { ReadGh, RowsTracker as Tracker } from "../../../src/plugins/contracts/code-host-rows.ts";

/** #3330: project items asked for per request; `fetchIssueBoardStatus` pages past it rather than trusting it. */
export const PROJECT_ITEMS_PAGE = 100;

/**
 * One page of the issue's `projectItems`. Throws, never guesses, on a failed call or an unexpected shape.
 * @param {number} issueNumber @param {string | null} cursor @param {ReadGh} read @param {string} repo the tracker the issue lives in
 * @returns {{ nodes: any[], hasNextPage: boolean, endCursor: string | null }}
 */
function projectItemsPage(issueNumber: number, cursor: string | null, read: ReadGh, repo: string): { nodes: any[]; hasNextPage: boolean; endCursor: string | null; } {
  const [owner, name] = repo.split("/");
  const after = cursor === null ? "" : `, after: "${cursor}"`;
  const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${issueNumber}) `
    + `{ projectItems(first: ${PROJECT_ITEMS_PAGE}${after}) { pageInfo { hasNextPage endCursor } `
    + `nodes { project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "Status") `
    + `{ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  let raw: string;
  try {
    raw = read(["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`row-file: could not read #${issueNumber}'s Project membership -- refusing to guess `
      + `whether it boarded. ${(cause as Error).message}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} was not JSON -- `
      + `refusing to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const items = (parsed as any)?.data?.repository?.issue?.projectItems;
  if (!Array.isArray(items?.nodes)) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} did not have the `
      + `expected shape -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const endCursor = items.pageInfo?.endCursor ?? null;
  const hasNextPage = items.pageInfo?.hasNextPage === true;
  if (hasNextPage && endCursor === null) {
    throw new Error(`row-file: gh reports more Project items for #${issueNumber} but no cursor to read them `
      + "-- refusing to guess whether it is on the Project.");
  }
  return { nodes: items.nodes, hasNextPage, endCursor };
}

/**
 * #5405: is issue `issueNumber` on the tracker's Project AT ALL, whatever its Status? `fetchIssueBoardStatus` cannot answer that: its `null` is
 * "not on the board" AND "on it with no Status", and a retry that cannot tell them apart adds an item that is already there. Throws when unreadable.
 * @param {number} issueNumber @param {{ read: ReadGh, tracker?: Tracker }} deps
 * @returns {boolean}
 */
export function isIssueOnBoard(issueNumber: number, { read, tracker }: { read: ReadGh; tracker: Tracker; }): boolean {
  return boardItemOf(issueNumber, read, tracker) !== undefined;
}

/** The issue's item on the tracker's Project, read page by page until it is found or the pages run out; `undefined` when it is not on the board. */
export function boardItemOf(issueNumber: number, read: ReadGh, tracker: Tracker): any | undefined {
  let cursor: string | null = null;
  do {
    const page = projectItemsPage(issueNumber, cursor, read, tracker.repo);
    const onThisProject = page.nodes.find((n) => isBoardOf(tracker, n?.project));
    if (onThisProject) return onThisProject;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor !== null);
  return undefined;
}

/** @param {Tracker} tracker @param {{ number?: unknown, owner?: { login?: unknown } } | undefined} project @returns {boolean} */
function isBoardOf(tracker: Tracker, project: { number?: unknown; owner?: { login?: unknown; }; } | undefined): boolean {
  if (project?.number !== tracker.board.number) return false;
  const login = project.owner?.login;
  return typeof login !== "string" || login.toLowerCase() === tracker.board.owner.toLowerCase();
}
