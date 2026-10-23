// @ts-check
// module: the in-memory code host's operations for the board's items (A11-160, step 8)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row is on the board when the world says so (`onBoard`), at the Status it names (`boardStatus`). The two reads answer
// GitHub's own TEXT (a page of the project's items; one issue's item and the project), rendered from those rows, so a core test seeds rows and not a stubbed GraphQL response. The project's id and the option names of its Status
// field are `world.reports.snapshot.project`; a refused read is `world.failures` naming the operation (an error that carries `stdout` is a failed process whose stdout holds GraphQL's own error body). Two facts of the
// board are not rows: items with no issue behind them (`drafts`) and rows that are on the board though the items connection has not enumerated them yet (`notEnumerated`, the index lag #2157 measured: the per-issue
// read finds them at once).
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

/** What the board's snapshot reads of the world beyond its rows. */
export type FakeSnapshot = {
  /** The project: its id, and the option names of its Status field (`null`: the page does not carry the field). */
  project: { id: string; statusOptions: string[] | null };
  /** The ids of the draft items on the board: items with no issue behind them, which the items connection carries with `content: null`. */
  drafts: string[];
  /** The numbers of rows that are on the board (`onBoard`) though the project's items connection has not enumerated them yet; one issue's own item read finds them. */
  notEnumerated: number[];
};

export const emptySnapshot = (): FakeSnapshot => ({ project: { id: "PVT_fake", statusOptions: ["Backlog", "Ready", "In progress", "Parked", "Done"] }, drafts: [], notEnumerated: [] });

const PAGE = 100;

type Operations = Pick<CodeHostRows, "boardItemsPageOf" | "touchedItemTextOf">;

export function snapshotOperations(world: FakeRowsWorld): Operations {
  const project = () => world.reports.snapshot.project;
  return {
    boardItemsPageOf: ({ cursor }) => {
      const lagging = world.reports.snapshot.notEnumerated;
      const rowItems = [...world.rows.values()].filter((row) => row.onBoard && !lagging.includes(row.number)).sort((a, b) => a.number - b.number)
        .map((row) => ({ id: `PVTI_${row.number}`, content: { number: row.number, title: row.title, state: row.state },
          fieldValues: { nodes: row.boardStatus === null ? [] : [{ name: row.boardStatus, field: { name: "Status" } }] } }));
      const items = [...rowItems, ...world.reports.snapshot.drafts.map((id) => ({ id, content: null, fieldValues: { nodes: [] } }))];
      const from = cursor === null ? 0 : Number(cursor);
      const next = from + PAGE;
      const nodes = items.slice(from, next);
      const field = project().statusOptions === null ? undefined : { options: project().statusOptions!.map((name) => ({ name })) };
      return JSON.stringify({ data: { organization: { projectV2: { ...(field === undefined ? {} : { field }), items: { pageInfo: { hasNextPage: next < items.length, endCursor: next < items.length ? String(next) : null }, nodes } } } } });
    },
    touchedItemTextOf: ({ project: number, issue }) => {
      const row = world.rows.get(issue);
      const node = row === undefined ? null : { number: row.number, title: row.title, state: row.state,
        projectItems: { totalCount: row.onBoard ? 1 : 0, nodes: row.onBoard ? [{ id: `PVTI_${row.number}`, project: { number }, fieldValueByName: row.boardStatus === null ? null : { name: row.boardStatus } }] : [] } };
      return JSON.stringify({ data: { organization: { projectV2: { id: project().id } }, repository: { issue: node } } });
    },
  };
}
