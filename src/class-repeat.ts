// @ts-check
// module: the class-repeat facts -- which failure classes have a SECOND closed row, read from the index and the tracker (#4126, child B of #4122)
//
// A CLASS is a way the org fails that has happened more than once; its definition (`id`, `name`, `guard`) is a row of the project's
// `.agent-org/failure-classes.json`, and an INSTANCE is a CLOSED row carrying the label `class:<id>`. The gate COUNTS labels, so no
// model judges membership, and a defect pull request never edits the index. A second closed row under one class is a repeat, and a
// repeat means the guard failed. `org-health.ts` turns what this file reads into the `class-repeat` signal.
//
// A LEAF: it imports no org-health or work-gate name (the signal's name and the order text live there), so both can import it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_LEDGER_FILE, UNCLASSIFIED_KIND, UNIDENTIFIED_CALLER_KIND, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { stateEntryPath } from "./host-config.ts";
import { HOME_CHECKOUT } from "./project-config.ts";

/** Where the index lives under the project checkout. */
export const FAILURE_CLASSES_PATH = ".agent-org/failure-classes.json";
/** The label an instance carries; what follows it is the class id. */
export const CLASS_LABEL_PREFIX = "class:";
/**
 * HOW LONG A REPEAT STAYS OFFERED, and it is what makes the offer ONE offer. A closed row stays closed, so the condition "two rows under one class"
 * never clears by itself, and an order for a condition that stands would be re-sent every two hours until `MAX_DELIVERIES`. The repeat is therefore
 * offered only while its NEWEST instance closed within this window, and the discriminator names that instance: the same newest row is the same key,
 * and a third row is a new key and a new offer. STRICTLY UNDER `wake.ts`'s `JUDGMENT_TTL_MS` (two hours), as `ANSWER_GIVEN_WINDOW_MS` is and for the
 * same reason: past the TTL the ledger would send the same key a second time. The price is that a gate that did not tick for this long misses the offer.
 */
export const CLASS_REPEAT_WINDOW_MS = 90 * 60 * 1000;

const RECENT_CLOSED_WINDOW = 100;
const CLASS_ROWS_WINDOW = 100;
const MAX_REASON_CHARS = 160;
/** What `gh` is asked to keep of each row: the raw `issues` listing carries every body, which this never reads. */
const ROW_PROJECTION = "[.[] | {number, state, closed_at, pull_request: (.pull_request != null), labels: [.labels[].name]}]";

export type FailureClass = { id: string, name: string, guard: string | null, guardNote: string | null };
/** a CLOSED row and the class ids its `class:` labels name; `closedAt` is epoch ms */
export type ClassRow = { number: number, closedAt: number | null, classes: string[] };
/** a ledger kind seen with two or more DISTINCT refs (`repeatsIn`), `refs` oldest first, and when the newest of them was recorded (epoch ms) */
export type LedgerRepeat = { classKey: string, refs: string[], newestAt: number };
/** What one class's filing came to: the row it was filed as (`filed`) and the occurrence that row covers (`covers`, see `newestOccurrence`), or the reason `row-file` refused */
export type Filing = { filed: string, covers: string } | { refused: string };
/**
 * `unreadable` is a refused read of the labels or the file and says why: it is never "no repeats". `ledger` is the failure ledger's repeats (#4450), or `{ unreadable }` for a ledger
 * that is there and cannot be read; OMITTED when the caller does not ask. `filings` is what `fileClassRepeats` did this tick, by class id; OMITTED when the caller files nothing.
 */
export type ClassRepeatFact = { index: FailureClass[], rows: ClassRow[], ledger?: LedgerRepeat[] | { unreadable: string }, filings?: Record<string, Filing> } | { unreadable: string };

/** @param {unknown} err @returns {string} */
const firstLine = (err: unknown): string => String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS);

/**
 * THE INDEX, parsed. `null` is text that is not an index (a bad parse, no `classes` list, an entry without a string `id`): a stated gap, since an index
 * read as empty would call every class label an unknown class.
 * @param {string} text @returns {FailureClass[] | null}
 */
