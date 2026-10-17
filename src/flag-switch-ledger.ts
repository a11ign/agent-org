// module: the flags the code ships OFF that nobody set -- the "merged but off" count (agent-org#1135, class `hand-reroute`, parent a11ign#4437)
//
// CODE MERGED BEHIND A FLAG IS OFF WHEN THE FLAG IS ABSENT, AND NOTHING NOTICED THAT A11IGN NEVER SET IT. Four times in two days: `routing.question` (a11ign#4953), the scheduler identity
// (a11ign#4906), the Haiku flags (a11ign#5138) and `rows.autoUnpark` (a11ign#5194) each shipped, each stayed off, and each was found by a human flipping the switch hours later
// (a11ign#5041, #5139 and #5195 are the three genuine `hand-reroute` events of the ledger's 36). The chairman's rule (a11ign#928, 2026-10-12) is that a flagged change ships with
// its a11ign switch row, filed at the same time; it is a rule `product-manager` reads at filing, and "org-health counts violations" had no code behind it. THIS IS THE COUNT.
//
// THE REGISTRY IS THE CODE'S OWN, as `machinery-flag.ts` uses it: every `export const <NAME>_FLAG = "<group>.<name>"` in a non-test file of `src/`. A flag is DECIDED when its dotted key
// is a boolean in one of the project's declaration files, under `.agent-org/` (`project.json`, `decisions.json`, `seats.json`) or the host's (`host.json`), written either nested
// (`{ "workers": { "haikuBrief": false } }`) or flat (`{ "routing.haikuDefault": true }`), the two shapes the declarations already carry. `false` IS A DECISION: a flag the org looked at
// and left off is not the violation, and ABSENT is. No a11ign row is required to exist -- the declaration is what the code reads, and a row is only the means of writing it.
//
// A DECLARATION THAT CANNOT BE READ MAKES THE WHOLE ANSWER UNKNOWN, never a list: a flag looked for in a file that did not parse would be reported unset on no evidence, which is a false
// work list handed to the one session that acts on it. An OPTIONAL file that is simply not there (`seats.json` in a project with no seats) holds no key and is not a fault; `project.json` and `host.json` are required, and a missing one is a wrong path, which is unknown too.
//
// THE CANARY HALF (agent-org#1324): a flag whose other home is the canary state is decided there, not in a declaration, so the same count reads `machinery-canary.json` through
// `org-health.ts`'s `parseCanaryState` (the reader `machinery-flag.ts` uses). A flag ABSENT from that state, merged more than two hours before the read, and named by no open row
// in a `ready` or `in-progress` state is the sixth merged-but-off kind of finding. The rows are the home repository's AND the other declared trackers' (agent-org#1372: a
// switch row for code that lives in agent-org is filed there), the other trackers read only when the home rows name no such flag. An unreadable state, or a read of the open rows that did not happen, is UNKNOWN.
//
// A LEAF: it reads files, one `git log` per unset flag and the ticket port's by-label read of the other trackers, and runs no tick; `org-health.ts` turns its answer into a reading. The canary half imports `org-health.ts` at runtime,
// which is safe because `org-health.ts` imports this module as a type only.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { hostConfigPath, stateEntryPath } from "./host-config.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { CLAIM_LABEL, READY_LABEL } from "./claim-labels.ts";
import { CANARY_STATE_FILE, emptyCanaryState, parseCanaryState, type CanaryState } from "./org-health.ts";
import { readRowsByLabel } from "./ticket-port/rows-by-label.ts"; // the owed rows are read through the port, so this leaf spawns nothing (`gh-call-ratchet.test.ts`)
import { defaultRun } from "./work-gate/reads.ts"; // the gate's one runner: metered, and an identical read answered once

