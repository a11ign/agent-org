// @ts-check
// module: what is wrong with the host itself, said on the board (A11-279, A11-303) -- /tmp over its limit and who is still writing to it, a soft lockup this boot, a serve the board could not put back, and the hang settings drifting
//
// THE 15:20Z CRASH WAS FOUR SLOW FAILURES NOBODY SAW. `/tmp` held 19,960 entries, a kernel thread spent 26 s listing it, and the host's `softlockup_panic = 1` turned the stall into a reboot that killed every run; the serves
// then stayed gone until a person put them back. The chairman's ruling: a soft lockup is LOGGED and the board's alert raises it, the host is not rebooted for one. So the board names each condition on the Runs page, once, with
// when it began, and the alert clears itself when the condition does: nothing here is dismissed, so nothing here goes stale.
//
// THE SLOW READS ARE MADE EVERY {@link HOST_ALERTS_EVERY_MS}, NOT ON EACH TICK. Listing `/tmp` and asking the kernel log are the reads that cost; the exposure's result is the one the tick already holds (`pool-exposure.ts`), so a
// serve that comes back clears its alert in the same pass. A read that fails keeps the last answer, and says so once: "could not read" is not "all well", and not an alert either, since the board cannot name what it did not see.
// A pool made without `deps.hostAlertReads` (every test; the instance passes the machine's) reads nothing of the host, and shows the exposure's alerts alone.
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HANG_CONF_PATH, hangConfFindings, realHostReads, type HostReads } from "../hang-settings.ts";
import { LEGACY_TMP_ROOT } from "./legacy-tmp.ts";
import { type PoolContext } from "./pool-context.ts";
import { log } from "./pool-state.ts";

/** The least time between two reads of the host: the instance ticks every 30 s, and a request to the board wakes a tick sooner. */
export const HOST_ALERTS_EVERY_MS = 60_000;

/** The most entries `/tmp` may hold before the board says so: the chairman's limit (A11-279). */
export const TMP_ENTRY_LIMIT = 1_000;

/** How far back an entry of `/tmp` is "still being written": the alert names the prefixes of the entries modified in this time (A11-303). */
export const TMP_WRITERS_WINDOW_MS = 60 * 60_000;

/** How many prefixes the alert names. */
export const TMP_WRITERS_NAMED = 5;

/** The most entries of `/tmp` whose age is read for the alert, in batches of {@link TMP_WRITERS_BATCH}: the count is of the whole directory, the writers are named from this many. */
export const TMP_WRITERS_EXAMINED = 30_000;
const TMP_WRITERS_BATCH = 64;

/** The longest `journalctl` is given: the read runs inside the tick, which waits for it. */
const JOURNAL_CALL_MS = 5_000;

/** The longest any one read of the host is waited for (`deps.hostReadMs` when a test gives another). A `readdir` cannot be cancelled, and the stall of 2026-10-25 was a listing of `/tmp` that did not return: the tick, which waits for the reads, must not wait for ever. */
export const HOST_READ_MS = 5_000;

/** One condition of the host, as the board words it: a stable id, the sentence, and when it began (ms since the epoch). */
export type HostAlert = Readonly<{ id: string; sentence: string; since: number }>;

/** One prefix of the names in `/tmp`, as `ae-pw-*`, and how many entries modified lately carry it. */
export type TmpWriter = Readonly<{ prefix: string; count: number }>;

/** What the reads last found of the host; null where nothing is to be said (not read yet, or nothing wrong). `softLockupAt`: when this boot's first soft lockup was logged. `hangSettings`: the sentence of what differs. `tmpWriters`: the prefixes of the entries of `/tmp` modified in the last hour, read only while `/tmp` is over its limit. */
type HostReading = { tmpEntries: number | null; tmpWriters: readonly TmpWriter[] | null; softLockupAt: number | null; hangSettings: string | null };

