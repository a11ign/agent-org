// @ts-check
// module: the pull requests a running run waits on or opened (A11-358) -- recorded on the run, and watched for feedback while its worker sits idle
//
// A RUN THAT WAITS ON ITS OWN BLOCKED PULL REQUEST WAITED FOR EVER (A11-254, 2026-10-27): its worker wrote `working` with `waitingOn` toolchain#60 `merged`, a review asked for changes on #60 ten minutes later, and nothing routed that review to
// the run, which read running and working. The feedback watch (`watchFeedback`) reads the pull requests of FINISHED runs, so a run that had not finished had none. Two things are added here.
//   1. The pull requests a run opened while it ran, which the hook records (`opened-record.ts`), are kept on the run (`Entry.opened`) and so are its pull requests, whatever its outcome lists.
//   2. A run whose worker sits idle on a `working` note has the pull requests it waits on (`waitingOn` a pull request) and those it opened read as a run's own are, once a minute: a review asking for changes at the head, a red required check
//      or a conflict is told to the worker at once with one prompt, for each head, and not at its `until`. A changes-requested review that stands for an hour with the worker idle ends the run `needs-human`, naming why, so it reads Needs you.
import { readOpenedRecord } from "./opened-record.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf, runMembers, runPlace, updateEach } from "./pool-state.ts";
import { sendToAgent, utcClock } from "./pool-resume.ts";
import { end } from "./pool-settle.ts";
import { escalationReason } from "./escalation.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import { recordFed, recordOpened } from "./queue/queue-wait-pulls.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { type PullTrouble, troubleOf, troublePrompt, WAITED_BLOCK_MINUTES } from "./wait-on/wait-pulls.ts";
import type { FedTrouble } from "./wait-on/wait-types.ts";

/** The least time between two reads of the pull requests of one run: one minute, as the wait's own reads are. */
const MINUTE_MS = 60_000;
const READ_EVERY_MS = MINUTE_MS;

/** Say in the log, once for each run and problem, what is wrong with the record of the pull requests a run opened: until it reads whole, one it opened since may not be watched. Nothing recorded earlier is forgotten. */
function sayOnce({ recordSaid }: PoolContext, entry: Entry, problem: string | null): void {
  const said = `${entry.ticket.key}: ${problem}`;
  if (problem === null || recordSaid.has(said)) return;
  recordSaid.add(said);
  log(`${entry.batch ?? entry.ticket.key}: ${problem}, so a pull request it opened since the last read may not be watched; the pull requests already recorded still are`);
}

/** Keep the pull requests a running run opened on the run (A11-358). Written only when the hook's record holds an address the run does not have. */
export function recordOpenedPulls(ctx: PoolContext, entry: Entry): void {
  const { pulls: opened, problem } = readOpenedRecord(runPlace(ctx, entry).dir);
  sayOnce(ctx, entry, problem);
  const held = new Set((entry.opened ?? []).map(({ url }) => url));
  if (opened.every(({ url }) => held.has(url))) return;
  updateEach(ctx, runMembers(ctx, entry), (queue, key) => recordOpened(queue, key, opened));
  log(`${entry.batch ?? entry.ticket.key} opened ${opened.filter(({ url }) => !held.has(url)).map(({ url }) => pullLabel(url)).join(", ")}, which the board now watches as its own`);
}

/** The pull requests to read for an idle worker, by address: those its `working` note waits on, and those it opened that are not known to have merged or closed. A wait `until: "reviewed"` is marked `reviewIsTheWait`, since its review is the wait's own end. */
function watchedPulls(entry: Entry): ReadonlyMap<string, { reviewIsTheWait: boolean }> {
  const waited = (entry.working?.waits ?? []).flatMap((wait) => (wait.kind === "pullRequest" ? [[wait.url, { reviewIsTheWait: wait.until === "reviewed" }] as const] : []));
  const opened = openPulls({ opened: entry.opened }).filter(({ url }) => entry.pullStates?.[url] !== "merged" && entry.pullStates?.[url] !== "closed");
  return new Map([...opened.map(({ url }) => [url, { reviewIsTheWait: false }] as const), ...waited]);
}

