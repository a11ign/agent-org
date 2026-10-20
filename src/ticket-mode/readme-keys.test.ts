import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA } from "./config-schema.ts";

/** A key cell links to the schema's file. GitHub cannot link to an entry by key, so the file is the link and the key is the search term. */
const SCHEMA_LINK = /^\[`([^`]+)`\]\(src\/ticket-mode\/config-schema\.ts\)$/;

type Row = Readonly<{ line: number; cells: readonly string[] }>;

/** The rows under the key table's `| key |` header, each with its line number in the README. */
function keyTableRows(markdown: string): Row[] {
  const lines = markdown.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| key |"));
  assert.notEqual(header, -1, "README.md has a key table");
  const rows: Row[] = [];
  const firstRow = header + 2; // past the header and the `| --- |` separator
  for (let at = firstRow; at < lines.length && lines[at].startsWith("|"); at += 1) {
    rows.push({ line: at + 1, cells: lines[at].split("|").slice(1, -1).map((cell) => cell.trim()) });
  }
  return rows;
}

/** What is wrong with one row on its own. Each problem names the row's line, so a drift shows where it is. */
function rowProblems({ line, cells }: Row, keys: ReadonlySet<string>): string[] {
  const where = `README.md:${line}`;
  const [keyCell = "", ...rest] = cells;
  const link = SCHEMA_LINK.exec(keyCell);
  if (link === null) return [`${where}: the key cell is not a link to src/ticket-mode/config-schema.ts: ${keyCell}`];
  const key = link[1] ?? "";
  const problems: string[] = [];
  if (rest.some((cell) => cell !== "")) problems.push(`${where}: ${key} carries text beyond its key cell`);
  if (!keys.has(key)) problems.push(`${where}: ${key} is not a key the schema describes`);
  return problems;
}

/** Every way the key table breaks its rule: a link to the schema per row, a key the schema describes, and no key in two rows. */
function keyTableProblems(markdown: string): string[] {
  const keys = new Set(SCHEMA.map((entry) => entry.key));
  const rows = keyTableRows(markdown);
  return rows.flatMap((row, at) => {
    const repeated = rows.slice(0, at).some((earlier) => earlier.cells[0] === row.cells[0]);
    const key = SCHEMA_LINK.exec(row.cells[0] ?? "")?.[1] ?? "";
    return [...rowProblems(row, keys), ...(repeated ? [`README.md:${row.line}: ${key} is already in a row`] : [])];
  });
}

/**
 * The keys the table has, in its order. The table is not a list of every key (the schema is, and most of its keys have no row), so a key
 * added to or removed from the table is a change to this list, made on purpose.
 */
const TABLE_KEYS = [
  "tickets.max", "tickets.port", "tickets.uiPort", "tickets.serve", "tickets.servePorts", "tickets.herdrSession", "tickets.worktreeRoot",
  "tickets.linearKey", "tickets.brief", "tickets.review", "tickets.plugins", "tickets.deny", "tickets.connectors", "tickets.terminal",
  "tickets.plan", "tickets.planner", "tickets.publish", "tickets.writer", "tickets.preflight", "tickets.drafts", "tickets.prReview",
  "tickets.reviewer", "tickets.pick", "tickets.stallMinutes", "tickets.updateMaxDeferHours", "tickets.workingState", "stateDir",
  "tickets.providers", "tickets.providers.tracker", "tickets.providers.tracker.provider", "tickets.providers.tracker.key", "tickets.providers.tracker.key.path",
  "tickets.providers.tracker.key.keychain", "tickets.providers.tracker.connectors", "tickets.providers.tracker.workingState",
  "tickets.providers.tracker.plannedState", "tickets.providers.codeHost", "tickets.providers.codeHost.provider", "tickets.providers.codeHost.identity",
  "tickets.providers.codeHost.identity.<role>", "tickets.providers.codeHost.identity.<role>.mode", "tickets.providers.codeHost.identity.<role>.appId",
  "tickets.providers.codeHost.identity.<role>.keyPath", "tickets.providers.codeHost.identity.<role>.installationId", "tickets.providers.codeHost.identity.<role>.slug",
  "tickets.providers.codeHost.gh", "tickets.providers.codeHost.gh.workers", "tickets.providers.codeHost.gh.leads", "tickets.providers.codeHost.gh.leadsHeader",
  "tickets.providers.codeHost.gh.leadsWorkspaces", "tickets.providers.codeHost.gh.leadsWorkspaces[].id", "tickets.providers.codeHost.gh.leadsWorkspaces[].role",
  "tickets.providers.codeHost.stack", "tickets.providers.publish", "tickets.providers.publish.provider", "tickets.providers.publish.run", "tickets.providers.publish.model",
  "tickets.providers.publish.effort", "tickets.providers.publish.connectors", "tickets.providers.reviewer", "tickets.providers.reviewer.provider",
  "tickets.providers.exposure", "tickets.providers.exposure.provider", "tickets.providers.exposure.port", "tickets.providers.exposure.uiPort",
  "tickets.providers.exposure.terminal", "tickets.providers.exposure.tailnetPorts", "tickets.providers.exposure.tailnetPorts.ui",
  "tickets.providers.exposure.tailnetPorts.terminal",
];

/** A key of TABLE_KEYS with no row in the table: a row deleted without a change to the list. */
function missingRowProblems(markdown: string): string[] {
  const keysInTable = keyTableRows(markdown).map((row) => SCHEMA_LINK.exec(row.cells[0] ?? "")?.[1]);
  return TABLE_KEYS.filter((key) => !keysInTable.includes(key)).map((key) => `README.md: ${key} has no row in the key table`);
}

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("every key in the README's key table links to the schema, each is a key the schema describes, and none the list names is missing", () => {
  assert.deepEqual([...keyTableProblems(README), ...missingRowProblems(README)], []);
});

test("a key the list names with no row in the table is named", () => {
  const table = ["| key | |", "| --- | --- |", "| [`tickets.max`](src/ticket-mode/config-schema.ts) | |"];
  assert.ok(missingRowProblems(table.join("\n")).includes("README.md: tickets.port has no row in the key table"));
  assert.ok(!missingRowProblems(table.join("\n")).includes("README.md: tickets.max has no row in the key table"));
});

test("a row that describes its key in the table is named by its line", () => {
  const table = ["| key | |", "| --- | --- |", "| [`tickets.max`](src/ticket-mode/config-schema.ts) | `3` workers at once |"];
  assert.deepEqual(keyTableProblems(table.join("\n")), ["README.md:3: tickets.max carries text beyond its key cell"]);
});

test("a key cell that is not a schema link, an unknown key and a repeated key each name their row", () => {
  const table = (...rows: string[]) => ["| key | |", "| --- | --- |", ...rows].join("\n");
  const link = (key: string) => `| [\`${key}\`](src/ticket-mode/config-schema.ts) | |`;
  assert.deepEqual(keyTableProblems(table("| `tickets.max` | |")), ["README.md:3: the key cell is not a link to src/ticket-mode/config-schema.ts: `tickets.max`"]);
  assert.deepEqual(keyTableProblems(table(link("tickets.nope"))), ["README.md:3: tickets.nope is not a key the schema describes"]);
  assert.deepEqual(keyTableProblems(table(link("tickets.max"), link("tickets.max"))), ["README.md:4: tickets.max is already in a row"]);
});
