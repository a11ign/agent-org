// @ts-check
// THE CLOSED VOCABULARY OF CHECKED FACTS (a11ign/a11ign#2910, row 11 of 13; design #2899 decision 2(e)). What a reply to the chairman may SAY
// about the organisation is whatever one of these placeholders resolves to: each is RE-READ from its source at the moment of sending, so the
// words are a reading and never a memory. `reply.mjs` is the sender; this file is the vocabulary, the parser and the reads.
//
//   {{issue:N.number|state|labels}}   {{pr:N.number|state|review}}   {{run:ID.conclusion}}   {{ready.count}}   {{last-merge.age}}
//   {{unit:NAME.state}}               {{comment:ID.quote}}           {{unchecked:<any of the above>}}
//
// **THE VOCABULARY IS A TABLE, AND NOTHING OUTSIDE IT PARSES.** An unknown kind, an unknown field, an id of the wrong shape and a stray `{{`
// are PROBLEMS, found before any read is made: a reply cannot ask for a fact this file does not know how to check.
//
// **`unchecked` IS HOW "I COULD NOT CHECK X" IS SAID.** It names a placeholder that is valid in this vocabulary and READS NOTHING; it renders as
// `[pr:2881.state]` and claims nothing about it. A refusal's text is built from it, so the refusal passes the same checker that refused the
// original (a message that could not itself be sent would leave the chairman told nothing at all). It cannot be used to smuggle a claim: its
// argument must itself be a placeholder, not words.
//
// **A READER THAT HAS NO ANSWER THROWS.** `undefined`, `null` and an empty string are failures too (`fieldValue`): a placeholder that rendered as
// nothing would read, to the chairman, as "nothing to report". A run that has not concluded, a unit systemd does not know and a quote too long to
// be given verbatim are all throws for that reason.
//
// THE READS ARE INJECTED. `createGhReaders` is the real set, over one `gh` and one `systemctl` the caller supplies, and the same one-line typedef
// below is what a test's fixture implements. Reads are made ONCE per thing named, however many fields of it the text uses.

import { describeError } from "./ledger.mjs";
import { readLastMerge, readWaitingRows } from "./sources/readers.mjs";

/** Stands in for a placeholder while the free text around it is judged. NUL cannot be typed into a chat message and never matches a word or a digit. */
export const MASK = "\u0000";
/** A verbatim quote is given whole or not at all: a cut quote is a different statement. */
export const QUOTE_LIMIT = 1000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const GRAMMAR = /^([a-z]+(?:-[a-z]+)*)(?::(.+))?\.([a-z]+)$/;
const NUMBER = /^[1-9]\d*$/;
/** A systemd unit name. It starts with a letter or digit so it can never be read as a flag by `systemctl show`. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;

/**
 * What a reader returns, by kind. Each method rejects when it cannot answer.
 *
 * @typedef {{
 *   issue: (number: number) => Promise<{number: number, state: string, labels: string[]}>,
 *   pr: (number: number) => Promise<{number: number, state: string, review: string}>,
 *   run: (id: number) => Promise<{conclusion: string}>,
 *   ready: () => Promise<{count: number}>,
 *   lastMerge: () => Promise<{at: number}>,
 *   unit: (name: string) => Promise<{state: string}>,
 *   comment: (id: number) => Promise<{body: string, url: string}>,
 * }} Readers
 *
 * @typedef {{raw: string, kind: string, id: string | null, field: string, fixed?: string}} Placeholder
 */

