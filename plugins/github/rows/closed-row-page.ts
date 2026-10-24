// module: the GitHub plugin's read of the CLOSED rows that sit on the project, one page at a time (A11-160, step 9; moved from `src/settle-closed-status.ts`, where it was `closedRowsPageQuery` and `closedRowsPageFromRead`)
//
// `settle-closed-rows.ts` walks the pages (the cursor, the cap on how many it will read) and decides what an unreadable page means; the query and the reading of GitHub's answer are here. A refused `run` THROWS, and so does every
// shape of answer this does not recognise: the list is the only thing that can tell a complete board read from a partial one.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ClosedRowPage } from "../../../src/plugins/contracts/code-host-rows-closing.ts";

/**
 * #2081, ADDED ON REVIEW; #2719, REPLACED THE SEARCH ENTIRELY: THE FLOOR'S OWN POPULATION READ, AS THE
 * GRAPHQL `gh` IS GIVEN.
 *
 * **The first version of this floor sampled, and called the sample a population.** It asked for the 100
 * most recently closed issues and filtered them by `projectItems` being non-empty, then checked those ids
 * against the board read. `reviewer-2` (09:17Z) and `reviewer` (14:39Z) landed on it independently, five
 * and a half hours and one push apart: a boarded closed row ranked 101st or older is not in the sample, so
 * the pass reports a complete read over a row it never saw -- which is the defect the floor exists to
 * catch, arriving through the floor itself.
 *
 * **The second version fixed the sampling and reintroduced the same shape of ceiling one layer up (#2719).**
 * `gh issue list --search "project:<owner>/<number>"` is a SEARCH, and every GitHub search is capped at
 * 1,000 results whatever `--limit` asks for -- so `FLOOR_LIMIT` was a number this floor's own population
 * would eventually cross, exactly as it crossed 500 four days after being measured at 201. Raising the
 * number only moved the day it would fire again.
 *
 * **So the read is now a cursor walk of `repository.issues(states: CLOSED)`, which GitHub does not cap.**
 * A `project:<owner>/<number>` qualifier does not exist on this connection, so membership is read PER
 * ISSUE instead, the same way `readRowsOffBoard` (`work-gate.ts`, #2075) already reads it for OPEN rows:
 * each node carries its own `projectItems`, and `closedRowsPageFromRead` keeps only the ones naming this
 * Project. **It is `gh issue list`'s replacement, never `gh pr list`** -- this pass's population must not
 * depend on any PR existing, which is the whole of #2081.
 *
 * @param {{ owner: string, name: string, after: string | null }} repo
 * @returns {string[]} the argv, so the identity that names the repository is asserted rather than described
 */
export function closedRowsPageQuery({ owner, name, after }: { owner: string; name: string; after: string | null; }): string[] {
  const args = ["api", "graphql", "-f", `query=${CLOSED_ROWS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
  if (after !== null) args.push("-f", `after=${after}`);
  return args;
}

/**
 * #2719: the GraphQL query `closedRowsPageQuery` sends. `projectItems(first: 10)` is `readRowsOffBoard`'s
 * own page size for the same question ("has this row ever carried more than ten Project memberships" is
 * not a case this repo has), and `closedRowsPageFromRead` refuses rather than guesses when it is not enough.
 */
export const CLOSED_ROWS_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: CLOSED, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          projectItems(first: 10) { totalCount nodes { project { number } } }
        }
      }
    }
  }
`;

/**
 * #2719: `closedRowsPageQuery`'s response, parsed -- ONE PAGE, filtered to this Project and never trusted
 * past the shape it declares.
 *
 * THROWS on every shape it does not recognise, `closedRowsFromRead`'s discipline before it and for the
 * same reason: this list is the only thing that can tell a complete board read from a partial one, so a
 * list this function had to guess at would make the floor report clean over a population it never
 * established. That now includes PER-ISSUE membership: an issue whose `projectItems` page came back
 * shorter than its `totalCount`, with none of the fetched entries naming this Project, is one this read
 * cannot call either "on the board" or "not on the board" -- and guessing either way is the exact defect
 * the floor exists to catch, so it refuses instead.
 *
 * @param {string} raw `gh`'s stdout for one page
 * @param {number} projectNumber the Project this pass narrows to
 * @returns {{ numbers: number[], hasNextPage: boolean, endCursor: string | null }}
 */
export function closedRowsPageFromRead(raw: string, projectNumber: number): ClosedRowPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`settle-closed-rows: gh's closed-row page was not JSON -- refusing to guess whether `
      + `the board read is complete. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const errors = (parsed as { errors?: unknown })?.errors;
  if (errors) {
    throw new Error(`settle-closed-rows: the closed-row page came back with errors -- refusing to guess. `
      + `Got: ${JSON.stringify(errors).slice(0, 300)}`);
  }
  const issues = (parsed as { data?: { repository?: { issues?: unknown } } })?.data?.repository?.issues;
  const nodes = (issues as { nodes?: unknown, pageInfo?: { hasNextPage?: unknown, endCursor?: unknown } });
  if (!nodes || !Array.isArray(nodes.nodes) || typeof nodes.pageInfo?.hasNextPage !== "boolean") {
    throw new Error(`settle-closed-rows: the closed-row page was not the expected shape -- refusing to `
      + `guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const numbers = nodes.nodes.map((entry: unknown, i: number) => {
    const node = (entry as { number?: unknown, projectItems?: { totalCount?: unknown, nodes?: unknown } });
    if (typeof node?.number !== "number") {
      throw new Error(`settle-closed-rows: closed-row page entry ${i} has no number -- refusing to guess. `
        + `Got: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    const items = node.projectItems;
    if (!items || !Array.isArray(items.nodes) || typeof items.totalCount !== "number") {
      throw new Error(`settle-closed-rows: #${node.number}'s Project membership came back in an `
        + `unexpected shape -- refusing to default it to an empty, complete list. Got: `
        + `${JSON.stringify(items ?? null).slice(0, 300)}`);
    }
    const itemNodes = items.nodes;
    const onThisProject = itemNodes.some(
      (item: { project?: { number?: unknown; }; }) => item?.project?.number === projectNumber);
    const complete = itemNodes.length >= items.totalCount;
    if (!onThisProject && !complete) {
      throw new Error(`settle-closed-rows: #${node.number}'s Project membership could not be read `
        + `completely -- it carries more project items than this page fetched and none of the fetched `
        + `ones name Project ${projectNumber}, so this read cannot tell whether it is on this board. `
        + `Refusing to guess.`);
    }
    return onThisProject ? node.number : null;
  }).filter(/** @returns {n is number} */ (n): n is number => n !== null);
  return {
    numbers,
    hasNextPage: nodes.pageInfo.hasNextPage === true,
    endCursor: typeof nodes.pageInfo.endCursor === "string" ? nodes.pageInfo.endCursor : null,
  };
}

/** One page of the closed rows on project `projectNumber` of `owner/name`, from the cursor `after` (`null` for the first). */
export function closedRowPageOf({ owner, name, after, projectNumber, run }: { owner: string; name: string; after: string | null; projectNumber: number; run: RowsRun }): ClosedRowPage {
  return closedRowsPageFromRead(run(closedRowsPageQuery({ owner, name, after })), projectNumber);
}
