// THE CLOSED VOCABULARY OF CHECKED FACTS (a11ign/a11ign#2910, row 11 of 13; design #2899 decision 2(e)). What a reply to the chairman may SAY
// about the organisation is whatever one of these placeholders resolves to: each is RE-READ from its source at the moment of sending, so the
// words are a reading and never a memory. `reply.mjs` is the sender; this file is the vocabulary, the parser and the reads.
//
//   {{issue:N.number|state|labels}}   {{pr:N.number|state|review}}   {{run:ID.status|conclusion}}   {{ready.count}}   {{open.count}}   {{last-merge.age}}
//   {{unit:NAME.state}}               {{comment:ID.quote}}           {{unchecked:<any of the above>}}
//   {{fleet.workers-up}}  {{fleet.workers-down}}  {{gate.last-tick.age}}  {{release:OWNER/REPO.latest}}      (a11ign/a11ign#3420)
//
// `PLACEHOLDER_NAMES` is this table as a list. The liaison's brief restates it, so a test pins it: a name added here is a name the brief must learn.
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
// nothing would read, to the chairman, as "nothing to report". A run's `.conclusion` before it has concluded (its `.status` is the field a run in progress can be read by), a unit systemd does not know and a quote too long to
// be given verbatim are all throws for that reason.
//
// THE READS ARE INJECTED. `createGhReaders` is the real set, over one `gh` and one `systemctl` the caller supplies, and the same one-line typedef
// below is what a test's fixture implements. Reads are made ONCE per thing named, however many fields of it the text uses.

import { describeError } from "./ledger.ts";
import { readFleetRoster, readLastMerge, readLastTick, readWaitingRows } from "./sources/readers.ts";

/** Stands in for a placeholder while the free text around it is judged. NUL cannot be typed into a chat message and never matches a word or a digit. */
export const MASK = "\u0000";
/** A verbatim quote is given whole or not at all: a cut quote is a different statement. */
export const QUOTE_LIMIT = 1000;
const ROWS_PER_PAGE = 100;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
// A field may be hyphenated (`workers-up`) or dotted (`last-tick.age`). An id is greedy, so with one the field is still the last dotted segment.
const GRAMMAR = /^([a-z]+(?:-[a-z]+)*)(?::(.+))?\.([a-z]+(?:[-.][a-z]+)*)$/;
const NUMBER = /^[1-9]\d*$/;
/** A systemd unit name. It starts with a letter or digit so it can never be read as a flag by `systemctl show`. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
/** `owner/name`, each part starting with a letter or digit, so it can never be read as a flag and cannot climb out of `repos/<owner>/<name>/`. */
const REPOSITORY = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** What a reader returns, by kind. Each method rejects when it cannot answer. */
export type Readers = {
  issue: (number: number) => Promise<{ number: number; state: string; labels: string[] }>;
  pr: (number: number) => Promise<{ number: number; state: string; review: string }>;
  run: (id: number) => Promise<{ status: string; conclusion: string | null }>;
  ready: () => Promise<{ count: number }>;
  open: () => Promise<{ count: number }>;
  lastMerge: () => Promise<{ at: number }>;
  unit: (name: string) => Promise<{ state: string }>;
  comment: (id: number) => Promise<{ body: string; url: string }>;
  fleet: () => Promise<{ up: string[]; down: string[]; polledAt: number }>;
  gate: () => Promise<{ at: number }>;
  release: (repo: string) => Promise<{ tag: string }>;
};

export type Placeholder = { raw: string; kind: string; id: string | null; field: string; fixed?: string };

