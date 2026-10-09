// @ts-check
// THE MILESTONE SOURCE (a11ign/a11ign#3414, chairman point 2 of #3409): a moment the project DECLARED has come true, and the chairman is told once.
// "A milestone moves" has no definition the code can read, so this reads none: `.agent-org/chairman-milestones.json` (the path is
// `messaging.milestones`) lists the moments, `ceo` owns the file, and what counts is therefore a reviewed diff and not a guess. Nothing is
// INFERRED from labels or from GitHub's own milestones, and there is no progress figure.
//
//   { "milestones": [ { "key": "split-move-1", "what": "nvda-worker has moved to its own repository", "when": { "row": 2701, "closed": true } } ] }
//
// A `when` is exactly ONE of `{ row: N, closed: true }`, `{ pr: N, merged: true }` or `{ release: "<tag>" }`, each with an optional `repo`
// (`owner/name`, default the tracker's). `milestone:<key>` is the event's key, so a moment is told once however many ticks see it.
//
// A LEAF and INJECTED, as `stall.mjs` is: it imports siblings and node's own, and reads GitHub only through the three `readers`.
//
// **THE FIRST RUN TELLS NO HISTORY (as `releases.mjs` does).** A moment already true the first time anyone read the file happened before the chairman
// asked, and telling him all of them at once is the burst this avoids. So the first complete read records each as SEEN, tells none, and records a
// baseline marker. **The marker is what says "not the first run", and a count of recorded moments could not:** a file whose moments are all still
// open records none, and its first moment to come true would then look like history. Both are ledger `source-note` lines the watcher already knows
// how to write once each, so there is no second state file. **A READ THAT FAILED RECORDS NO MARKER**: the next tick is the first run again, which is
// the safe way to be wrong (a moment recorded without being told, never one told twice).
//
// **A CONDITION THAT CANNOT BE READ IS `cannot-ask`**, never "not yet" and never "true": the moment is left for the next tick and the others are read.

import { readFileSync } from "node:fs";

import { STATUS } from "../ledger.ts";
import { instant, observe } from "./stall.ts";

export const MILESTONE_KIND = "milestone";
const KEY_PREFIX = "milestone:";
/** The one marker for the whole file: written when a complete read has recorded the moments already true. */
export const BASELINE_KEY = "milestone-baseline";
const MAX_MILESTONE_KEY_LENGTH = 100;
const MILESTONE_KEY = /^[A-Za-z0-9][\w.-]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const ENTRY_KEYS = new Set(["key", "what", "when"]);
const WHEN_SUBJECTS = Object.freeze({
  row: { number: "row", confirm: "closed" },
  pull: { number: "pr", confirm: "merged" },
});

/** A declaration that is present and wrong. `entry` is `milestones[i]` (with the key once it has one), `field` the dotted part within it. */
export class MilestonesRefusal extends Error {
  /** @param {string} entry @param {string} field @param {string} reason @param {string} source @param {{ cause?: unknown }} [options] */
  constructor(entry: string, field: string, reason: string, source: string, options: { cause?: unknown; } = {}) {
    super(`${source}: ${entry}${field === "" ? "" : `: ${field}`}: ${reason}`, options);
    this.name = "MilestonesRefusal";
    this.entry = entry;
    this.field = field;
  }
}

/** @param {string} key @returns {string} */
export function milestoneKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

/** @param {unknown} value @returns {boolean} */
const isObject = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {string} a name for what was found instead, for a message that must say so */
function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

/** @param {unknown} value @returns {value is number} */
const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * @typedef {{ subject: "row" | "pull", repo: string | null, number: number } | { subject: "release", repo: string | null, tag: string }} When
 * @typedef {{ key: string, what: string, when: When }} Milestone
 */

/** @param {Record<string, unknown>} when @param {string} entry @param {string} source @returns {string | null} the `repo`, or null for the tracker's */
function readRepo(when: Record<string, unknown>, entry: string, source: string): string | null {
  if (when.repo === undefined) return null;
  if (typeof when.repo !== "string" || !REPO.test(when.repo)) {
    throw new MilestonesRefusal(entry, "when.repo", `${JSON.stringify(when.repo)} is not an owner/name`, source);
  }
  return when.repo;
}

/**
 * The number-and-confirmation forms: `{ row, closed: true }` and `{ pr, merged: true }`. The confirmation is required and must be `true`, so the
 * sentence in the file says what the moment IS rather than leaving it to the reader's guess.
 * @param {Record<string, unknown>} when @param {"row" | "pull"} subject @param {string} entry @param {string} source @returns {When}
 */
