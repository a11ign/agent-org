// @ts-check
// module: the in-memory code host's operations for filing a row and promoting it (A11-160, step 7)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row of another tracker's repository is among `world.foreignRows`, by `owner/name#number`. What `row-file` reads of the
// board and the repository beyond rows is `FakeFiling`: the milestones of a repository, a row's milestone, the project items of a row with their value of a single-select field and the fields of a board. A read that is
// refused is an `Error` where the world holds the answer, and a board or a repository the world holds nothing of answers as an empty one (milestones) or as a board that cannot be read (a field).
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { MilestoneRead, RoadmapFieldRead, RoadmapItemRead } from "../contracts/code-host-rows-facts.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** What filing reads of the world beyond its rows and pull requests. */
export type FakeFiling = {
  /** The milestones of each repository, by `owner/name`; an `Error` is a refused read, and a repository the world holds none of has none. */
  milestones: Map<string, MilestoneRead[] | Error>;
  /** The milestone title of a row, by `owner/name#number`; a row with none is absent. */
  rowMilestones: Map<string, string>;
  /** The project items of a row with their value of the Roadmap field, by `owner/name#number`; an `Error` is a refused read, and a row the world holds none of is on no board. */
  roadmapItems: Map<string, RoadmapItemRead[] | Error>;
  /** The Roadmap field of each board, by `owner/boardNumber`; `null` is a board without the field, an `Error` a refused read, and a board the world holds nothing of cannot be read. */
  roadmapFields: Map<string, RoadmapFieldRead | null | Error>;
  /** The labels created in a repository other than the tracker's, as `owner/name:label`, and the arguments of every row filed from arguments. */
  labelsCreatedIn: string[];
  filed: string[][];
  /** The options set on board items, in order, and the rows whose board items were read (`owner/name#number`), in order. */
  optionsSet: { itemId: string; projectId: string; fieldId: string; optionId: string }[];
  roadmapReads: string[];
  /** What the list of the newest open rows prints instead of the rows (text that is not JSON, JSON that is not a list), or the error that read throws: absent, the rows the world holds. */
  openRowsAnswer?: string | Error;
};

export const emptyFiling = (): FakeFiling => ({ milestones: new Map(), rowMilestones: new Map(), roadmapItems: new Map(), roadmapFields: new Map(), labelsCreatedIn: [], filed: [], optionsSet: [], roadmapReads: [] });

const keyOf = (repo: string, number: number): string => `${repo}#${number}`;

function rowIn(world: FakeRowsWorld, repo: string, number: number): FakeRow {
  const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(keyOf(repo, number));
  if (row === undefined) throw new Error(`the fake holds no row ${keyOf(repo, number)}`);
  return row;
}

const rowsOf = (world: FakeRowsWorld, repo: string): FakeRow[] =>
  repo === world.repo ? [...world.rows.values()] : [...world.foreignRows].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row);

/** The value of `--name` in the arguments of a create, in either spelling; the last one given wins. */
function flagValues(argv: string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg === `--${name}` ? [argv[index + 1] ?? ""] : arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : []));
}

const refused = (answer: unknown): void => {
  if (answer instanceof Error) throw answer;
};

/** The operations of filing a row, over the world. */
export function filingOperations(world: FakeRowsWorld): Pick<CodeHostRows, "argumentsRunOf" | "blockerRowOf" | "newestOpenRowsText" | "setBoardItemOption" | "fileRowFromArguments" | "milestonesOf" | "milestoneTitlesOf"
  | "addLabelsToRowIn" | "bodyTextOfRowIn" | "milestoneTitleOfRow" | "roadmapItemsOf" | "roadmapFieldOf"> {
  const { filing } = world;
  const openRowsText = (repo: string, limit: number): string =>
    JSON.stringify(rowsOf(world, repo).filter((row) => row.state === "OPEN").sort((a, b) => b.number - a.number).slice(0, limit).map(({ number, title }) => ({ number, title })));
  const milestonesIn = (repo: string): MilestoneRead[] => {
    const held = filing.milestones.get(repo) ?? [];
    refused(held);
    return held as MilestoneRead[];
  };
  return {
    // A fake has no program to run: the runner it makes refuses, since every operation of the fake acts on the world.
    argumentsRunOf: () => () => { throw new Error("the fake code host has no program to run"); },
    blockerRowOf: ({ number, repo }) => {
      const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(keyOf(repo, number));
      return row === undefined ? null : { state: row.state, body: row.body };
    },
    newestOpenRowsText: ({ repo, limit }) => {
      world.calls.push(`newestOpenRowsText ${repo} ${limit}`);
      if (filing.openRowsAnswer instanceof Error) throw filing.openRowsAnswer;
      return filing.openRowsAnswer ?? openRowsText(repo, limit);
    },
    setBoardItemOption: ({ itemId, projectId, fieldId, optionId }) => {
      filing.optionsSet.push({ itemId, projectId, fieldId, optionId });
      const option = [...filing.roadmapFields.values()].flatMap((field) => (field instanceof Error || field === null || field.fieldId !== fieldId ? [] : field.options)).find(({ id }) => id === optionId);
      if (option === undefined) throw new Error(`the fake holds no option ${optionId} of field ${fieldId}`);
      const item = [...filing.roadmapItems.values()].flatMap((items) => (items instanceof Error ? [] : items)).find(({ id }) => id === itemId);
      if (item === undefined) throw new Error(`the fake holds no board item ${itemId}`);
      item.value = option.name;
      world.calls.push(`setBoardItemOption ${itemId}`);
    },
    fileRowFromArguments: ({ argv }) => {
      const repo = flagValues(argv, "repo")[0] ?? world.repo;
      filing.filed.push([...argv]);
      const number = world.nextNumber++;
      const row: FakeRow = { number, title: flagValues(argv, "title")[0] ?? "", body: flagValues(argv, "body")[0] ?? "", state: "OPEN", labels: flagValues(argv, "label"), createdAt: new Date(world.now()).toISOString(), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null };
      if (repo === world.repo) world.rows.set(number, row);
      else world.foreignRows.set(keyOf(repo, number), row);
      return `https://github.com/${repo}/issues/${number}`;
    },
    milestonesOf: ({ repo }) => milestonesIn(repo).map((milestone) => ({ ...milestone })),
    milestoneTitlesOf: ({ repo }) => milestonesIn(repo).map((milestone) => String(milestone.title ?? "").trim()).filter(Boolean),
    addLabelsToRowIn: ({ repo, number, labels }) => {
      const row = rowIn(world, repo, number);
      for (const label of labels) if (!row.labels.includes(label)) row.labels.push(label);
    },
    bodyTextOfRowIn: ({ repo, number }) => rowIn(world, repo, number).body,
    milestoneTitleOfRow: ({ repo, number }) => {
      rowIn(world, repo, number);
      return filing.rowMilestones.get(keyOf(repo, number)) ?? "";
    },
    roadmapItemsOf: ({ repo, number }) => {
      filing.roadmapReads.push(keyOf(repo, number));
      const held = filing.roadmapItems.get(keyOf(repo, number)) ?? [];
      refused(held);
      return (held as RoadmapItemRead[]).map((item) => ({ ...item }));
    },
    roadmapFieldOf: ({ owner, boardNumber }) => {
      const held = filing.roadmapFields.get(`${owner}/${boardNumber}`);
      if (held === undefined) throw new Error(`could not read ${owner}/projects/${boardNumber}`);
      refused(held);
      return held as RoadmapFieldRead | null;
    },
  };
}