/** The host's reads, each asked on its own so a failing one does not hide the others. Injected: the instance passes {@link liveHostAlertReads}. `tmpWriters` is asked for the entries modified since the time it is given, and only when `/tmp` is over its limit. */
export type HostAlertReads = Readonly<{ tmpEntries: () => Promise<number>; tmpWriters?: (since: number) => Promise<readonly TmpWriter[]>; softLockupAt: () => Promise<number | undefined>; hangSettings: () => string | undefined }>;

/** What the pool keeps of the host's alerts between passes. */
export type HostAlertState = { at: number | null; reading: HostReading; alerts: readonly HostAlert[]; since: Map<string, number>; said: Set<string>; pending: Promise<void> | null };

export const newHostAlertState = (): HostAlertState => ({ at: null, reading: { tmpEntries: null, tmpWriters: null, softLockupAt: null, hangSettings: null }, alerts: [], since: new Map(), said: new Set(), pending: null });

/** The first time in `journalctl -o short-unix` output (`1792941622.123456 host kernel: ...`), in ms, or `undefined` for output with no line. PURE. */
export function firstLogTime(output: string): number | undefined {
  const seconds = /^(\d+(?:\.\d+)?)\s/m.exec(output)?.[1];
  return seconds === undefined ? undefined : Math.round(Number(seconds) * 1000);
}

/** `journalctl` (found on `env`'s PATH, so a test puts a stand-in first) over this boot's kernel log for a soft lockup. `journalctl` exits 1 with nothing printed when no line matches: that is "none", while any other failure is an error. */
export function softLockupInJournal(env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    execFile("journalctl", ["-k", "-b", "--grep", "soft lockup", "-q", "--no-pager", "-o", "short-unix"], { timeout: JOURNAL_CALL_MS, encoding: "utf8", env }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error === null || (code === 1 && stderr.trim() === "")) resolve(firstLogTime(stdout));
      else reject(error);
    });
  });
}

/**
 * What the hang settings differ in, as the hang findings of hang-settings.ts word it (with the root command that fixes it); `undefined` when they match or cannot be read (a read that was refused is not a difference). A host
 * with no `90-a11ign-hang.conf` has not been set up for it (a laptop, a CI runner), so it is not drifted; `host:check` still says so on the agents host.
 */
export function hangDifference(reads: HostReads = realHostReads): string | undefined {
  try {
    reads.readFile(HANG_CONF_PATH);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
  }
  return hangConfFindings(reads).find(({ problem }) => problem === "HANG SETTINGS DIFFER")?.detail;
}

/** `read`'s answer, or a rejection when it has not answered in `ms`. The read itself is not cancelled; its answer is dropped. */
export function withinMs<T>(read: () => Promise<T> | T, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve().then(read), late]).finally(() => clearTimeout(timer));
}

/**
 * The prefix a temporary name starts with, as its source leaves it: the leading words of the name, each ended by a `-`, `_` or `.`, up to three, and not the random tail `mkdtemp` adds. `ae-pw-Xk3j2L` is `ae-pw-*`,
 * `tmp.Xk3j2L` is `tmp.*`, and a name that starts with a number or a long token is `(other)`. A11-303: so a new leak points at the test or tool that makes it. PURE.
 */
export function prefixOf(name: string): string {
  const words = name.split(/(?<=[-_.])/).filter((piece) => /[-_.]$/.test(piece));
  const leading: string[] = [];
  for (const word of words.slice(0, 3)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,7}[-_.]$/.test(word)) break;
    leading.push(word);
  }
  return leading.length === 0 ? "(other)" : `${leading.join("")}*`;
}

/** The {@link TMP_WRITERS_NAMED} prefixes most of `names` carry, most first and by name among equals. PURE. */
export function topPrefixes(names: readonly string[]): readonly TmpWriter[] {
  const counts = new Map<string, number>();
  for (const prefix of names.map(prefixOf)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  return [...counts].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)).slice(0, TMP_WRITERS_NAMED);
}

