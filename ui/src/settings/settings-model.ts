// module: what the Settings pages decide from the instance's view -- which rows a page draws, what a staged edit is, and the words a banner says -- with no React and no browser
//
// THE PAGE DRAWS WHAT THE SERVER RETURNS. The page a row is on (`row.page`) comes from `settingsPageOf` in `settings-view.ts`; the words of a refusal, of what is in force and of a
// dangerous key are the backend's. What is here is only the choosing between them.
import type { Change, EditFile, SettingsPreview, SettingsRestored, SettingsSaved, SettingsView } from "../api/types.ts";
import { searchGroups } from "../../../src/ticket-mode/settings-search.ts";
import type { Row, SettingsPage } from "../../../src/ticket-mode/settings-view.ts";

/** The subtitle each page of the split has under its h1, as the boards word it. */
export const PAGE_WORDS: Readonly<Record<SettingsPage, string>> = {
  models: "Which model and effort each kind of work runs on.",
  workers: "How many runs work at once, and how workers open pull requests.",
  machine: "Tools and paths on the machine this instance runs on.",
};

/** The sentence `saveEdit` refuses a save with when the file changed since the page read it (`base`). A node test holds it to the backend's, so the two cannot drift. */
export const CONFLICT_SENTENCE = "the file changed since you looked: read it again";

/** A refusal that is the conflict, told apart from any other by its sentence: both are the same refusal to the client. */
export const isConflict = (refusal: string): boolean => refusal === CONFLICT_SENTENCE;

/** The files a Settings edit changes. `choice.json` is never one: its keys are the Models page's own controls. */
export const EDIT_FILES: readonly EditFile[] = ["host.json", "project.json"];

/** The rows the page's own controls stand for (the model and effort selects, and Workers at once), which are not drawn again as host-file rows. */
export const isControlRow = (row: Row): boolean => row.file === "choice.json" || row.key === "tickets.max";

/** Every row of the view that a person may edit in place, whatever page it is on: what a staged edit is made from. */
export const editableRows = (view: SettingsView): Row[] => view.groups.flatMap((group) => group.rows).filter((row) => row.editable && row.input !== null && !isControlRow(row));

/** One group of rows as a page draws it. */
export type RowGroup = Readonly<{ group: string; rows: readonly Row[] }>;

/** The groups of the page's rows, in the view's order, without the rows its controls stand for. A group with no row of this page is left out. */
export function pageGroups(view: SettingsView, page: SettingsPage): RowGroup[] {
  return view.groups
    .map(({ group, rows }) => ({ group, rows: rows.filter((row) => row.page === page && !isControlRow(row)) }))
    .filter(({ rows }) => rows.length > 0);
}

/** A setting is set when the file holds it, or it is a provider's line, which every group shows. A default is what the page shows only when asked. */
const isSet = (row: Row): boolean => row.state === "enabled" || row.state === "disabled" || row.key.endsWith(".provider");

/** What a search leaves: the rows that match the query, and, with no query, those that matter now (`inUse`) and are set, or all of them while defaults are shown. */
export function visibleGroups(groups: readonly RowGroup[], { query, showDefaults }: Readonly<{ query: string; showDefaults: boolean }>): RowGroup[] {
  const searching = query !== "";
  const matching = new Set(searchGroups(groups, query).flatMap((group) => group.rows.map((row) => row.key)));
  const shown = (row: Row): boolean => matching.has(row.key) && (searching || (row.inUse && (showDefaults || isSet(row))));
  // A setting inside a role or routing block brings that block's row along, so the match reads in place.
  const visible = groups.map(({ group, rows }) => ({ group, rows: rows.filter(shown) }));
  const holders = new Set(visible.flatMap(({ rows }) => rows.map((row) => row.nest)));
  return visible
    .map(({ group, rows: found }, index) => ({ group, rows: groups[index].rows.filter((row) => found.includes(row) || holders.has(row.key)) }))
    .filter(({ rows }) => rows.length > 0);
}

/** What the search line says: nothing without a query, else how many settings match, or that none does. */
export function searchWords(query: string, matching: number): string {
  if (query === "") return "";
  if (matching === 0) return "No setting matches";
  return `${matching} ${matching === 1 ? "setting matches" : "settings match"}`;
}

/** How many rows a search matches, not counting the rows brought along for context. */
export const matchCount = (view: SettingsView, page: SettingsPage, query: string): number => searchGroups(pageGroups(view, page), query).reduce((count, { rows }) => count + rows.length, 0);

/** The id a row's draft and staged change are kept under: a key is one file's. */
export const idOf = (row: Pick<Row, "file" | "key">): string => `${row.file}|${row.key}`;