/** @param {unknown} value @param {string} what @returns {string} `value`, which must be a non-empty string */
function fieldValue(value, what) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${what} came back empty`);
  return value;
}

/** @param {number} elapsedMs @returns {string} "3d 4h", "2h 15m" or "40m": the two most significant units, never a rounded-up one */
export function describeAge(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError(`an age of ${elapsedMs} ms is not an age`);
  const minutes = Math.floor(elapsedMs / MS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours >= HOURS_PER_DAY) return `${Math.floor(hours / HOURS_PER_DAY)}d ${hours % HOURS_PER_DAY}h`;
  return hours > 0 ? `${hours}h ${minutes % MINUTES_PER_HOUR}m` : `${minutes}m`;
}

/** @param {{body: string, url: string}} comment @returns {string} the body quoted line by line, then the link: the one thing to act on */
function quoteOf({ body, url }) {
  const text = fieldValue(body, "the comment's body").replace(/\r\n/g, "\n").trimEnd();
  if (text.length > QUOTE_LIMIT) throw new RangeError(`the comment is ${text.length} characters, over the ${QUOTE_LIMIT} a verbatim quote may be`);
  return `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n${fieldValue(url, "the comment's link")}`;
}

/**
 * kind -> `id` (the shape its id must have, null when it takes none), `read` (what is fetched, once per thing), `fields` (how each field renders).
 * @type {Readonly<Record<string, {id: RegExp | null, read: (readers: Readers, id: string | null) => Promise<any>,
 *   fields: Record<string, (value: any, at: number) => string>}>>}
 */
const VOCABULARY = Object.freeze({
  issue: {
    id: NUMBER, read: (readers, id) => readers.issue(Number(id)),
    fields: {
      number: (value) => String(value.number),
      state: (value) => fieldValue(value.state, "the state"),
      labels: (value) => (value.labels.length === 0 ? "no labels" : [...value.labels].sort().join(", ")),
    },
  },
  pr: {
    id: NUMBER, read: (readers, id) => readers.pr(Number(id)),
    fields: {
      number: (value) => String(value.number),
      state: (value) => fieldValue(value.state, "the state"),
      review: (value) => fieldValue(value.review, "the review decision"),
    },
  },
  run: { id: NUMBER, read: (readers, id) => readers.run(Number(id)), fields: { conclusion: (value) => fieldValue(value.conclusion, "the conclusion") } },
  ready: { id: null, read: (readers) => readers.ready(), fields: { count: (value) => String(value.count) } },
  "last-merge": { id: null, read: (readers) => readers.lastMerge(), fields: { age: (value, at) => describeAge(at - value.at) } },
  unit: { id: UNIT_NAME, read: (readers, id) => readers.unit(String(id)), fields: { state: (value) => fieldValue(value.state, "the state") } },
  comment: { id: NUMBER, read: (readers, id) => readers.comment(Number(id)), fields: { quote: (value) => quoteOf(value) } },
});

/** @param {string} raw @param {string} spec `kind[:id].field` @returns {Placeholder} @throws {TypeError} when `spec` is not in the vocabulary */
function parseSpec(raw, spec) {
  const match = GRAMMAR.exec(spec);
  if (match === null) throw new TypeError(`${raw}: not of the form {{kind:id.field}} or {{kind.field}}`);
  const [, kind, id = null, field] = match;
  const entry = Object.hasOwn(VOCABULARY, kind) ? VOCABULARY[kind] : undefined;
  if (entry === undefined) throw new TypeError(`${raw}: "${kind}" is not a kind of fact (the kinds: ${Object.keys(VOCABULARY).join(", ")}, unchecked)`);
  if ((entry.id === null) !== (id === null) || (entry.id !== null && !entry.id.test(String(id)))) {
    throw new TypeError(`${raw}: "${kind}" ${entry.id === null ? "takes no id" : "needs an id of the right shape"}`);
  }
  if (!Object.hasOwn(entry.fields, field)) throw new TypeError(`${raw}: "${kind}" has no field "${field}" (its fields: ${Object.keys(entry.fields).join(", ")})`);
  return { raw, kind, id, field };
}

/** @param {string} raw `{{...}}` as written @param {string} inner what is between the braces @returns {Placeholder} @throws {TypeError} */
function parseOne(raw, inner) {
  const match = /^unchecked:(.+)$/.exec(inner);
  if (match === null) return parseSpec(raw, inner);
  const named = parseSpec(raw, match[1]);
  return { ...named, fixed: `[${match[1]}]` };
}

/**
 * Splits `text` into the words and the placeholders in them.
 *
 * @param {string} text
 * @returns {{segments: (string | Placeholder)[], masked: string, placeholders: Placeholder[], problems: {placeholder: string | null, reason: string}[]}}
 *   `masked` is `text` with each placeholder replaced by `MASK`; `problems` is every placeholder that is not in the vocabulary, and a stray brace.
 */
export function parsePlaceholders(text) {
  /** @type {(string | Placeholder)[]} */
  const segments = [];
  /** @type {Placeholder[]} */
  const placeholders = [];
  /** @type {{placeholder: string | null, reason: string}[]} */
  const problems = [];
  let masked = "";
  let cursor = 0;
  for (const found of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const between = text.slice(cursor, found.index);
    cursor = found.index + found[0].length;
    segments.push(between);
    masked += between + MASK;
    try {
      const placeholder = parseOne(found[0], found[1]);
      placeholders.push(placeholder);
      segments.push(placeholder);
    } catch (error) {
      problems.push({ placeholder: found[0], reason: /** @type {Error} */ (error).message });
    }
  }
  segments.push(text.slice(cursor));
  masked += text.slice(cursor);
  if (/\{\{|\}\}/.test(masked)) problems.push({ placeholder: null, reason: "a '{{' or '}}' that does not open or close a placeholder" });
  return { segments, masked, placeholders, problems };
}

/** @param {(string | Placeholder)[]} segments @param {Map<string, string>} values @returns {string} the words with each placeholder replaced by what was read */
export function renderSegments(segments, values) {
  return segments.map((segment) => (typeof segment === "string" ? segment : String(values.get(segment.raw)))).join("");
}

/** @param {string} thing `kind:id` @param {Readers} readers @returns {Promise<{value: any} | {error: unknown}>} the read, or why it failed: never a throw */
async function readThing(thing, readers) {
  const [kind, ...rest] = thing.split(":");
  const id = rest.join(":");
  try {
    return { value: await VOCABULARY[kind].read(readers, id === "" ? null : id) };
  } catch (error) {
    return { error };
  }
}

/**
 * Reads every thing the placeholders name, ONCE each, in parallel, and renders each placeholder's field. EVERY failure is collected: the caller is told
 * all of what could not be checked, not just the first.
 *
 * @param {Placeholder[]} placeholders @param {{readers: Readers, now: () => number}} deps
 * @returns {Promise<{values: Map<string, string>, failures: {placeholder: string, reason: string}[], at: number}>} `at` is when the reads finished
 */
export async function readPlaceholders(placeholders, { readers, now }) {
  const reads = placeholders.filter((placeholder) => placeholder.fixed === undefined);
  const things = [...new Set(reads.map((placeholder) => `${placeholder.kind}:${placeholder.id ?? ""}`))];
  /** @type {Map<string, {value: any} | {error: unknown}>} */
  const settled = new Map(await Promise.all(things.map(async (thing) => /** @type {[string, {value: any} | {error: unknown}]} */ ([thing, await readThing(thing, readers)]))));
  const at = now();
  /** @type {Map<string, string>} */
  const values = new Map(placeholders.filter((placeholder) => placeholder.fixed !== undefined).map((placeholder) => [placeholder.raw, String(placeholder.fixed)]));
  /** @type {{placeholder: string, reason: string}[]} */
  const failures = [];
  for (const placeholder of reads) {
    const outcome = /** @type {any} */ (settled.get(`${placeholder.kind}:${placeholder.id ?? ""}`));
    try {
      if ("error" in outcome) throw outcome.error;
      values.set(placeholder.raw, VOCABULARY[placeholder.kind].fields[placeholder.field](outcome.value, at));
    } catch (error) {
      if (!failures.some((failure) => failure.placeholder === placeholder.raw)) failures.push({ placeholder: placeholder.raw, reason: describeError(error) });
    }
  }
  return { values, failures, at };
}

/** @param {string} text `systemctl show` output, `Key=value` per line @returns {Record<string, string>} */
function parseProperties(text) {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/**
 * The real reads. `gh` takes an argv and resolves to what it printed; `systemctl` the same for `--user show`. Both are the caller's, so a test owns them
 * and so does the host (which decides which account `gh` is). `readLastMerge` and `readWaitingRows` are the watcher's own, so "the last merge" and "ready"
 * mean here exactly what they mean in a stall event.
 *
 * @param {{gh: (argv: string[]) => Promise<string>, systemctl: (argv: string[]) => Promise<string>, repo: string}} deps @returns {Readers}
 */
export function createGhReaders({ gh, systemctl, repo }) {
  const github = { api: async (/** @type {string} */ path) => JSON.parse(await gh(["api", path])) };
  return {
    async issue(number) {
      const issue = await github.api(`repos/${repo}/issues/${number}`);
      // The issues endpoint answers for a pull request too, and "the row's state" of one would be a different fact than its pull request's.
      if (issue.pull_request !== undefined) throw new TypeError(`${number} is a pull request: ask for {{pr:${number}.state}}`);
      return { number: issue.number, state: issue.state, labels: issue.labels.map((/** @type {any} */ label) => String(label?.name ?? label)) };
    },
    async pr(number) {
      const [pull, view] = await Promise.all([github.api(`repos/${repo}/pulls/${number}`), gh(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision"])]);
      // `reviewDecision` is EMPTY when the base requires no approval (`.claude/rules/main-review-requirement.md`): that is a reading, and it says "none".
      return { number: pull.number, state: pull.merged_at ? "merged" : pull.state, review: JSON.parse(view).reviewDecision || "none" };
    },
    async run(id) {
      const run = await github.api(`repos/${repo}/actions/runs/${id}`);
      if (run.conclusion === null || run.conclusion === undefined) throw new RangeError(`run ${id} has not concluded (status ${run.status})`);
      return { conclusion: run.conclusion };
    },
    async ready() {
      return { count: (await readWaitingRows({ github, repo })).length };
    },
    async lastMerge() {
      return { at: await readLastMerge({ github, repo }) };
    },
    async unit(name) {
      const properties = parseProperties(await systemctl(["--user", "show", name, "-p", "ActiveState,LoadState"]));
      // `systemctl show` of a name it has never heard of prints `ActiveState=inactive`: a false reading of a unit that does not exist.
      if (properties.LoadState === undefined || properties.LoadState === "not-found") throw new RangeError(`systemd has no unit named ${name}`);
      return { state: fieldValue(properties.ActiveState, "ActiveState") };
    },
    async comment(id) {
      const comment = await github.api(`repos/${repo}/issues/comments/${id}`);
      return { body: comment.body, url: comment.html_url };
    },
  };
}