/** The tool's root by this file's own location (`org-health.ts`'s `TOOL_ROOT`): the registry is read from the code that is running, not from the project's tree. */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The project's declaration files under `.agent-org/`; the host's `host.json` is read from `hostConfigPath()`, which `$AGENT_ORG_HOST` may move. */
export const PROJECT_DECLARATIONS: readonly string[] = Object.freeze(["project.json", "decisions.json", "seats.json"]);
/** The declarations a project may not have: `decisions.json` is absent for a project that switches nothing (`decision-provider.ts` reads absent as off) and `seats.json` for one with no seats. */
const OPTIONAL_DECLARATIONS: readonly string[] = Object.freeze(["decisions.json", "seats.json"]);

/**
 * FLAGS A DECLARATION FILE IS NOT WHERE THEY ARE SWITCHED, each with the reason. These are not exempt from being decided; their decision lives elsewhere, and a missing key in a
 * declaration is no evidence about them. The test pins this map to `machinery-flag.ts`'s `FLAG_REGISTRY`, so a fourth machinery flag is a red test and not a silent entry.
 */
export const FLAGS_WITH_ANOTHER_HOME: Readonly<Record<string, string>> = Object.freeze({
  "queue.reenqueueEjected": "switched by `machinery:flag` (agent-org#1061), which writes the canary state and not a declaration file",
  "queue.reenqueueInfra": "switched by `machinery:flag` (agent-org#1647), which writes the canary state and not a declaration file",
  "queue.chainWaitWake": "switched by `machinery:flag` (agent-org#1061), which writes the canary state and not a declaration file",
  "rows.closedUnderOpenHalf": "switched by `machinery:flag` (agent-org#1061), which writes the canary state and not a declaration file",
  "rows.autoUnpark": "switched by `machinery:flag` (agent-org#1161), which writes the canary state and not a declaration file",
  "queue.queueEntryNoRun": "switched by `machinery:flag` (agent-org#1195), which writes the canary state and not a declaration file",
  "holds.recheck": "switched by `machinery:flag` (agent-org#1187), which writes the canary state and not a declaration file",
  "prune.holdOpenPr": "switched by `machinery:flag` (agent-org#1221), which writes the canary state and not a declaration file",
  "messaging.refuseAskingAnnouncements": "switched by `machinery:flag` (agent-org#1222), which writes the canary state and not a declaration file",
  "gate.graphqlPacing": "switched by `machinery:flag` (agent-org#1240), which writes the canary state and not a declaration file",
  "review.rowReviewSkill": "switched by `machinery:flag` (agent-org#1268), which writes the canary state and not a declaration file",
  "prs.ownerRouting": "switched by `machinery:flag` (agent-org#1325), which writes the canary state and not a declaration file",
  "gate.accountLimitPause": "switched by `machinery:flag` (agent-org#1307), which writes the canary state and not a declaration file",
  "checks.sameHeadRefail": "switched by `machinery:flag` (agent-org#1185), which writes the canary state and not a declaration file",
  "chairman.refusedOnce": "switched by `machinery:flag` (agent-org#1456), which writes the canary state and not a declaration file",
  "prs.ownerlessAsk": "switched by `machinery:flag` (agent-org#1648), which writes the canary state and not a declaration file",
  "gh.refuseFallbackAuthor": "switched by `machinery:flag` (agent-org#1666), which writes the canary state and not a declaration file",
  "reviews.verdictDelivery": "switched by `machinery:flag` (agent-org#1649), which writes the canary state and not a declaration file",
});

/** `export const AUTO_UNPARK_FLAG = "rows.autoUnpark"`: the shape the row's open-check greps, with a digit allowed after the first letter so `queue.reenqueue2` is not skipped. */
const FLAG_DECLARATION = /^export const ([A-Z][A-Z0-9_]*_FLAG)(?::\s*string)?\s*=\s*"([a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)"/gm;