function readNumbered(when: Record<string, unknown>, subject: "row" | "pull", entry: string, source: string): When {
  const { number: field, confirm } = WHEN_SUBJECTS[subject];
  const allowed = new Set([field, confirm, "repo"]);
  const stray = Object.keys(when).find((name) => !name.startsWith("_") && !allowed.has(name));
  if (stray !== undefined) throw new MilestonesRefusal(entry, `when.${stray}`, `unknown key for a \`${field}\` condition (known: ${[...allowed].join(", ")})`, source);
  const number = when[field];
  if (!isPositiveInteger(number)) throw new MilestonesRefusal(entry, `when.${field}`, `it must be a positive integer, not ${JSON.stringify(number)}`, source);
  if (when[confirm] !== true) throw new MilestonesRefusal(entry, `when.${confirm}`, `it must be \`true\` (the condition is that it ${confirm === "closed" ? "is closed" : "is merged"})`, source);
  return { subject, repo: readRepo(when, entry, source), number };
}

/** @param {Record<string, unknown>} when @param {string} entry @param {string} source @returns {When} */
function readRelease(when: Record<string, unknown>, entry: string, source: string): When {
  const stray = Object.keys(when).find((name) => !name.startsWith("_") && !["release", "repo"].includes(name));
  if (stray !== undefined) throw new MilestonesRefusal(entry, `when.${stray}`, "unknown key for a `release` condition (known: release, repo)", source);
  if (typeof when.release !== "string" || when.release.trim() === "") {
    throw new MilestonesRefusal(entry, "when.release", `it must be a non-empty tag, not ${describe(when.release)}`, source);
  }
  return { subject: "release", repo: readRepo(when, entry, source), tag: when.release };
}

/** @param {unknown} when @param {string} entry @param {string} source @returns {When} */
function readWhen(when: unknown, entry: string, source: string): When {
  if (when === undefined) throw new MilestonesRefusal(entry, "when", "it is missing: a moment with no condition can never be told", source);
  if (!isObject(when)) throw new MilestonesRefusal(entry, "when", `it must be an object, not ${describe(when)}`, source);
  const condition = /** @type {Record<string, unknown>} */ (when);
  const subjects = ["row", "pr", "release"].filter((name) => Object.hasOwn(condition, name));
  if (subjects.length !== 1) {
    throw new MilestonesRefusal(entry, "when", `it must name exactly one of row, pr or release (found ${subjects.length === 0 ? "none" : subjects.join(", ")})`, source);
  }
  if (subjects[0] === "release") return readRelease(condition, entry, source);
  return readNumbered(condition, subjects[0] === "row" ? "row" : "pull", entry, source);
}

/** @param {unknown} key @param {string} entry @param {string} source @returns {string} */
function readKey(key: unknown, entry: string, source: string): string {
  if (key === undefined) throw new MilestonesRefusal(entry, "key", "it is missing", source);
  if (typeof key !== "string" || !MILESTONE_KEY.test(key) || key.length > MAX_MILESTONE_KEY_LENGTH) {
    throw new MilestonesRefusal(entry, "key", `${JSON.stringify(key)} is not a key (letters, digits, \`.\`, \`_\` and \`-\`, at most ${MAX_MILESTONE_KEY_LENGTH} characters, no whitespace)`, source);
  }
  return key;
}

/** @param {unknown} what @param {string} entry @param {string} source @returns {string} */
function readWhat(what: unknown, entry: string, source: string): string {
  if (what === undefined) throw new MilestonesRefusal(entry, "what", "it is missing: the sentence the chairman is told", source);
  if (typeof what !== "string" || what.trim() === "") throw new MilestonesRefusal(entry, "what", `it must be a non-empty sentence, not ${describe(what)}`, source);
  return what;
}

/** @param {unknown} raw @param {number} index @param {string} source @returns {Milestone} */
function readEntry(raw: unknown, index: number, source: string): Milestone {
  const where = `milestones[${index}]`;
  if (!isObject(raw)) throw new MilestonesRefusal(where, "", `it must be an object, not ${describe(raw)}`, source);
  const holder = /** @type {Record<string, unknown>} */ (raw);
  const key = readKey(holder.key, where, source);
  // From here the entry is named by its key as well, so a refusal in a long file points at the line a person wrote.
  const named = `${where} (${key})`;
  const unknown = Object.keys(holder).find((name) => !name.startsWith("_") && !ENTRY_KEYS.has(name));
  if (unknown !== undefined) throw new MilestonesRefusal(named, unknown, `unknown key (known: ${[...ENTRY_KEYS].join(", ")})`, source);
  return { key, what: readWhat(holder.what, named, source), when: readWhen(holder.when, named, source) };
}