export function parseFailureClasses(text: string): FailureClass[] | null {
  try {
    const classes = JSON.parse(text)?.classes;
    if (!Array.isArray(classes) || !classes.every((c) => typeof c?.id === "string" && c.id !== "")) return null;
    return classes.map((c) => ({ id: c.id, name: String(c.name ?? ""), guard: typeof c.guard === "string" ? c.guard : null,
      guardNote: typeof c.guardNote === "string" ? c.guardNote : null }));
  } catch {
    return null;
  }
}

/**
 * ONE CLOSED ROW PER GITHUB LISTING ENTRY THAT IS ONE: a pull request is in the `issues` listing too, and an open row is never an instance -- the
 * class step happens before a row closes (child A), so the count is of what was closed. Filtered here as well as in the query, because a fake that
 * answers every query would otherwise count an open row. `null` is an entry that is not the projection's shape.
 * @param {any} entry @returns {ClassRow | null | "skip"}
 */
function rowOf(entry: any): ClassRow | null | "skip" {
  if (typeof entry?.number !== "number" || !Array.isArray(entry.labels)) return null;
  if (entry.pull_request === true || entry.state !== "closed") return "skip";
  const classes = entry.labels.filter((l: unknown) => typeof l === "string" && l.startsWith(CLASS_LABEL_PREFIX)).map((l: string) => l.slice(CLASS_LABEL_PREFIX.length));
  const closedAt = Date.parse(entry.closed_at);
  return { number: entry.number, closedAt: Number.isFinite(closedAt) ? closedAt : null, classes };
}

/**
 * @param {string} text the projected listing @returns {ClassRow[] | null} the closed rows carrying a `class:` label, `null` for text that is not a listing
 */
function parseRows(text: string): ClassRow[] | null {
  try {
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) return null;
    const rows = entries.map(rowOf);
    if (rows.includes(null)) return null;
    return (rows.filter((r) => r !== null && r !== "skip" && r.classes.length > 0) as ClassRow[]);
  } catch {
    return null;
  }
}

/**
 * @param {(args: string[]) => string} run @param {string} repo @param {string | null} classId the class to list ALL closed instances of, or `null` for the newest-updated closed rows
 * @returns {ClassRow[] | null}
 */
function listClosed(run: (args: string[]) => string, repo: string, classId: string | null): ClassRow[] | null {
  const perPage = classId === null ? RECENT_CLOSED_WINDOW : CLASS_ROWS_WINDOW;
  const label = classId === null ? [] : ["-f", `labels=${CLASS_LABEL_PREFIX}${classId}`];
  return parseRows(run(["api", "--method", "GET", `repos/${repo}/issues`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", `per_page=${perPage}`,
    ...label, "--jq", ROW_PROJECTION]));
}

/**
 * THE FACT FOR THE `class-repeat` SIGNAL: the index, then ONE REST CALL on the core pool for the newest-updated closed rows (every tick), then ONE MORE PER
 * CLASS whose newest instance closed inside the window (`CLASS_REPEAT_WINDOW_MS`), to count that class's instances over all time. A class with no
 * recent instance cannot be offered this tick, so it is not listed: `gh` cannot filter a label PREFIX, and listing every class each tick would be one call
 * per class for nothing. NEVER THROWS: a refused call, an unparseable listing or a missing index is `{ unreadable }`, a stated unknown.
 * @param {(args: string[]) => string} run @param {string} repo @param {ClassRepeatIo} [io]
 * @returns {ClassRepeatFact}
 */