/** What a read of a run's pull requests found: the ones that need its worker now, with what is wrong with each, and the ones the host could not be asked about, whose record is left as it is. */
type Troubles = Readonly<{ found: ReadonlyMap<string, PullTrouble>; unread: ReadonlySet<string> }>;

/** The pull requests of a run read once. A pull request the host could not be asked about is said, and is not read as clear: the next watch asks again. */
async function troublesOf(ctx: PoolContext, entry: Entry, self: string): Promise<Troubles> {
  const { codeHost, feedbackIgnores } = ctx;
  const found = new Map<string, PullTrouble>();
  const unread = new Set<string>();
  for (const [url, wait] of watchedPulls(entry)) {
    let read: PullFeedback | null;
    try {
      read = await codeHost.readPullFeedback(url, self, feedbackIgnores);
    } catch (err) {
      read = null;
      log(`${entry.ticket.key}: ${url} could not be read for the wait (${messageOf(err).split("\n")[0]}); the next watch asks again`);
    }
    const trouble = read === null ? null : troubleOf(url, read, wait);
    if (read === null) unread.add(url);
    if (trouble !== null) found.set(url, trouble);
  }
  return { found, unread };
}

/** Whether `fed` already says the worker was told of `trouble`: the same head and the same kinds, and the prompt was delivered. */
const wasTold = (fed: FedTrouble | undefined, trouble: PullTrouble): boolean => fed?.sig === trouble.sig && fed.told !== undefined;

/**
 * What the board recorded for each trouble after this pass: the time it first saw the same trouble kept, the delivery of its prompt kept or made now, and a refusal said. A pull request that could not be read keeps the record it had, so a
 * read that failed neither tells the worker again nor starts the hour over.
 */
function fedAfter({ found, unread }: Troubles, before: Readonly<Record<string, FedTrouble>>, now: number, delivery: Readonly<{ told: boolean; refusal: string | null }>): Record<string, FedTrouble> {
  const kept = Object.entries(before).filter(([url]) => unread.has(url));
  return Object.fromEntries([...kept, ...[...found].map(([url, trouble]) => {
    const earlier = before[url]?.sig === trouble.sig ? before[url] : undefined;
    const told = wasTold(earlier, trouble) ? earlier?.told : delivery.told ? now : undefined;
    const refusal = told === undefined ? delivery.refusal ?? earlier?.refusal : undefined;
    return [url, { sig: trouble.sig, since: earlier?.since ?? now, ...(told === undefined ? {} : { told }), ...(refusal === null || refusal === undefined ? {} : { refusal }) }] as const;
  })]);
}

/** Why a standing review is a person's: the first pull request whose changes-requested review has stood for {@link WAITED_BLOCK_MINUTES} minutes with the worker idle, with what was done about it. Null while none has. */
function standingBlock({ found }: Troubles, fed: Readonly<Record<string, FedTrouble>>, now: number): string | null {
  for (const [url, trouble] of found) {
    const record = fed[url];
    if (!trouble.changes || record === undefined || now - record.since < WAITED_BLOCK_MINUTES * MINUTE_MS) continue;
    const done = record.told === undefined ? `its worker could not be told (${record.refusal ?? "its prompt was refused"})` : `its worker was told at ${utcClock(record.told)} and has not pushed`;
    return `${pullLabel(url)} has had a review asking for changes since ${utcClock(record.since)}, and the run is idle waiting on it: ${done}`;
  }
  return null;
}