/**
 * PURE: a test drives every refusal with a plain object. An entry missing its `key`, `what` or `when` is refused BY NAME, and so is a duplicate key (two moments
 * under one key would be one event, and the second would never be told).
 * @param {unknown} parsed the whole parsed file @param {string} [source] the file's path, for the refusal's first words
 * @returns {Milestone[]}
 */
export function parseMilestones(parsed: unknown, source: string = "chairman-milestones.json"): Milestone[] {
  if (!isObject(parsed)) throw new MilestonesRefusal("(file)", "", "it must be a JSON object holding a `milestones` array", source);
  const { milestones } = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(milestones)) throw new MilestonesRefusal("(file)", "milestones", `it must be an array, not ${describe(milestones)}`, source);
  const entries = milestones.map((raw, index) => readEntry(raw, index, source));
  const duplicate = entries.find((entry, index) => entries.findIndex((other) => other.key === entry.key) !== index);
  if (duplicate !== undefined) throw new MilestonesRefusal(`milestones (${duplicate.key})`, "key", "it is declared twice", source);
  return entries;
}

/**
 * Read and parse the declaration. An unreadable or unparseable file is a refusal and not "no milestones": the file that says what to tell the chairman
 * being unreadable is not the same fact as its listing nothing.
 * @param {string} path @param {{ read?: typeof readFileSync }} [deps] @returns {Milestone[]}
 */
export function readMilestonesFile(path: string, { read = readFileSync }: { read?: typeof readFileSync; } = {}): Milestone[] {
  /** @type {string} */
  let text: string;
  try {
    text = String(read(path, "utf8"));
  } catch (cause) {
    throw new MilestonesRefusal("(file)", "", "the declaration cannot be read", path, { cause });
  }
  /** @type {unknown} */
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new MilestonesRefusal("(file)", "", "it is not valid JSON", path, { cause });
  }
  return parseMilestones(parsed, path);
}

/**
 * What the ledger holds from earlier runs: every `milestone:` key a `source-note` recorded or the core TOLD (sent, or held for the one digest), and the
 * baseline marker. A moment whose send FAILED or was deferred is not here, so the next tick offers it again.
 *
 * @param {Record<string, any>[]} history @returns {Set<string>}
 */
export function seenMilestoneKeys(history: Record<string, any>[]): Set<string> {
  const told = (/** @type {Record<string, any>} */ line: Record<string, any>) => line.status === STATUS.sent || line.status === STATUS.digested;
  return new Set(history
    .filter((line) => typeof line.key === "string" && line.direction !== "in"
      && (line.key === BASELINE_KEY || (line.key.startsWith(KEY_PREFIX) && (line.kind === "source-note" || told(line)))))
    .map((line) => line.key));
}

/**
 * @typedef {{
 *   readIssue: (query: { repo: string, number: number }) => Promise<Record<string, any>> | Record<string, any>,
 *   readPull: (query: { repo: string, number: number }) => Promise<Record<string, any>> | Record<string, any>,
 *   readReleases: (query: { repo: string }) => Promise<unknown> | unknown,
 * }} MilestoneReaders  the REST reads of `issues/<n>`, `pulls/<n>` and `releases`, each as GitHub returns them
 * @typedef {{ met: false } | { met: true, at: number, link: string | null }} Condition
 */

/** @param {Record<string, any>} issue @returns {Condition} */
function rowCondition(issue: Record<string, any>): Condition {
  if (issue.state === "open") return { met: false };
  if (issue.state !== "closed") throw new TypeError(`the row's state is ${JSON.stringify(issue.state)}, not open or closed`);
  return { met: true, at: instant(issue.closed_at, "closed_at"), link: typeof issue.html_url === "string" ? issue.html_url : null };
}

/** @param {Record<string, any>} pull @returns {Condition} an open PR and one closed unmerged are both "not yet": neither is a milestone moving */
function pullCondition(pull: Record<string, any>): Condition {
  if (pull.merged_at === null || pull.merged_at === undefined) return { met: false };
  return { met: true, at: instant(pull.merged_at, "merged_at"), link: typeof pull.html_url === "string" ? pull.html_url : null };
}