export type ShippedFlag = { name: string; key: string; file: string; };
export type UnsetFlag = ShippedFlag & {
  /** The date of the merge commit on the first-parent line that added the key, or `null` when git could not say (no history, or the file moved). */
  mergedAt: string | null;
  /** That merge's pull request number, or `null` under the same conditions. */
  pr: number | null;
};
/** An open row as `readOpenRows` returns it: the title, the body and the labels by name. */
export type OpenRow = { title: string; body?: string | null; labels?: { name: string; }[]; };
/** A flag that is absent from the canary state, merged more than two hours before the read, and named by no open row. */
export type CanaryAbsentFlag = UnsetFlag;
/**
 * What the tick reads: `unset` is the declaration violation, `canaryAbsent` the canary violation, and `unknown` is a read that could not be made (never an empty list in its place).
 * `canaryAbsent` is optional so a caller that built a ledger by hand, with no canary half, still type-checks.
 */
export type FlagLedger = { shipped: number; unset: UnsetFlag[]; canaryAbsent?: CanaryAbsentFlag[]; } | { unknown: string; };

/** Two hours: the window a merged flag may sit absent from the canary state before the switch row is owed (the row's "2 h"). */
export const CANARY_ABSENT_MS = 2 * 60 * 60 * 1000;
/** The labels of an open row that is still owed its switch: `ready` (not yet claimed) and `in-progress` (claimed). */
const OWED_LABELS: readonly string[] = Object.freeze([READY_LABEL, CLAIM_LABEL]);

/** @returns every non-test `.ts` or `.mjs` under `dir`, as paths relative to `root`; `node_modules` and `fixtures` are not source */
function sourcesUnder(dir: string, root: string, list: (dir: string) => { name: string; directory: boolean; }[]): string[] {
  return list(dir).flatMap(({ name, directory }) => {
    const path = join(dir, name);
    if (directory) return name === "node_modules" || name === "fixtures" ? [] : sourcesUnder(path, root, list);
    return /\.(ts|mjs)$/.test(name) && !name.includes(".test.") ? [relative(root, path)] : [];
  });
}

const listDirectory = (dir: string) => readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));

/**
 * THE FLAGS THE CODE SHIPS: one per `*_FLAG` constant naming a dotted key, sorted by key. A key declared in two files is one flag, named for its first file in path order.
 * @param toolRoot the tool's root, whose `src/` is walked
 * @returns the flags, or `null` when `src/` cannot be listed
 */
