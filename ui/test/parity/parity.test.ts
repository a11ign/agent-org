import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ROOT } from "../site.ts";

// PARITY.md (docs/design/atomaut/) lists everything the old board (src/ticket-mode/ui.html, retired by A11-202) did, and where Atomaut does it (A11-220). This holds the file to its own rules: every feature
// row has a location, a ticket and a board or a pattern. (Until A11-202 it also held every element id and imported name of ui.html to a row; that was run once, on the last commit that held the file.)

const REPO = join(UI_ROOT, "..");
const PARITY = join(REPO, "docs", "design", "atomaut", "PARITY.md");

const COLUMNS = ["Feature", "In ui.html", "Atomaut page", "Ticket", "Board or pattern"] as const;

type Row = Readonly<{ cells: readonly string[]; line: number }>;

/** The feature rows of a PARITY.md: the rows of every table whose header begins with Feature. */
export function featureRows(markdown: string): Row[] {
  const rows: Row[] = [];
  let inFeatures = false;
  markdown.split("\n").forEach((text, index) => {
    if (!text.startsWith("|")) {
      inFeatures = false;
      return;
    }
    const cells = text.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Feature" && cells.length === COLUMNS.length) {
      inFeatures = true;
      return;
    }
    if (inFeatures && !cells.every((cell) => /^-+$/.test(cell))) rows.push({ cells, line: index + 1 });
  });
  return rows;
}

/** What is wrong with a row, naming it, or nothing. */
export function problemsOf({ cells, line }: Row): string[] {
  const named = `row at line ${line} (${cells[0] ?? ""})`;
  if (cells.length !== COLUMNS.length) return [`${named} has ${cells.length} cells, not ${COLUMNS.length}`];
  const empty = COLUMNS.filter((_, index) => cells[index] === "").map((column) => `${named} has an empty ${column}`);
  const [, , , ticket, board] = cells;
  const problems = [...empty];
  if (ticket !== "" && !/^A11-\d+$/.test(ticket)) problems.push(`${named} has a Ticket that is not a ticket key: ${ticket}`);
  if (board !== "" && !/^Atomaut[A-Za-z]+$/.test(board) && !/^pattern: \S.*$/.test(board)) problems.push(`${named} has a Board or pattern that is neither an Atomaut board nor "pattern: <words>": ${board}`);
  return problems;
}

const rows = featureRows(readFileSync(PARITY, "utf8"));

describe("PARITY.md rows", () => {
  it("lists a good many features, in the eight areas", () => {
    expect(rows.length).toBeGreaterThan(100);
    const headings = readFileSync(PARITY, "utf8").split("\n").filter((line) => /^## \d\. /.test(line));
    expect(headings).toHaveLength(8);
  });

  it("gives every feature row a feature, an ui.html source, an Atomaut page, a ticket key, and a board or a pattern", () => {
    expect(rows.flatMap(problemsOf)).toEqual([]);
  });
});

describe("the checks on a row", () => {
  const good = ["A feature", "`#id`", "`/runs`, below the list", "A11-220", "pattern: status banner"];
  const at = (cells: readonly string[]): Row => ({ cells, line: 1 });

  it("passes a row with every cell", () => {
    expect(problemsOf(at(good))).toEqual([]);
    expect(problemsOf(at([...good.slice(0, 4), "AtomautRuns"]))).toEqual([]);
  });

  it("fails a row with no Atomaut page, and names it", () => {
    expect(problemsOf(at([good[0], good[1], "", good[3], good[4]]))).toEqual(["row at line 1 (A feature) has an empty Atomaut page"]);
  });

  it("fails a row with no ticket, a ticket that is not a key, or a last cell that is neither a board nor a pattern", () => {
    expect(problemsOf(at([...good.slice(0, 3), "", good[4]]))).toEqual(["row at line 1 (A feature) has an empty Ticket"]);
    expect(problemsOf(at([...good.slice(0, 3), "soon", good[4]]))).toHaveLength(1);
    expect(problemsOf(at([...good.slice(0, 4), "a banner"]))).toHaveLength(1);
    expect(problemsOf(at([...good.slice(0, 4), "pattern:"]))).toHaveLength(1);
  });

  it("fails a row with a cell too few", () => {
    expect(problemsOf(at(good.slice(0, 4)))).toHaveLength(1);
  });

  it("reads only the tables that begin with Feature", () => {
    const text = ["| Column | Says |", "| --- | --- |", "| Feature | What |", "", "| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |", "| --- | --- | --- | --- | --- |", `| ${good.join(" | ")} |`].join("\n");
    expect(featureRows(text).map(({ cells }) => cells[0])).toEqual(["A feature"]);
  });
});