/** @param {unknown} releases @param {string} tag @returns {Condition} a draft or a pre-release is not a release having been tagged */
function releaseCondition(releases: unknown, tag: string): Condition {
  if (!Array.isArray(releases)) throw new TypeError("releases: an array was expected");
  const found = releases.find((release) => release.tag_name === tag && release.draft !== true && release.prerelease !== true);
  if (found === undefined) return { met: false };
  return { met: true, at: instant(found.published_at ?? found.created_at, `${tag}.published_at`), link: typeof found.html_url === "string" ? found.html_url : null };
}

/**
 * @param {When} when @param {string} defaultRepo @param {MilestoneReaders} readers @returns {Promise<Condition>}
 */
async function readCondition(when: When, defaultRepo: string, readers: MilestoneReaders): Promise<Condition> {
  const repo = when.repo ?? defaultRepo;
  if (when.subject === "release") return releaseCondition(await readers.readReleases({ repo }), when.tag);
  if (when.subject === "pull") return pullCondition(await readers.readPull({ repo, number: when.number }));
  return rowCondition(await readers.readIssue({ repo, number: when.number }));
}

/** @typedef {{ reason: string, key: string }} Note */

/** @param {Milestone} milestone @param {Extract<Condition, { met: true }>} condition @returns {Record<string, unknown>} */
function eventOf(milestone: Milestone, condition: Extract<Condition, { met: true; }>): Record<string, unknown> {
  return {
    key: milestoneKey(milestone.key), kind: MILESTONE_KIND, severity: "info", firstSeenAt: condition.at,
    text: milestone.what, links: condition.link === null ? [] : [condition.link], resolved: false,
  };
}

/** @param {{ key: string }[]} recorded @param {boolean} complete @returns {Note[]} the moments recorded as seen, then the marker LAST so a run that stops half way reads the file as new again */
function baselineNotes(recorded: { key: string; }[], complete: boolean): Note[] {
  const existing = recorded.map(({ key }) => ({ key: milestoneKey(key), reason: "was already true when the milestones source was first enabled: recorded as seen, not told" }));
  if (!complete) return existing;
  const count = existing.length === 1 ? "1 moment" : `${existing.length} moments`;
  return [...existing, { key: BASELINE_KEY, reason: `first complete read of the declared milestones: ${count} already true, recorded as seen and none told` }];
}

/**
 * One event per declared moment that has come true and has not been seen, in the order the file lists them. A moment whose condition cannot be read
 * yields no event and is named in `cannotAsk`.
 *
 * @param {{ milestones: readonly Milestone[], readers: MilestoneReaders, seen: Set<string>, defaultRepo: string, log?: (line: string) => void }} input
 * @returns {Promise<{ events: Record<string, unknown>[], notes: Note[], cannotAsk: { source: string, reason: string }[] }>}
 *   `notes` are the ledger lines to write (see the head of this file); the watcher records each once.
 */
export async function observeMilestones({ milestones, readers, seen, defaultRepo, log = () => {} }: { milestones: readonly Milestone[]; readers: MilestoneReaders; seen: Set<string>; defaultRepo: string; log?: (line: string) => void; }): Promise<{ events: Record<string, unknown>[]; notes: Note[]; cannotAsk: { source: string; reason: string; }[]; }> {
  const parts = await Promise.all(milestones.map((milestone) => observe(
    milestoneKey(milestone.key),
    async () => [{ milestone, condition: await readCondition(milestone.when, defaultRepo, readers) }],
    log,
  )));
  const readings = parts.flatMap((part) => /** @type {{ milestone: Milestone, condition: Condition }[]} */ (part.events));
  const cannotAsk = parts.flatMap((part) => part.cannotAsk);
  const unseen = readings.filter(({ milestone, condition }) => condition.met && !seen.has(milestoneKey(milestone.key)));
  if (!seen.has(BASELINE_KEY)) return { events: [], notes: baselineNotes(unseen.map(({ milestone }) => milestone), cannotAsk.length === 0), cannotAsk };
  const events = unseen.map(({ milestone, condition }) => eventOf(milestone, /** @type {Extract<Condition, { met: true }>} */ (condition)));
  return { events, notes: [], cannotAsk };
}