function readClosedRowRepeats(run: (args: string[]) => string, repo: string, { root = HOME_CHECKOUT, read = (path) => readFileSync(path, "utf8"), now = Date.now() }: ClassRepeatIo = {}): ClassRepeatFact {
  let index;
  try {
    index = parseFailureClasses(read(join(root, FAILURE_CLASSES_PATH)));
  } catch (err) {
    return { unreadable: `${FAILURE_CLASSES_PATH} could not be read (${firstLine(err)})` };
  }
  if (index === null) return { unreadable: `${FAILURE_CLASSES_PATH} is not a failure-class index (no \`classes\` list of entries with an \`id\`)` };
  try {
    const recent = listClosed(run, repo, null);
    if (recent === null) return { unreadable: `the closed rows of ${repo} could not be read as a listing` };
    const byNumber = new Map(recent.map((row) => [row.number, row]));
    const inWindow = recent.filter((row) => row.closedAt !== null && now - row.closedAt <= CLASS_REPEAT_WINDOW_MS);
    const known = new Set(index.map((c) => c.id));
    for (const id of new Set(inWindow.flatMap((row) => row.classes).filter((c) => known.has(c)))) {
      const all = listClosed(run, repo, id);
      if (all === null) return { unreadable: `the closed rows labelled ${CLASS_LABEL_PREFIX}${id} could not be read as a listing` };
      for (const row of all) byNumber.set(row.number, row);
    }
    return { index, rows: [...byNumber.values()] };
  } catch (err) {
    return { unreadable: `the closed rows of ${repo} could not be read (${firstLine(err)})` };
  }
}

/**
 * What a caller may inject. EVERY FIELD AFTER `now` IS OPT-IN AND ABSENT MEANS NOT DONE: with none of them the fact is the closed-row fact of #4126 and nothing is read or written beyond it,
 * so a test that reads a fake tracker cannot read the host's ledger or file a row. The live gate asks for all of them through `liveClassRepeatIo`.
 * `ledgerPath` is `failure-ledger` (#4450); `fileRow` runs `row-file` with an argv and returns what it printed, THROWING on a refusal; `statePath` is where a filed class is remembered.
 */
export type ClassRepeatIo = {
  root?: string, read?: (path: string) => string, now?: number,
  ledgerPath?: string, readLedger?: (path: string) => string, fileRow?: (argv: string[]) => string, statePath?: string, session?: string, log?: (line: string) => void,
};

/**
 * THE FACT FOR THE `class-repeat` SIGNAL (#4126, #4451): the closed rows (`readClosedRowRepeats`), then, when asked, the ledger's repeats beside them, then, when a filer is given, the row
 * each repeating class is filed as (`fileClassRepeats`). NEVER THROWS, as the closed-row read does not: a ledger that cannot be read is `{ unreadable }` inside the fact.
 * @param {(args: string[]) => string} run @param {string} repo @param {ClassRepeatIo} [io]
 * @returns {ClassRepeatFact}
 */
export function readClassRepeat(run: (args: string[]) => string, repo: string, io: ClassRepeatIo = {}): ClassRepeatFact {
  const closed = readClosedRowRepeats(run, repo, io);
  if ("unreadable" in closed) return closed;
  const { now = Date.now(), ledgerPath, readLedger = (path: string) => readFileSync(path, "utf8") } = io;
  const withLedger = ledgerPath === undefined ? closed : { ...closed, ledger: readLedgerRepeats({ ledgerPath, read: readLedger, now }) };
  return io.fileRow === undefined ? withLedger : { ...withLedger, filings: fileClassRepeats(withLedger, { run, repo, ...io, fileRow: io.fileRow, now }) };
}

/**
 * `rows` newest first (by close time, then by number); `entry` is `null` for a label naming no class. `events` are the distinct refs the failure ledger holds for the class, oldest first,
 * and `eventsNewestAt` when the newest was recorded (`null` when there are none): an event is an occurrence that never became a row (#4450).
 */
export type ClassGroup = { id: string, entry: FailureClass | null, rows: ClassRow[], events: string[], eventsNewestAt: number | null };

/** The ledger keys that COUNT orders (`prompt-session.ts`, #4452) and name no failure class; one list, imported from the ledger, not a second spelling. */
const LEDGER_COUNTER_KINDS: ReadonlySet<string> = new Set([UNCLASSIFIED_KIND, UNIDENTIFIED_CALLER_KIND]);