/**
 * The prefixes of the entries of `root` modified since `since`, who is still writing there. One `readdir` (the listing the count already makes), then an `lstat` of each of at most {@link TMP_WRITERS_EXAMINED} entries in
 * batches, so it neither holds the thread nor reads a directory of a million entries one by one; an entry that is gone by then is not counted.
 */
export async function tmpWritersIn(root: string, since: number): Promise<readonly TmpWriter[]> {
  const names = (await readdir(root)).slice(0, TMP_WRITERS_EXAMINED);
  const recent: string[] = [];
  for (let at = 0; at < names.length; at += TMP_WRITERS_BATCH) {
    const batch = await Promise.all(names.slice(at, at + TMP_WRITERS_BATCH).map(async (name) => {
      try {
        return (await lstat(join(root, name))).mtimeMs >= since ? name : null;
      } catch {
        return null;
      }
    }));
    recent.push(...batch.filter((name): name is string => name !== null));
  }
  return topPrefixes(recent);
}

/** The machine's reads: `/tmp`'s entries (one `readdir`, as `prune-tmp.ts` counts them) and, while it is over its limit, the prefixes of the entries of the last hour; this boot's kernel log, and the hang settings against the text hang-settings.ts holds. */
export function liveHostAlertReads(): HostAlertReads {
  return { tmpEntries: async () => (await readdir(LEGACY_TMP_ROOT)).length, tmpWriters: (since) => tmpWritersIn(LEGACY_TMP_ROOT, since), softLockupAt: () => softLockupInJournal(), hangSettings: hangDifference };
}

/** An alert before it has a time: its id and sentence, and the time the condition says of itself, when it does (a soft lockup's is its log line's). */
type Condition = Readonly<{ id: string; sentence: string; at?: number }>;

const SERVICE_NAME: Readonly<Record<string, string>> = { ui: "board", terminal: "terminal" };

/** The alerts the exposure's last check raises: a serve that is not in place and could not be put back, and a port another entry holds, which the board leaves alone. Each is the service's and clears when its serve is present. PURE. */
function serveConditions(ctx: PoolContext): readonly Condition[] {
  return ctx.exposure.checks.flatMap((check) => {
    const where = `${SERVICE_NAME[check.service] ?? check.service} serve${check.port === null ? "" : ` on port ${check.port}`}`;
    if (check.state === "refused") return [{ id: `serve:${check.service}`, sentence: `The ${where} is not in place, and the board could not put it back: ${check.why}. Terminal links stop working until it is.` }];
    if (check.state === "foreign") return [{ id: `serve:${check.service}`, sentence: `The ${where} is held by another entry, which the board leaves alone: ${check.why}.` }];
    return [];
  });
}

/** What the alert says of who is writing to `/tmp`: the prefixes of the last hour's entries, or that there are none (then what is there is old, and the sweep is what clears it). Nothing when the writers were not read. PURE. */
function writersSentence(writers: readonly TmpWriter[] | null): string {
  if (writers === null) return "";
  if (writers.length === 0) return " Nothing in it was modified in the last hour: it is all old.";
  return ` Entries modified in the last hour start with ${writers.map(({ prefix, count }) => `${prefix} (${count.toLocaleString("en-US")})`).join(", ")}.`;
}

/** The alerts the last reading raises. PURE. */
function readingConditions(reading: HostReading): readonly Condition[] {
  const { tmpEntries, tmpWriters, softLockupAt, hangSettings } = reading;
  return [
    ...(tmpEntries !== null && tmpEntries > TMP_ENTRY_LIMIT ? [{ id: "tmp-entries", sentence: `/tmp holds ${tmpEntries.toLocaleString("en-US")} entries, over the ${TMP_ENTRY_LIMIT.toLocaleString("en-US")} it should stay under. Listing a directory that size stalled the host's kernel on 2026-10-25.${writersSentence(tmpWriters)}` }] : []),
    ...(softLockupAt === null ? [] : [{ id: "soft-lockup", at: softLockupAt, sentence: "The kernel logged a soft lockup this boot (a CPU stuck in the kernel for seconds). The host is not rebooted for one: look at the kernel log (journalctl -k -b --grep 'soft lockup')." }]),
    ...(hangSettings === null ? [] : [{ id: "hang-settings", sentence: hangSettings }]),
  ];
}