export function discoverFlags({ toolRoot = TOOL_ROOT, read = (path) => readFileSync(path, "utf8"), list = listDirectory }: { toolRoot?: string; read?: (path: string) => string; list?: (dir: string) => { name: string; directory: boolean; }[]; } = {}): ShippedFlag[] | null {
  let files: string[];
  try {
    files = sourcesUnder(join(toolRoot, "src"), toolRoot, list).sort();
  } catch {
    return null;
  }
  const byKey = new Map<string, ShippedFlag>();
  for (const file of files) {
    let text: string;
    try {
      text = read(join(toolRoot, file));
    } catch {
      continue; // a file that vanished between the listing and the read holds no flag this tick; the next tick lists it again
    }
    for (const match of text.matchAll(FLAG_DECLARATION)) if (!byKey.has(match[2])) byKey.set(match[2], { name: match[1], key: match[2], file });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** @returns whether `doc` carries `key` as a boolean, nested (`workers` then `haikuBrief`) or flat (`"routing.haikuDefault"`) */
export function declaresKey(doc: unknown, key: string): boolean {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  const top = doc as Record<string, unknown>;
  if (typeof top[key] === "boolean") return true;
  const [group, name] = key.split(".");
  const nested = top[group];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested) && typeof (nested as Record<string, unknown>)[name] === "boolean";
}

/**
 * THE VIOLATION, PURE: the shipped flags that no declaration carries and that have no other home. `false` is carried; a key set to anything but a boolean is not (the readers
 * say "not true or false; it is off" for one), so it is reported rather than taken for a decision.
 * @param declarations each declaration file's parsed document
 */
export function unsetFlags({ shipped, declarations, anotherHome = FLAGS_WITH_ANOTHER_HOME }: { shipped: readonly ShippedFlag[]; declarations: readonly unknown[]; anotherHome?: Readonly<Record<string, string>>; }): ShippedFlag[] {
  return shipped.filter(({ key }) => !Object.hasOwn(anotherHome, key) && !declarations.some((doc) => declaresKey(doc, key)));
}

/** The two git facts of a flag: when the pull request that added its key merged, and which one it was. `null` for both when history does not say. */
export function mergeOf(flag: ShippedFlag, { toolRoot = TOOL_ROOT, run = (args: string[]) => execFileSync("git", args, { cwd: toolRoot, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }) }: { toolRoot?: string; run?: (args: string[]) => string; } = {}): { mergedAt: string | null; pr: number | null; } {
  let out: string;
  try {
    // The first commit on the first-parent line (main's own merges) that changed how often the quoted key occurs in its file: the merge that brought it in, whose subject names the pull request.
    out = run(["log", "--first-parent", "--reverse", "-S", `"${flag.key}"`, "--format=%cI%x09%s", "--", flag.file]);
  } catch {
    return { mergedAt: null, pr: null };
  }
  const [first] = out.split("\n").filter(Boolean);
  if (first === undefined) return { mergedAt: null, pr: null };
  const [date, subject = ""] = first.split("\t");
  const pr = /#(\d+)/.exec(subject)?.[1];
  return { mergedAt: /^\d{4}-\d{2}-\d{2}T/.test(date) ? date : null, pr: pr === undefined ? null : Number(pr) };
}

/**
 * THE CANARY STATE, read the way `machinery-flag.ts` reads it: an absent file is empty (no flag has been switched), and a file that will not parse is UNKNOWN, because a state read
 * wrong would forget a flag that is on and report it absent.
 * @param path the canary state's path, `stateEntryPath(CANARY_STATE_FILE)` by default
 */
export function readCanaryState(path: string): CanaryState | { unknown: string; } {
  try {
    return existsSync(path) ? parseCanaryState(readFileSync(path, "utf8")) : emptyCanaryState();
  } catch (cause) {
    return { unknown: `${path} could not be read (${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}), so no canary switch is known` };
  }
}

/** @returns whether a flag's other home is the canary state, by the reason `FLAGS_WITH_ANOTHER_HOME` gives for it (every entry says so today). */
const canaryHomed = (key: string, anotherHome: Readonly<Record<string, string>>): boolean => Object.hasOwn(anotherHome, key) && /writes the canary state/.test(anotherHome[key]);

/** @returns whether an open row names `key` in its title or body and is still owed its switch (`ready` or `in-progress`); the key is matched whole, so `rows.autoUnpark` is not `rows.autoUnparkX` */
const namesOwedKey = (row: OpenRow, key: string): boolean => (row.labels ?? []).some(({ name }) => OWED_LABELS.includes(name))
  && new RegExp(`(^|[^\\w.])${key.replace(/\./g, "\\.")}(?![\\w.])`).test(`${row.title}\n${row.body ?? ""}`);

/**
 * THE OTHER TRACKERS, from a project declaration: each `tracker` entry's repository except the project's own, which is the one keyed `""`. A document with no list names none.
 * @param doc the parsed `project.json`
 */
export function otherTrackerRepos(doc: unknown): string[] {
  const trackers: unknown = (doc as { tracker?: unknown } | null)?.tracker;
  if (!Array.isArray(trackers)) return [];
  return trackers.flatMap((entry: { key?: unknown; repo?: unknown; } | null) => entry?.key !== "" && typeof entry?.repo === "string" ? [entry.repo] : []);
}

/**
 * THE OWED ROWS OF THE OTHER TRACKERS, read one `label` at a time per repository. A refused list of any one is UNKNOWN, never an empty set: a row that was not read cannot be
 * known to be absent.
 * @param list the open rows of `repo` that carry `label`, or `{ refused }` with the first line of why they could not be read (`liveOwedRows` by default)
 */
export function owedRowsOf(repos: readonly string[], list: (repo: string, label: string) => OpenRow[] | { refused: string; }): OpenRow[] | { unknown: string; } {
  const rows: OpenRow[] = [];
  for (const repo of repos) {
    for (const label of OWED_LABELS) {
      const listed = list(repo, label);
      // The cause is named in the `unknown`, so the tick's line says WHY the read failed, not only that it did (agent-org#1700).
      if (!Array.isArray(listed)) return { unknown: `the open \`${label}\` rows of ${repo} could not be read (${listed.refused}), so no row there is known to be absent` };
      rows.push(...listed);
    }
  }
  return rows;
}

/**
 * The open rows of `repo` that carry `label`, read through the ticket port, which is a connection and not a search. `null` when the read was refused or failed, or when the
 * population is longer than the port holds whole: a list that may be cut is not the whole set. A refused read returns `{ refused }` with the first line of the thrown error, never a bare
 * `null`: the error is the only record of why the read failed (agent-org#1700). `run` is the gate's runner unless a test hands its own, so the refusal is pinned through this read.
 */
export function liveOwedRows(repo: string, label: string, run: (args: string[]) => string = defaultRun): OpenRow[] | { refused: string; } {
  try {
    const nodes: { title: string; body: string | null; labels: { nodes: { name: string; }[]; }; }[] = readRowsByLabel({ label, state: "OPEN", select: "title body labels(first:100){nodes{name}}", run, repo });
    return nodes.map((node) => ({ title: node.title, body: node.body, labels: node.labels.nodes }));
  } catch (cause) {
    return { refused: String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160) };
  }
}