/**
 * EVERY CLASS ID THE ROWS OR THE LEDGER NAME, with its rows newest first. One row under two classes is an instance of each. Membership is the label and, for a ledger kind, the kind's name
 * and nothing else. A ledger repeat of an id no row carries is a group with no rows. A ledger COUNTER (`unclassified`, `unidentified-caller-order`) is no class at all: it is left out, so it is neither a
 * stranger read as `UNKNOWN` every tick nor a candidate for a class row (#4618). A key that is neither indexed nor a counter is still a stranger, which is what the reading is for.
 * @param {FailureClass[]} index @param {ClassRow[]} rows @param {LedgerRepeat[]} [ledger] @returns {ClassGroup[]}
 */
export function groupByClass(index: FailureClass[], rows: ClassRow[], ledger: LedgerRepeat[] = []): ClassGroup[] {
  const byId: Map<string, ClassRow[]> = new Map();
  for (const row of rows) for (const id of new Set(row.classes)) byId.set(id, [...(byId.get(id) ?? []), row]);
  for (const { classKey } of ledger) if (!byId.has(classKey) && !LEDGER_COUNTER_KINDS.has(classKey)) byId.set(classKey, []);
  const newestFirst = (a: ClassRow, b: ClassRow) => ((b.closedAt ?? 0) - (a.closedAt ?? 0)) || b.number - a.number;
  return [...byId].map(([id, group]) => {
    const seen = ledger.find((repeat) => repeat.classKey === id);
    return { id, entry: index.find((c) => c.id === id) ?? null, rows: [...group].sort(newestFirst), events: seen?.refs ?? [], eventsNewestAt: seen?.newestAt ?? null };
  });
}

/** How many occurrences a group holds: its closed rows and its distinct ledger refs. */
export const occurrencesOf = (group: ClassGroup): number => group.rows.length + group.events.length;

/**
 * THE NEWEST OCCURRENCE OF A GROUP, as the time it happened and a key naming it: a closed row's number, or a ledger ref. The key is what an order is discriminated by and what a filed row
 * COVERS, so the same newest occurrence is the same offer and a later one is a new one. A row wins a tie. `at` is `null` for a row with no close time and no event after it.
 */
export function newestOccurrence(group: ClassGroup): { at: number | null, key: string } {
  const [row] = group.rows;
  const rowAt = row?.closedAt ?? null;
  const eventIsNewer = group.eventsNewestAt !== null && (row === undefined || group.eventsNewestAt > (rowAt ?? 0));
  return eventIsNewer ? { at: group.eventsNewestAt, key: group.events[group.events.length - 1] } : { at: rowAt, key: String(row.number) };
}

/**
 * THE LEDGER'S REPEATS (#4450): every kind seen with two or more distinct refs, OVER ALL TIME, as a closed-row count is. The ledger is a file the host keeps: an absent file is a ledger with
 * no events (`[]`), and one that is there and cannot be read is `{ unreadable }`, which is never "no repeats".
 * @param {{ ledgerPath: string, read: (path: string) => string, now: number }} input
 */