/** Recompute the alerts: a condition keeps the time it began at while it holds, and one that no longer holds is forgotten, so a later return begins again. */
function settle(ctx: PoolContext): void {
  const { hostAlerts: state } = ctx;
  const conditions = [...readingConditions(state.reading), ...serveConditions(ctx)];
  const began = state.since;
  state.since = new Map();
  state.alerts = conditions.map(({ id, sentence, at }): HostAlert => {
    const since = at ?? began.get(id) ?? ctx.now();
    state.since.set(id, since);
    return { id, sentence, since };
  });
}

/** Ask one read, and keep `previous` when it fails, saying so once. */
async function attempt<T>(state: HostAlertState, name: string, read: () => Promise<T> | T, previous: T, ms: number): Promise<T> {
  try {
    return await withinMs(read, ms, name);
  } catch (err) {
    if (!state.said.has(name)) {
      state.said.add(name);
      log(`${name} could not be read, so its alert keeps the last answer: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    return previous;
  }
}

async function readHost(ctx: PoolContext, reads: HostAlertReads): Promise<void> {
  const { hostAlerts: state } = ctx;
  state.at = ctx.now();
  const { reading } = state;
  const ms = ctx.deps.hostReadMs ?? HOST_READ_MS;
  reading.tmpEntries = await attempt(state, "the host's /tmp listing", reads.tmpEntries, reading.tmpEntries, ms);
  // Who is writing is asked only while there is a reason to: a directory under its limit is not listed again entry by entry.
  const over = reading.tmpEntries !== null && reading.tmpEntries > TMP_ENTRY_LIMIT;
  reading.tmpWriters = over && reads.tmpWriters !== undefined ? await attempt(state, "the host's /tmp entries of the last hour", () => reads.tmpWriters!(ctx.now() - TMP_WRITERS_WINDOW_MS), reading.tmpWriters, ms) : null;
  reading.softLockupAt = await attempt(state, "the host's kernel log", async () => (await reads.softLockupAt()) ?? null, reading.softLockupAt, ms);
  reading.hangSettings = await attempt(state, "the host's hang settings", () => reads.hangSettings() ?? null, reading.hangSettings, ms);
  settle(ctx);
}

/**
 * Bring the host's alerts up to date, in the tick after the serves were checked: the exposure's alerts at once, and the slow reads when {@link HOST_ALERTS_EVERY_MS} has passed since the last, started and NOT waited for. The
 * tick holds the board thread's whole pass (`pass.busy`), and a listing of `/tmp` or a `journalctl` that is slow would hold every later step of it; the alerts are a banner, which can wait for a read, and the pass cannot. A read
 * is not started while the last is still out, and never throws. {@link hostAlertsSettled} waits for it.
 */
export function refreshHostAlerts(ctx: PoolContext): void {
  const { hostAlertReads: reads } = ctx.deps;
  const state = ctx.hostAlerts;
  settle(ctx);
  if (reads === undefined || !readDue(ctx)) return;
  state.pending = readHost(ctx, reads).finally(() => { state.pending = null; });
}

/** Whether the slow reads are due: none is out, and {@link HOST_ALERTS_EVERY_MS} has passed since the last started (or none has). */
function readDue({ hostAlerts: { at, pending }, now }: PoolContext): boolean {
  return pending === null && (at === null || now() - at >= HOST_ALERTS_EVERY_MS);
}

/** Settles once the host read that {@link refreshHostAlerts} last started has answered and the alerts are settled on it (at once when none is out). Never rejects. */
export const hostAlertsSettled = (ctx: PoolContext): Promise<void> => ctx.hostAlerts.pending ?? Promise.resolve();