/** What a person has typed, by row id. A row with no entry shows what the file holds. */
export type Drafts = Readonly<Record<string, string>>;

/** The text a row's input shows when nothing has been typed: a switch's `true` or `false` (its default while the file does not hold it), else the file's value as the input takes it. */
export function baselineOf(row: Row): string {
  if (row.input === "boolean") return (row.raw ?? row.default) === "true" ? "true" : "false";
  return row.raw ?? "";
}

/** A change staged on a row: the row it is on, and the request that would make it. */
export type Staged = Readonly<{ id: string; file: EditFile; row: Row; change: Change }>;

/** The staged changes of the typed drafts, and, for a draft that does not read, what is wrong with it (said on its row, and not staged). */
export type Staging = Readonly<{ staged: readonly Staged[]; problems: Readonly<Record<string, string>> }>;

type Read = Readonly<{ change: Change }> | Readonly<{ problem: string }>;

/** What a draft of a row comes to: the change it makes, or why it does not read. An emptied text, number or JSON field returns the key to its default (`remove`). */
function readDraft(row: Row, draft: string): Read {
  if (row.input === "boolean") return { change: { key: row.key, value: draft === "true" } };
  if (draft.trim() === "" && row.input !== "text") return { change: { key: row.key, remove: true } };
  if (row.input === "number") return Number.isNaN(Number(draft)) ? { problem: `${row.key} needs a number` } : { change: { key: row.key, value: Number(draft) } };
  if (row.input === "json") {
    try {
      return { change: { key: row.key, value: JSON.parse(draft) as unknown } };
    } catch (error) {
      return { problem: `${row.key} needs JSON, such as a list or an object: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return draft === "" ? { change: { key: row.key, remove: true } } : { change: { key: row.key, value: draft } };
}

/**
 * The staged changes: every row whose draft differs from what the file holds. `settled` are the drafts a save has just sent, by id: while a row's draft is still that text it is not staged, though
 * the page has not yet read the file it was saved to. Typing in the row again stages it as any other.
 */
export function stagingOf(rows: readonly Row[], drafts: Drafts, settled: Drafts): Staging {
  const staged: Staged[] = [];
  const problems: Record<string, string> = {};
  for (const row of rows) {
    const id = idOf(row);
    const draft = drafts[id];
    if (draft === undefined || draft === baselineOf(row) || settled[id] === draft) continue;
    const read = readDraft(row, draft);
    if ("problem" in read) problems[id] = read.problem;
    else if (row.file !== "choice.json") staged.push({ id, file: row.file, row, change: read.change });
  }
  return { staged, problems };
}

/** The staged changes of one file. */
export const stagedIn = (staged: readonly Staged[], file: EditFile): Staged[] => staged.filter((entry) => entry.file === file);

/** The files with a staged change, in the order the files are listed. */
export const filesStaged = (staged: readonly Staged[]): EditFile[] => EDIT_FILES.filter((file) => staged.some((entry) => entry.file === file));

/** "2 unsaved changes". */
export const unsavedWords = (count: number): string => `${count} unsaved ${count === 1 ? "change" : "changes"}`;

/** A sentence the backend words in lower case as it starts one: "in force now." read as the first words of a line. */
export const sentenceOf = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/** The changes of a preview that a save would make, and so the ones that are confirmed by name when dangerous. */
export const dangerousIn = (preview: SettingsPreview): string[] => preview.changes.filter((change) => change.dangerous !== null && change.changed).map((change) => change.key);

/** The file name of a path: the backup's path as the save answers it, shown as the boards show it, `host.json.bak`. */
export const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** The distinct in-force sentences of the changes a save made, each once, in the order the changes are. */
export function inForceOfSaved(saved: SettingsSaved): string[] {
  return [...new Set(saved.changes.filter((change) => change.changed).map((change) => sentenceOf(change.inForce)))];
}

/** What a restore changed, in the words today's page says it: each change as `key: old → new. in force`, or that nothing differed. */
export function restoredWords(restored: SettingsRestored): string {
  const changes = restored.changes.map((change) => `${change.key}: ${change.old} → ${change.new}. ${sentenceOf(change.inForce)}`).join(" ");
  return `Restored ${restored.file} from its backup. ${changes === "" ? "Nothing differed." : changes}`;
}

/** The heading of a banner for a save the readers refuse. */
export const refusedHeading = (file: EditFile): string => `Not saved. The ${file === "project.json" ? "project" : "host"} file would be refused.`;

/** The sentence a remote instance's files carry in place of an edit: today's, naming the instance as the switcher does. */
export const remoteNote = (label: string): string => `This instance is ${label}. Its files are changed on that machine, so this page offers no edit here.`;