/**
 * THE CANARY VIOLATION, PURE: the canary-homed flags that are absent from `state`, merged more than `CANARY_ABSENT_MS` before `now`, and named by no owed open row, in the home
 * repository or in another declared tracker. A flag the state carries, on or off, is decided and not counted. A merge date git could not give makes the whole answer unknown, because
 * the two-hour test cannot be made for it.
 * @param openRows the home repository's open rows, or `null` when they could not be read; a null read with a flag past its window is unknown, never a clean list
 * @param otherOwedRows the other trackers' owed rows, asked ONLY for a flag the home rows do not name (a refused read there is unknown)
 */
export function canaryAbsentFlags({ shipped, state, openRows, otherOwedRows = () => [], now, merge, anotherHome = FLAGS_WITH_ANOTHER_HOME }: {
  shipped: readonly ShippedFlag[]; state: CanaryState; openRows: readonly OpenRow[] | null; otherOwedRows?: () => readonly OpenRow[] | { unknown: string; }; now: number;
  merge: (flag: ShippedFlag) => { mergedAt: string | null; pr: number | null; }; anotherHome?: Readonly<Record<string, string>>;
}): CanaryAbsentFlag[] | { unknown: string; } {
  const past: CanaryAbsentFlag[] = [];
  for (const flag of shipped) {
    if (!canaryHomed(flag.key, anotherHome) || Object.hasOwn(state.flags, flag.key)) continue;
    const merged = merge(flag);
    if (merged.mergedAt === null) return { unknown: `${flag.key} is absent from ${CANARY_STATE_FILE} and git did not say when it merged, so its two hours cannot be counted` };
    if (now - Date.parse(merged.mergedAt) > CANARY_ABSENT_MS) past.push({ ...flag, ...merged });
  }
  if (past.length === 0) return [];
  if (openRows === null) return { unknown: `the open rows could not be read, so the rows that name ${past.map((flag) => `\`${flag.key}\``).join(", ")} are not known` };
  const unnamed = past.filter((flag) => !openRows.some((row) => namesOwedKey(row, flag.key)));
  if (unnamed.length === 0) return [];
  const others = otherOwedRows();
  if ("unknown" in others) return others;
  return unnamed.filter((flag) => !others.some((row) => namesOwedKey(row, flag.key)));
}

/**
 * THE COUNT: the tool's shipped flags read against the declarations, and the canary-homed ones against the canary state. `unknown` names the file that could not be parsed, or that
 * `src/` could not be listed. A tree that holds NO flag is `unknown` too, not clean: this registry has held seven or more since 2026-10-12, so none found is a walk that did not work
 * (`copyDriftReading`'s rule for an empty discovery).
 * @param projectRoot the checkout whose `.agent-org/` holds the project's declarations
 * @param hostPath the host declaration, `$AGENT_ORG_HOST` or the file beside the checkout
 * @param canary the canary state, or `{ unknown }` when it could not be read; by default the file `machinery-flag.ts` reads
 * @param openRows the open rows (`readOpenRows`), or `null` when the read was refused
 * @param now the time of the read, in epoch milliseconds
 */
export function readFlagLedger({ toolRoot = TOOL_ROOT, projectRoot = HOME_CHECKOUT, hostPath = hostConfigPath(), read = (path) => readFileSync(path, "utf8"), list = listDirectory, merge = (flag) => mergeOf(flag, { toolRoot }),
  canary = () => readCanaryState(stateEntryPath(CANARY_STATE_FILE)), openRows = null, listOwed = liveOwedRows, now = Date.now() }:
  { toolRoot?: string; projectRoot?: string; hostPath?: string; read?: (path: string) => string; list?: (dir: string) => { name: string; directory: boolean; }[]; merge?: (flag: ShippedFlag) => { mergedAt: string | null; pr: number | null; };
    canary?: () => CanaryState | { unknown: string; }; openRows?: readonly OpenRow[] | null; listOwed?: (repo: string, label: string) => OpenRow[] | { refused: string; }; now?: number; } = {}): FlagLedger {
  const shipped = discoverFlags({ toolRoot, read, list });
  if (shipped === null) return { unknown: `${join(toolRoot, "src")} could not be listed, so no flag was found` };
  if (shipped.length === 0) return { unknown: `no \`*_FLAG\` constant was found under ${join(toolRoot, "src")}, so none was compared` };
  const paths = [...PROJECT_DECLARATIONS.map((file) => ({ path: join(projectRoot, ".agent-org", file), optional: OPTIONAL_DECLARATIONS.includes(file) })), { path: hostPath, optional: false }];
  const declarations: unknown[] = [];
  for (const { path, optional } of paths) {
    let text: string;
    try {
      text = read(path);
    } catch (cause) {
      // An optional file that is not there holds no key. A REQUIRED one that is missing is a wrong path (`$AGENT_ORG_HOST` unset or stale), and reading it as "no key" would name every flag.
      if (optional && (cause as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return { unknown: `${path} could not be read (${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}), so no flag is known unset` };
    }
    try {
      declarations.push(JSON.parse(text));
    } catch (cause) {
      return { unknown: `${path} is not valid JSON (${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}), so no flag is known unset` };
    }
  }
  const state = canary();
  if ("unknown" in state) return state;
  // `project.json` is read first and is required, so `declarations[0]` is its document; the other trackers are read only when a flag needs them
  const otherRepos = otherTrackerRepos(declarations[0]);
  const canaryAbsent = canaryAbsentFlags({ shipped, state, openRows, otherOwedRows: () => owedRowsOf(otherRepos, listOwed), now, merge });
  if ("unknown" in canaryAbsent) return canaryAbsent;
  return { shipped: shipped.length, unset: unsetFlags({ shipped, declarations }).map((flag) => ({ ...flag, ...merge(flag) })), canaryAbsent };
}

/**
 * THE GATE'S READ OF THE LEDGER, named so a test can run it (agent-org#1324): the gate hands `orgHealthNow` this thunk with the open rows it read, so the canary half can
 * tell an owed row from a missing one. The gate passes no `deps`; a test passes the reads `readFlagLedger` takes, and the thunk runs them the way the gate does.
 */
export const readFlagSwitchesFor = (openRows: readonly OpenRow[] | null, deps: Omit<Parameters<typeof readFlagLedger>[0] & object, "openRows"> = {}): (() => FlagLedger) => () => readFlagLedger({ ...deps, openRows });
