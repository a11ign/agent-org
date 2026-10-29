// module: the board notices a pull request it holds closed without merging, lists the work it still held, keeps it, and posts it on the ticket (A11-249)
//
// THE SWEEP RUNS WITH THE TRACKER'S OWN (`refreshTracker`), over EVERY run that holds a pull request, in any phase: a pull request can be closed while its run is still running (A11-229's was). One request asks the tracker where
// the pull requests of those tickets stand. For each one it names closed, the code host's compare says what the pull request held that its base does not: the commits and the files. That list is written under the ticket's own
// folder (`closed-pulls/<owner>-<repo>-<n>.md` and `.json`), where the next run's brief will read it (step 2 of A11-249), and posted on the ticket. The comment is posted AFTER the record is written and marked `posted` last, so a comment that fails is
// posted again at the next refresh and never makes a second record. A pull request the code host cannot read is asked about again at the next refresh, and nothing is written for it. Nothing here deletes a branch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, messageOf } from "./pool-state.ts";
import { pullsOf } from "./board-view/view-types-and-filters.ts";
import { ticketDir } from "./ticket-paths.ts";
import { CLOSED_PULLS_DIR, closedWorkMarkdown, commentOf, isClosedWorkRecord, recordName, recordOf, type ClosedWorkRecord } from "./closed-work.ts";
import type { ClosedWork } from "../plugins/contracts/code-host.ts";
import { SETTLED, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { PoolContext } from "./pool-context.ts";
import type { PullState } from "./source.ts";

/** The most closed pull requests one refresh reads and posts: each is a read of the code host and a comment, so a long backlog is worked through over several refreshes. */
const MAX_PER_REFRESH = 10;

/** The `.json` and the `.md` of the pull request at `url` on ticket `key`. */
const filesOf = (ctx: PoolContext, key: string, url: string): { json: string; md: string } => {
  const base = join(ticketDir(ctx.settings, key), CLOSED_PULLS_DIR, recordName(url));
  return { json: `${base}.json`, md: `${base}.md` };
};

/** The record at `path`, or null when none is there or it cannot be read: an unreadable record is asked about again, as one that was never written. */
function readRecord(path: string): ClosedWorkRecord | null {
  try {
    const found = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    return isClosedWorkRecord(found) ? found : null;
  } catch (error) {
    void error; // a record that does not parse is rewritten from the code host's own read
    return null;
  }
}

/** Write a record and its list: the list first, so a record is never there without the list a brief names. */
function writeRecord(ctx: PoolContext, { key, url }: Held, record: ClosedWorkRecord): void {
  const { json, md } = filesOf(ctx, key, url);
  mkdirSync(join(ticketDir(ctx.settings, key), CLOSED_PULLS_DIR), { recursive: true });
  writeFileSync(md, closedWorkMarkdown(record));
  writeFileSync(json, `${JSON.stringify(record, null, 2)}\n`);
}

/** A pull request a run holds that has no posted record yet, with its ticket's key and the record it has, if any. */
type Held = Readonly<{ key: string; url: string; record: ClosedWorkRecord | null; known: PullState | undefined }>;

/** Whether the run's own record of a pull request's state says it merged, or its ticket is finished in the tracker (no next run is made for it): there is nothing left to notice. PURE. */
const settled = (entry: Entry, url: string): boolean => entry.pullStates?.[url] === "merged" || SETTLED.has(entry.trackerState ?? "");

/** The pull requests the queue holds that the sweep still has to deal with: each once, though two runs of a ticket may name it. */
function heldPulls(ctx: PoolContext): Held[] {
  const seen = new Set<string>();
  return ctx.store.get().entries.flatMap((entry) => pullsOf(entry).flatMap(({ url }): Held[] => {
    const key = entry.ticket.key;
    const id = `${key} ${url}`;
    if (seen.has(id) || settled(entry, url)) return [];
    seen.add(id);
    const record = readRecord(filesOf(ctx, key, url).json);
    return record?.posted === true ? [] : [{ key, url, record, known: entry.pullStates?.[url] }];
  }));
}

/** Post a record's comment, and mark the record posted once it is. A refusal is said, and the comment is posted again at the next refresh. */
async function post(ctx: PoolContext, held: Held, record: ClosedWorkRecord): Promise<void> {
  if (ctx.source.comment === undefined) return;
  try {
    await ctx.source.comment(held.key, commentOf(record));
  } catch (err) {
    log(`${held.key}: the work of closed pull request #${record.number} could not be posted as a comment, and is posted again at the next refresh: ${messageOf(err)}`);
    return;
  }
  writeRecord(ctx, held, { ...record, posted: true });
}

/** Read what a closed pull request held, keep it, and post it. A read the code host cannot make writes nothing. */
async function keepClosedWork(ctx: PoolContext, held: Held): Promise<void> {
  const { key, url } = held;
  const work = await readWork(ctx, key, url);
  if (work === null) return;
  const made = recordOf(work);
  writeRecord(ctx, held, made);
  log(`${key}: ${url} closed without merging; ${made.kind === "unique" ? `${made.commits.length} commit(s) are not on ${made.base}` : `everything it held is on ${made.base}`}`);
  if (ctx.source.comment === undefined) log(`${key}: this tracker cannot post a comment, so the closed pull request's work is in ${filesOf(ctx, key, url).md} alone`);
  await post(ctx, held, made);
}

/** The pull requests whose unreadable work the pool has already said so of, so a pull request that stays unreadable (a base branch that was deleted) is said once and not at every refresh. */
const unreadable = new WeakMap<PoolContext, Set<string>>();

/** What the code host reads of a closed pull request, or null for "could not ask": said once for each pull request, and asked again at the next refresh. */
async function readWork(ctx: PoolContext, key: string, url: string): Promise<ClosedWork | null> {
  let work: ClosedWork | null = null;
  let why = "the code host did not answer";
  try {
    work = await ctx.codeHost.readClosedWork!(url);
  } catch (err) {
    why = messageOf(err);
  }
  const said = unreadable.get(ctx) ?? new Set<string>();
  unreadable.set(ctx, said);
  if (work !== null) said.delete(url);
  else if (!said.has(url)) {
    said.add(url);
    log(`${key}: what closed pull request ${url} held could not be read, and is asked again at the next refresh: ${why}`);
  }
  return work;
}

/**
 * Which of `held` are closed. A run's own record of its pull requests' states, which this refresh's ordinary read made for the finished runs, is used as it stands; only the pull requests it holds no state for (a run
 * that is still running) are asked of the tracker, for all their tickets in one request. A tracker that cannot be asked says none of those.
 */
async function closedAmong(ctx: PoolContext, held: readonly Held[]): Promise<Held[]> {
  const unknown = held.filter(({ known }) => known === undefined);
  let states: ReadonlyMap<string, Readonly<Record<string, PullState>>> = new Map();
  if (unknown.length > 0 && ctx.source.pullStates !== undefined) {
    try {
      states = await ctx.source.pullStates([...new Set(unknown.map(({ key }) => key))]);
    } catch (err) {
      void err; // the tracker could not be asked: the next refresh asks again
    }
  }
  return held.filter(({ key, url, known }) => (known ?? states.get(key)?.[url]) === "closed");
}

/** The pools whose sweep is running now: two refreshes that overlap must not both post a pull request's comment. */
const sweeping = new WeakSet<PoolContext>();

/**
 * List, keep and post the work of each pull request the board holds that was closed without merging. A record whose comment did not post gets the comment again, with no tracker read and no second record. A code host
 * that reads no closed work lists nothing. Never throws: a refresh goes on past it.
 */
export async function recordClosedWork(ctx: PoolContext): Promise<void> {
  if (ctx.codeHost.readClosedWork === undefined || sweeping.has(ctx)) return;
  sweeping.add(ctx);
  try {
    const held = heldPulls(ctx);
    const unposted = held.filter(({ record: kept }) => kept !== null).slice(0, MAX_PER_REFRESH);
    for (const pull of unposted) await post(ctx, pull, pull.record!);
    const closed = await closedAmong(ctx, held.filter(({ record: kept }) => kept === null));
    for (const pull of closed.slice(0, MAX_PER_REFRESH)) await keepClosedWork(ctx, pull);
  } catch (err) {
    log(`closed pull requests could not be listed, and are asked about again at the next refresh: ${messageOf(err)}`);
  } finally {
    sweeping.delete(ctx);
  }
}
