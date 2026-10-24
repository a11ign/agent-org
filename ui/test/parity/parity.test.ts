import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ROOT } from "../site.ts";

// PARITY.md (docs/design/atomaut/) lists everything today's board (src/ticket-mode/ui.html) does, and where Atomaut does it (A11-220). This holds the file to its own rules: every feature row has a
// location, a ticket and a board or a pattern, and, while ui.html exists, every element id and every name it imports from the board's modules is in some row.

const REPO = join(UI_ROOT, "..");
const PARITY = join(REPO, "docs", "design", "atomaut", "PARITY.md");
const UI_HTML = join(REPO, "src", "ticket-mode", "ui.html");

/** The modules `ui.html` imports its decisions from. */
const MODULES = ["/board-view.js", "/label-filters.js", "/assignee-filter.js", "/settings-search.js", "/plugins-section.js"];

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

/** The names and `#ids` the "In ui.html" column mentions, from the code spans of its cells. */
export function mentioned(rows: readonly Row[]): Set<string> {
  const found = new Set<string>();
  for (const { cells } of rows) {
    for (const span of (cells[1] ?? "").matchAll(/`([^`]+)`/g)) for (const token of span[1].split(/[^\w#-]+/)) if (token !== "") found.add(token);
  }
  return found;
}

/** Every element id of `ui.html`'s markup, as `#id`. */
export function idsOf(html: string): string[] {
  const markup = html.slice(html.indexOf("<body>"), html.indexOf("<script"));
  return [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => `#${match[1]}`);
}

/** Every name `ui.html` imports from the modules above. */
export function importsOf(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/import \{([^}]*)\} from "([^"]+)"/g)) {
    if (MODULES.includes(match[2])) names.push(...match[1].split(",").map((name) => name.trim()).filter((name) => name !== ""));
  }
  return names;
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
  const good = ["A feature", "`#id`", "`/next/runs`, below the list", "A11-220", "pattern: status banner"];
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

// Removed by A11-202 with ui.html: it reads the file that is retired.
describe.skipIf(!existsSync(UI_HTML))("everything ui.html has is in a row", () => {
  const html = existsSync(UI_HTML) ? readFileSync(UI_HTML, "utf8") : "";
  const found = mentioned(rows);

  it("finds ui.html's ids and imports", () => {
    expect(idsOf(html).length).toBeGreaterThan(80);
    expect(importsOf(html).length).toBeGreaterThan(100);
  });

  it("has every element id of ui.html's markup in the ui.html column of some row", () => {
    expect(idsOf(html).filter((id) => !found.has(id))).toEqual([]);
  });

  it("has every name ui.html imports from the board's modules in the ui.html column of some row", () => {
    expect(importsOf(html).filter((name) => !found.has(name))).toEqual([]);
  });
});