function readLedgerRepeats({ ledgerPath, read, now }: { ledgerPath: string, read: (path: string) => string, now: number }): LedgerRepeat[] | { unreadable: string } {
  try {
    const entries = parseFailureLedger(read(ledgerPath), ledgerPath).filter((entry) => entry.at <= now);
    return repeatsIn(entries, { windowMs: Number.POSITIVE_INFINITY, now }).map(({ classKey, refs }) => ({
      classKey, refs, newestAt: Math.max(...entries.filter((entry) => entry.classKey === classKey).map((entry) => entry.at)),
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return { unreadable: `the failure ledger ${ledgerPath} could not be read (${firstLine(err)})` };
  }
}

// ---- FILING THE CLASS ROW (#4451, move 1b of #4437) ----

/** The milestone a class row is filed under, by the title `row-file --milestone` takes. */
export const CLASS_ROW_MILESTONE = "Self-healing org";
/** Where a filed class is remembered between ticks (each tick is a fresh process): `{ [classId]: { row, covers, at } }`. */
const FILED_CLASSES_STATE = "class-repeat-filed.json";
/** The session a class row is filed as: the gate that found the repeat. */
const FILER_SESSION = "work-gate";
/** Why `row-file` may run from the primary checkout the gate lives in: `launchGate` prints this, so the exception is in the log and not in somebody's memory. */
const LAUNCH_REASON = "class-repeat files the class row from the gate's own checkout (a11ign/a11ign#4451)";
const CLASS_LABEL_DESCRIPTION = "Closed rows carrying this label are instances of one failure class (.agent-org/failure-classes.json)";
const MAX_TITLE_CHARS = 120;

type Remembered = Record<string, { row: string, covers: string, at: string }>;

/** `row-file` as a program: the gate runs from the primary checkout, which `row-file` refuses without the printed override. Throws with `row-file`'s own stderr on a refusal. */
export function runRowFile(argv: string[]): string {
  const program = fileURLToPath(new URL("./row-file.ts", import.meta.url));
  return execFileSync(process.execPath, [program, ...argv], { encoding: "utf8", env: { ...process.env, A11Y_POLICY_LAUNCH_REASON: LAUNCH_REASON }, stdio: ["ignore", "pipe", "pipe"] });
}

/** What the live gate passes `readClassRepeat` to read the ledger and file class rows. Beside it and not defaulted into it: see `ClassRepeatIo`. */
export function liveClassRepeatIo(): ClassRepeatIo {
  return { ledgerPath: stateEntryPath(FAILURE_LEDGER_FILE), fileRow: runRowFile, statePath: stateEntryPath(FILED_CLASSES_STATE) };
}

/** The line `primaryLaunchDecision` prints before `row-file` does anything, when the gate runs from the primary checkout: it says the launch was allowed, never why a filing was refused. */
const LAUNCH_NOTICE = /launched outside a linked worktree, proceeding anyway/;

/**
 * The reason a refused `row-file` gave: the first line of its stderr that is not the launch-override notice (`execFileSync` puts the whole stderr in the message). The notice is always
 * first from the gate's checkout, so reading the first line logged every real refusal as "proceeding anyway" and sent a reader to a worktree rule that was already satisfied (#4615).
 * When the notice is all it wrote, that is said rather than the notice; with no stderr at all, the error's first line.
 */
function refusalOf(err: unknown): string {
  const lines = String((err as { stderr?: unknown })?.stderr ?? "").split("\n").filter((line) => line.trim() !== "");
  const reason = lines.find((line) => !LAUNCH_NOTICE.test(line));
  if (reason !== undefined) return reason.trim().slice(0, MAX_REASON_CHARS);
  if (lines.length === 0) return firstLine(err);
  return `row-file refused and wrote nothing after the launch notice (exit status ${(err as { status?: unknown })?.status ?? "unknown"})`;
}

/** The row number a successful `row-file` printed (its last line is the new row's URL), else the line itself so the memory is never empty. */
function rowFiledAs(output: string): string {
  const last = output.trim().split("\n").pop() ?? "";
  const number = /\/issues\/(\d+)\s*$/.exec(last)?.[1];
  return number === undefined ? last.slice(0, MAX_REASON_CHARS) || "(row-file printed nothing)" : `#${number}`;
}

/** An occurrence as a line of the row's body: a closed row links itself, a ledger ref is quoted. */
const occurrenceLines = (group: ClassGroup): string[] => [
  ...group.rows.map((row) => `- #${row.number}${row.closedAt === null ? "" : ` (closed ${new Date(row.closedAt).toISOString()})`}`),
  ...group.events.map((ref) => `- failure ledger \`${group.id}\`: ${ref}`),
];

/**
 * The `node -e` that is true once the class has a guard that is not the one it had when it repeated: a guard that is `null` must be set, and one that is set (a repeat inside the window
 * means it failed) must be replaced, which is what "the guard failed" asks. The old guard is carried as its sha1, so no quoting of free text reaches the shell.
 */
export function guardChangedCommand(group: ClassGroup): string {
  const was = createHash("sha1").update(String(group.entry?.guard ?? null)).digest("hex");
  return `node -e "const c=JSON.parse(require('node:fs').readFileSync('${FAILURE_CLASSES_PATH}','utf8')).classes.find((c)=>c.id==='${group.id}'); `
    + `const h=require('node:crypto').createHash('sha1').update(String(c.guard)).digest('hex'); process.exit(c.guard!==null&&h!=='${was}'?0:1)"`;
}

/** The body of the class row. It states what is known and asks for the one thing only a human-grade fix can do: a guard that stops the class EVERYWHERE. */
export function classRowBody(group: ClassGroup): string {
  const entry = group.entry as FailureClass;
  const guard = entry.guard ?? `none in force (${entry.guardNote ?? "the index says nothing more"})`;
  const command = guardChangedCommand(group);
  return [
    "## What it is", "",
    `Failure class \`${group.id}\` (${entry.name}) has now happened ${occurrencesOf(group)} times, and a second occurrence means its guard failed (or was never in force). Its guard: ${guard}.`,
    "Filed by the work gate the tick the second occurrence was seen (a11ign/a11ign#4451, move 1b of #4437); nobody has to remember to.", "",
    "## Occurrences", "", ...occurrenceLines(group), "",
    "## Region", "", "```", FAILURE_CLASSES_PATH, "```", "",
    "## Change", "",
    "Find why the guard did not stop this occurrence, and put a detector or rule in force that stops the class EVERYWHERE, not only where it was last seen. Then set `guard` in the index (and clear `guardNote`).", "",
    "## Acceptance", "", "```bash", command, "```", "",
    "## Done-when", "", `1. The Acceptance passes and the pull request is merged.`, "",
    "## Open-check", "", "```", `$ ${command}`, "(no output: exit 1, the guard is still the one that failed)", "```", "",
    "## Fleet", "", "No.", "",
  ].join("\n");
}

/** The title is stable per class, so `row-file`'s own refusal of a title an OPEN row already has backs up the memory if the memory is lost. */
const classRowTitle = (group: ClassGroup): string => `Failure class ${group.id} repeated: make its guard stop it everywhere`.slice(0, MAX_TITLE_CHARS);

/**
 * The argv `row-file` is given for one class: a defect (so the closing pull request owes a `Class:` line), in the self-healing milestone, labelled with the class.
 * `--tracker=` (the home tracker's key is the empty string) because the body's Region is the index under `.agent-org/`, which `rowTracker` reads as an org row and files in a11ign/agent-org,
 * where neither the milestone nor the class labels exist: the create was refused every tick (#4615).
 */
export function classRowArgv(group: ClassGroup, session: string = FILER_SESSION): string[] {
  return ["--kind", "defect", "--tracker=", "--milestone", CLASS_ROW_MILESTONE, "--label", `${CLASS_LABEL_PREFIX}${group.id}`, `--session=${session}`, "--title", classRowTitle(group), "--body", classRowBody(group)];
}

/** Whether a repeat is worth a row THIS tick: a class with no guard always (it is filed once and remembered), one with a guard only while the repeat is fresh, as the order is. */
function worthFiling(group: ClassGroup, now: number): boolean {
  const { at } = newestOccurrence(group);
  return occurrencesOf(group) >= 2 && group.entry !== null && (group.entry.guard === null || (at !== null && now - at <= CLASS_REPEAT_WINDOW_MS));
}

/** @returns what the memory file holds; an absent file is an empty memory and an unreadable one is REPORTED and read as empty (the next filing is then refused as a duplicate title if the row is open) */
function readRemembered(statePath: string, log: (line: string) => void): Remembered {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") log(`class-repeat: ${statePath} is unreadable (${firstLine(err)}); a class already filed may be filed again (#4451)\n`);
    return {};
  }
}

/** Remember what was filed. A refused write is REPORTED: the next tick then files the class again, and `row-file` refuses a title an open row has. */
function writeRemembered(statePath: string, remembered: Remembered, log: (line: string) => void): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const scratch = `${statePath}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(remembered));
    renameSync(scratch, statePath);
  } catch (err) {
    log(`class-repeat: could not remember the filed classes in ${statePath} (${firstLine(err)}); the next tick files them again (#4451)\n`);
  }
}

type FilingIo = { run: (args: string[]) => string, repo: string, fileRow: (argv: string[]) => string, now: number, statePath?: string, session?: string, log?: (line: string) => void };

/** File ONE class: make sure its label exists (a ledger kind has no closed row, so no label yet), then `row-file`. A refusal at either step is the filing's `refused`. */
function fileOne(group: ClassGroup, { run, repo, fileRow, session }: Pick<FilingIo, "run" | "repo" | "fileRow" | "session">): Filing {
  try {
    run(["label", "create", `${CLASS_LABEL_PREFIX}${group.id}`, "--repo", repo, "--force", "--description", CLASS_LABEL_DESCRIPTION]);
    return { filed: rowFiledAs(fileRow(classRowArgv(group, session))), covers: newestOccurrence(group).key };
  } catch (err) {
    return { refused: refusalOf(err) };
  }
}

/**
 * FILE THE CLASS ROW OF EVERY CLASS THAT HAS REPEATED, ONCE (#4451, move 1b of #4437). A class repeats at its second occurrence, a closed row or a ledger ref, and is worth a row when it has no guard or
 * the repeat is inside `CLASS_REPEAT_WINDOW_MS`. A class already in the memory file is NOT filed again whatever happened since, which is what makes it one row per class; its entry says which occurrence it
 * covered, so a later one is still offered to `ceo`. A class is remembered only after `row-file` LANDED: a refusal is returned as `refused`, remembered nowhere, and retried next tick. NEVER THROWS.
 * Without a `statePath` nothing is remembered, so nothing is filed: a filer that cannot remember would file the class every tick.
 * @param {{ index: FailureClass[], rows: ClassRow[], ledger?: LedgerRepeat[] | { unreadable: string } }} fact @param {FilingIo} io
 * @returns {Record<string, Filing>} by class id, for every repeating class that has a row or was tried
 */
export function fileClassRepeats(fact: { index: FailureClass[], rows: ClassRow[], ledger?: LedgerRepeat[] | { unreadable: string } }, io: FilingIo): Record<string, Filing> {
  const { statePath, log = (line) => process.stderr.write(line), now } = io;
  if (statePath === undefined) return {};
  const groups = groupByClass(fact.index, fact.rows, Array.isArray(fact.ledger) ? fact.ledger : []).filter((group) => group.entry !== null && occurrencesOf(group) >= 2);
  const remembered = readRemembered(statePath, log);
  const filings: Record<string, Filing> = {};
  let landed = false;
  for (const group of groups) {
    const kept = remembered[group.id];
    if (kept !== undefined) filings[group.id] = { filed: kept.row, covers: kept.covers };
    else if (worthFiling(group, now)) filings[group.id] = fileOne(group, io);
    const outcome = filings[group.id];
    if (kept === undefined && outcome !== undefined && "filed" in outcome) {
      remembered[group.id] = { row: outcome.filed, covers: outcome.covers, at: new Date(now).toISOString() };
      log(`class-repeat: filed class ${group.id} as ${outcome.filed} (#4451)\n`);
      landed = true;
    } else if (outcome !== undefined && "refused" in outcome) log(`class-repeat: could not file class ${group.id}: ${outcome.refused} (#4451)\n`);
  }
  if (landed) writeRemembered(statePath, remembered, log);
  return filings;
}