/** Returns `value`, which must be a non-empty string. */
function fieldValue(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${what} came back empty`);
  return value;
}

/**
 * `{{run:ID.status}}`: where a run is while it runs (`queued`, `in_progress`), and its conclusion once it has one, so one field follows a run from start to end.
 * A run GitHub calls `completed` that carries no conclusion is a throw and not "completed": that word is the status, never a final state.
 */
function runStatus({ status, conclusion }: { status: string; conclusion: string | null; }): string {
  return fieldValue(conclusion ?? (status === "completed" ? null : status), "the run's status");
}

/** The conclusion, which a run still in progress does not have. */
function runConclusion({ status, conclusion }: { status: string; conclusion: string | null; }): string {
  if (conclusion === null || conclusion === undefined) throw new RangeError(`the run has not concluded (status ${status})`);
  return fieldValue(conclusion, "the conclusion");
}

/** "3d 4h", "2h 15m" or "40m": the two most significant units, never a rounded-up one. */
export function describeAge(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError(`an age of ${elapsedMs} ms is not an age`);
  const minutes = Math.floor(elapsedMs / MS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours >= HOURS_PER_DAY) return `${Math.floor(hours / HOURS_PER_DAY)}d ${hours % HOURS_PER_DAY}h`;
  return hours > 0 ? `${hours}h ${minutes % MINUTES_PER_HOUR}m` : `${minutes}m`;
}

/** The body quoted line by line, then the link: the one thing to act on. */
function quoteOf({ body, url }: { body: string; url: string; }): string {
  const text = fieldValue(body, "the comment's body").replace(/\r\n/g, "\n").trimEnd();
  if (text.length > QUOTE_LIMIT) throw new RangeError(`the comment is ${text.length} characters, over the ${QUOTE_LIMIT} a verbatim quote may be`);
  return `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n${fieldValue(url, "the comment's link")}`;
}

/** The names, and how old the poll is: the stamp is the send's, the reading is fleet-watch's. */
function namesOf(names: string[], { polledAt }: { polledAt: number; }, at: number): string {
  return `${names.length === 0 ? "none" : names.join(", ")} (fleet-watch poll ${describeAge(at - polledAt)} ago)`;
}

/**
 * kind -> `id` (the shape its id must have, null when it takes none), `idName` (what the id is called in `PLACEHOLDER_NAMES`), `read` (what is fetched,
 * once per thing), `fields` (how each field renders).
 */
const VOCABULARY: Readonly<Record<string, {
    id: RegExp | null; idName?: string; read: (readers: Readers, id: string | null) => Promise<any>;
    fields: Record<string, (value: any, at: number) => string>;
}>> = Object.freeze({
  issue: {
    id: NUMBER, idName: "number", read: (readers, id) => readers.issue(Number(id)),
    fields: {
      number: (value) => String(value.number),
      state: (value) => fieldValue(value.state, "the state"),
      labels: (value) => (value.labels.length === 0 ? "no labels" : [...value.labels].sort().join(", ")),
    },
  },
  pr: {
    id: NUMBER, idName: "number", read: (readers, id) => readers.pr(Number(id)),
    fields: {
      number: (value) => String(value.number),
      state: (value) => fieldValue(value.state, "the state"),
      review: (value) => fieldValue(value.review, "the review decision"),
    },
  },
  run: { id: NUMBER, idName: "id", read: (readers, id) => readers.run(Number(id)), fields: { status: runStatus, conclusion: runConclusion } },
  ready: { id: null, read: (readers) => readers.ready(), fields: { count: (value) => String(value.count) } },
  open: { id: null, read: (readers) => readers.open(), fields: { count: (value) => String(value.count) } },
  "last-merge": { id: null, read: (readers) => readers.lastMerge(), fields: { age: (value, at) => describeAge(at - value.at) } },
  unit: { id: UNIT_NAME, idName: "unit", read: (readers, id) => readers.unit(String(id)), fields: { state: (value) => fieldValue(value.state, "the state") } },
  comment: { id: NUMBER, idName: "id", read: (readers, id) => readers.comment(Number(id)), fields: { quote: (value) => quoteOf(value) } },
  fleet: {
    id: null, read: (readers) => readers.fleet(),
    fields: { "workers-up": (value, at) => namesOf(value.up, value, at), "workers-down": (value, at) => namesOf(value.down, value, at) },
  },
  gate: { id: null, read: (readers) => readers.gate(), fields: { "last-tick.age": (value, at) => describeAge(at - value.at) } },
  release: { id: REPOSITORY, idName: "repo", read: (readers, id) => readers.release(String(id)), fields: { latest: (value) => fieldValue(value.tag, "the release's tag") } },
});

/** Every placeholder the vocabulary parses, as `kind[:<id>].field`: the list a brief may name, pinned by a test because the brief restates it. `unchecked:` wraps any of them. */
export const PLACEHOLDER_NAMES = Object.freeze(
  Object.entries(VOCABULARY).flatMap(([kind, entry]) => Object.keys(entry.fields).map((field) => `${kind}${entry.id === null ? "" : `:<${entry.idName}>`}.${field}`)),
);

/** `spec` is `kind[:id].field`. @throws {TypeError} when `spec` is not in the vocabulary */
function parseSpec(raw: string, spec: string): Placeholder {
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

/** `raw` is `{{...}}` as written; `inner` is what is between the braces. @throws {TypeError} */
function parseOne(raw: string, inner: string): Placeholder {
  const match = /^unchecked:(.+)$/.exec(inner);
  if (match === null) return parseSpec(raw, inner);
  const named = parseSpec(raw, match[1]);
  return { ...named, fixed: `[${match[1]}]` };
}

/**
 * Splits `text` into the words and the placeholders in them. `masked` is `text` with each placeholder replaced by `MASK`; `problems` is every
 * placeholder that is not in the vocabulary, and a stray brace.
 */
export function parsePlaceholders(text: string): { segments: (string | Placeholder)[]; masked: string; placeholders: Placeholder[]; problems: { placeholder: string | null; reason: string; }[]; } {
  const segments: (string | Placeholder)[] = [];
  const placeholders: Placeholder[] = [];
  const problems: { placeholder: string | null; reason: string; }[] = [];
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
      problems.push({ placeholder: found[0], reason: (error as Error).message });
    }
  }
  segments.push(text.slice(cursor));
  masked += text.slice(cursor);
  if (/\{\{|\}\}/.test(masked)) problems.push({ placeholder: null, reason: "a '{{' or '}}' that does not open or close a placeholder" });
  return { segments, masked, placeholders, problems };
}

/** The words with each placeholder replaced by what was read. */
export function renderSegments(segments: (string | Placeholder)[], values: Map<string, string>): string {
  return segments.map((segment) => (typeof segment === "string" ? segment : String(values.get(segment.raw)))).join("");
}

/** `thing` is `kind:id`. Returns the read, or why it failed: never a throw. */
async function readThing(thing: string, readers: Readers): Promise<{ value: any; } | { error: unknown; }> {
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
 * all of what could not be checked, not just the first. `at` is when the reads finished.
 */
export async function readPlaceholders(placeholders: Placeholder[], { readers, now }: { readers: Readers; now: () => number; }): Promise<{ values: Map<string, string>; failures: { placeholder: string; reason: string; }[]; at: number; }> {
  const reads = placeholders.filter((placeholder) => placeholder.fixed === undefined);
  const things = [...new Set(reads.map((placeholder) => `${placeholder.kind}:${placeholder.id ?? ""}`))];
  const settled: Map<string, { value: any; } | { error: unknown; }> = new Map(await Promise.all(things.map(async (thing) => [thing, await readThing(thing, readers)] as [string, { value: any; } | { error: unknown; }])));
  const at = now();
  const values: Map<string, string> = new Map(placeholders.filter((placeholder) => placeholder.fixed !== undefined).map((placeholder) => [placeholder.raw, String(placeholder.fixed)]));
  const failures: { placeholder: string; reason: string; }[] = [];
  for (const placeholder of reads) {
    const outcome = settled.get(`${placeholder.kind}:${placeholder.id ?? ""}`) as any;
    try {
      if ("error" in outcome) throw outcome.error;
      values.set(placeholder.raw, VOCABULARY[placeholder.kind].fields[placeholder.field](outcome.value, at));
    } catch (error) {
      if (!failures.some((failure) => failure.placeholder === placeholder.raw)) failures.push({ placeholder: placeholder.raw, reason: describeError(error) });
    }
  }
  return { values, failures, at };
}

/**
 * How many ROWS are open: the issues, never the pull requests the issues endpoint lists beside them (`repos/<repo>.open_issues_count` counts both, so it is
 * not this fact). Paged to the end, so a count over one page is the count and not the page's size.
 */
async function countOpenRows(github: { api: (path: string) => Promise<any>; }, repo: string): Promise<number> {
  let count = 0;
  for (let page = 1; ; page += 1) {
    const listed = await github.api(`repos/${repo}/issues?state=open&per_page=${ROWS_PER_PAGE}&page=${page}`);
    if (!Array.isArray(listed)) throw new TypeError("GitHub's list of open issues was not a list");
    count += listed.filter((issue) => issue.pull_request === undefined).length;
    if (listed.length < ROWS_PER_PAGE) return count;
  }
}

/** `text` is `systemctl show` output, `Key=value` per line. */
function parseProperties(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/**
 * The real reads. `gh` takes an argv and resolves to what it printed; `systemctl` the same for `--user show`. Both are the caller's, so a test owns them
 * and so does the host (which decides which account `gh` is). `readLastMerge` and `readWaitingRows` are the watcher's own, so "the last merge" and "ready"
 * mean here exactly what they mean in a stall event.
 *
 * `fleet` and `gate` read FILES, not GitHub, so the host that has them names them (`fleet`: the two files `fleet-watch` writes; `gateRecordPath`: the record
 * the tick writes at the end of `main()`). A host that names none gets a reader that refuses and says so, never a guess at a path.
 */
export function createGhReaders({ gh, systemctl, repo, fleet, gateRecordPath, now = Date.now }: {
        gh: (argv: string[]) => Promise<string>; systemctl: (argv: string[]) => Promise<string>; repo: string;
        fleet?: { statePath: string; capturesPath: string; }; gateRecordPath?: string; now?: () => number;
    }): Readers {
  const github = { api: async (path: string) => JSON.parse(await gh(["api", path])) };
  return {
    async issue(number) {
      const issue = await github.api(`repos/${repo}/issues/${number}`);
      // The issues endpoint answers for a pull request too, and "the row's state" of one would be a different fact than its pull request's.
      if (issue.pull_request !== undefined) throw new TypeError(`${number} is a pull request: ask for {{pr:${number}.state}}`);
      return { number: issue.number, state: issue.state, labels: issue.labels.map((label: any) => String(label?.name ?? label)) };
    },
    async pr(number) {
      const [pull, view] = await Promise.all([github.api(`repos/${repo}/pulls/${number}`), gh(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision"])]);
      // `reviewDecision` is EMPTY when the base requires no approval (`.claude/rules/main-review-requirement.md`): that is a reading, and it says "none".
      return { number: pull.number, state: pull.merged_at ? "merged" : pull.state, review: JSON.parse(view).reviewDecision || "none" };
    },
    async run(id) {
      const run = await github.api(`repos/${repo}/actions/runs/${id}`);
      return { status: run.status, conclusion: run.conclusion ?? null };
    },
    async ready() {
      return { count: (await readWaitingRows({ github, repo })).length };
    },
    async open() {
      return { count: await countOpenRows(github, repo) };
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
    async fleet() {
      if (fleet === undefined) throw new TypeError("this host named no fleet-watch state files, so the fleet cannot be read");
      return readFleetRoster({ ...fleet, now: now() });
    },
    async gate() {
      if (gateRecordPath === undefined) throw new TypeError("this host named no work-tick completion record, so the gate cannot be read");
      return readLastTick({ recordPath: gateRecordPath });
    },
    async release(name) {
      // `releases/latest` is the newest PUBLISHED release: a draft or a prerelease is not "the newest release" to the chairman either.
      const release = await github.api(`repos/${name}/releases/latest`);
      return { tag: release.tag_name };
    },
  };
}