/** Tell the worker, with one prompt, of the pull requests in `fresh`, and say so in the log. Returns herdr's refusal, or null when it took the prompt or there was nothing to tell. */
function tellWorker(ctx: PoolContext, entry: Entry, fresh: readonly (readonly [string, PullTrouble])[]): string | null {
  if (fresh.length === 0) return null;
  const who = entry.batch ?? entry.ticket.key;
  const named = fresh.map(([url]) => pullLabel(url)).join(", ");
  const refusal = sendToAgent(ctx, runPlace(ctx, entry), troublePrompt(fresh.map(([, trouble]) => trouble.line)));
  log(refusal === null ? `${who} was told of ${named}` : `${who} could not be told of ${named}: ${refusal}`);
  return refusal;
}

/** Whether the pull requests of a run were read less than {@link READ_EVERY_MS} ago, `last` being when. */
const readRecently = (last: number | undefined, at: number): boolean => last !== undefined && at - last < READ_EVERY_MS;

/** Whether a run's agent sits at a prompt on a `working` note: the only run this watch reads for. */
const idleOnWorkingNote = (entry: Entry, seen: string): boolean => entry.phase === "running" && entry.working !== undefined && (seen === "idle" || seen === "done");

/**
 * Watch the pull requests an idle run waits on or opened (A11-358). Called for a running run on each pass that finds its agent idle or done with a `working` note; at most one read a minute. The worker is told, with one prompt for all of them, of every
 * pull request that has trouble at a head it has not been told of; a prompt herdr refuses is offered again on the next read. A review asking for changes that has stood for {@link WAITED_BLOCK_MINUTES} minutes ends the run `needs-human`, naming
 * the pull request and what was done, so it reads Needs you. A pull request that is clear of its trouble drops its record.
 */
export function watchWaitedPulls(ctx: PoolContext, entry: Entry, seen: string): void {
  const { now, pullReadAt, waitReading } = ctx;
  if (!idleOnWorkingNote(entry, seen)) return;
  const place = runPlace(ctx, entry);
  const last = pullReadAt.get(place.name);
  if (waitReading.has(place.name) || watchedPulls(entry).size === 0 || readRecently(last, now())) return;
  pullReadAt.set(place.name, now());
  waitReading.add(place.name);
  // The host's reads answer a promise (A11-356): the pass does not hold for them, and a read still under way is not started again.
  readAndTell(ctx, entry).catch((err) => log(`${entry.ticket.key}: the pull requests it waits on could not be watched (${messageOf(err).split("\n")[0]}); the next watch asks again`)).finally(() => waitReading.delete(place.name));
}

/** One read of the pull requests an idle run waits on, and what follows from it: the prompt, the record, and the hour's end. The run is read again from the store after the reads, since it may have moved on while the host answered. */
async function readAndTell(ctx: PoolContext, started: Entry): Promise<void> {
  const { codeHost, now } = ctx;
  ctx.ownLogin.value ??= await codeHost.readOwnLogin();
  const self = ctx.ownLogin.value;
  if (self === null) return log("the GitHub account the workers use could not be read, so no pull request a run waits on was checked");
  const troubles = await troublesOf(ctx, started, self);
  const entry = ctx.store.get().entries.find((each) => each.ticket.key === started.ticket.key);
  if (entry === undefined || entry.working === undefined || entry.phase !== "running") return;
  const before = entry.working?.fed ?? {};
  const fresh = [...troubles.found].filter(([url, trouble]) => !wasTold(before[url], trouble));
  const refusal = tellWorker(ctx, entry, fresh);
  const fed = fedAfter(troubles, before, now(), { told: fresh.length > 0 && refusal === null, refusal });
  if (JSON.stringify(fed) !== JSON.stringify(before)) updateEach(ctx, runMembers(ctx, entry), (queue, key) => recordFed(queue, key, fed));
  const block = standingBlock(troubles, fed, now());
  if (block !== null) end(ctx, ctx.store.get().entries.find((each) => each.ticket.key === entry.ticket.key) ?? entry, { kind: "needs-human", reason: escalationReason(undefined, block) });
}
