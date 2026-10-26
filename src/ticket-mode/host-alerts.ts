// @ts-check
// module: what is wrong with the host itself, said on the board (A11-279) -- /tmp over its limit, a soft lockup this boot, a serve the board could not put back, and the hang settings drifting
//
// THE 15:20Z CRASH WAS FOUR SLOW FAILURES NOBODY SAW. `/tmp` held 19,960 entries, a kernel thread spent 26 s listing it, and the host's `softlockup_panic = 1` turned the stall into a reboot that killed every run; the serves
// then stayed gone until a person put them back. The chairman's ruling: a soft lockup is LOGGED and the board's alert raises it, the host is not rebooted for one. So the board names each condition on the Runs page, once, with
// when it began, and the alert clears itself when the condition does: nothing here is dismissed, so nothing here goes stale.
//
// THE SLOW READS ARE MADE EVERY {@link HOST_ALERTS_EVERY_MS}, NOT ON EACH TICK. Listing `/tmp` and asking the kernel log are the reads that cost; the exposure's result is the one the tick already holds (`pool-exposure.ts`), so a
// serve that comes back clears its alert in the same pass. A read that fails keeps the last answer, and says so once: "could not read" is not "all well", and not an alert either, since the board cannot name what it did not see.
// A pool made without `deps.hostAlertReads` (every test; the instance passes the machine's) reads nothing of the host, and shows the exposure's alerts alone.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { hangConfFindings, realHostReads } from "../hang-settings.ts";
import { type PoolContext } from "./pool-context.ts";
import { log } from "./pool-state.ts";

/** The least time between two reads of the host: the instance ticks every 30 s, and a request to the board wakes a tick sooner. */
export const HOST_ALERTS_EVERY_MS = 60_000;

/** The most entries `/tmp` may hold before the board says so: the chairman's limit (A11-279). */
export const TMP_ENTRY_LIMIT = 1_000;

/** The longest `journalctl` is given: the read runs inside the tick, which waits for it. */
const JOURNAL_CALL_MS = 5_000;

/** One condition of the host, as the board words it: a stable id, the sentence, and when it began (ms since the epoch). */
export type HostAlert = Readonly<{ id: string; sentence: string; since: number }>;

/** What the reads last found of the host; null where nothing is to be said (not read yet, or nothing wrong). `softLockupAt`: when this boot's first soft lockup was logged. `hangSettings`: the sentence of what differs. */
type HostReading = { tmpEntries: number | null; softLockupAt: number | null; hangSettings: string | null };

/** The host's reads, each asked on its own so a failing one does not hide the others. Injected: the instance passes {@link liveHostAlertReads}. */
export type HostAlertReads = Readonly<{ tmpEntries: () => Promise<number>; softLockupAt: () => Promise<number | undefined>; hangSettings: () => string | undefined }>;

/** What the pool keeps of the host's alerts between passes. */
export type HostAlertState = { at: number | null; reading: HostReading; alerts: readonly HostAlert[]; since: Map<string, number>; said: Set<string> };

export const newHostAlertState = (): HostAlertState => ({ at: null, reading: { tmpEntries: null, softLockupAt: null, hangSettings: null }, alerts: [], since: new Map(), said: new Set() });

/** The first time in `journalctl -o short-unix` output (`1792941622.123456 host kernel: ...`), in ms, or `undefined` for output with no line. PURE. */
export function firstLogTime(output: string): number | undefined {
  const seconds = /^(\d+(?:\.\d+)?)\s/m.exec(output)?.[1];
  return seconds === undefined ? undefined : Math.round(Number(seconds) * 1000);
}

/** `journalctl` over this boot's kernel log for a soft lockup. `journalctl` exits 1 with nothing printed when no line matches: that is "none", while any other failure is an error. */
export function softLockupInJournal(program = "journalctl"): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    execFile(program, ["-k", "-b", "--grep", "soft lockup", "-q", "--no-pager", "-o", "short-unix"], { timeout: JOURNAL_CALL_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (error === null || (code === 1 && stderr.trim() === "")) resolve(firstLogTime(stdout));
      else reject(error);
    });
  });
}

/** What the hang settings differ in, as the hang findings of hang-settings.ts word it (with the root command that fixes it); `undefined` when they match or cannot be read: a read that was refused is not a difference. */
function hangDifference(): string | undefined {
  return hangConfFindings(realHostReads).find(({ problem }) => problem === "HANG SETTINGS DIFFER")?.detail;
}

/** The machine's reads: `/tmp`'s entries (one `readdir`, as `prune-tmp.ts` counts them), this boot's kernel log, and the hang settings against the text hang-settings.ts holds. */
export function liveHostAlertReads(): HostAlertReads {
  return { tmpEntries: async () => (await readdir("/tmp")).length, softLockupAt: () => softLockupInJournal(), hangSettings: hangDifference };
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

/** The alerts the last reading raises. PURE. */
function readingConditions(reading: HostReading): readonly Condition[] {
  const { tmpEntries, softLockupAt, hangSettings } = reading;
  return [
    ...(tmpEntries !== null && tmpEntries > TMP_ENTRY_LIMIT ? [{ id: "tmp-entries", sentence: `/tmp holds ${tmpEntries.toLocaleString("en-US")} entries, over the ${TMP_ENTRY_LIMIT.toLocaleString("en-US")} it should stay under. Listing a directory that size stalled the host's kernel on 2026-10-25.` }] : []),
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
async function attempt<T>(state: HostAlertState, name: string, read: () => Promise<T> | T, previous: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!state.said.has(name)) {
      state.said.add(name);
      log(`the host's ${name} could not be read, so its alert keeps the last answer: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    return previous;
  }
}

async function readHost(ctx: PoolContext, reads: HostAlertReads): Promise<void> {
  const { hostAlerts: state } = ctx;
  state.at = ctx.now();
  const { reading } = state;
  reading.tmpEntries = await attempt(state, "/tmp listing", reads.tmpEntries, reading.tmpEntries);
  reading.softLockupAt = await attempt(state, "kernel log", async () => (await reads.softLockupAt()) ?? null, reading.softLockupAt);
  reading.hangSettings = await attempt(state, "hang settings", () => reads.hangSettings() ?? null, reading.hangSettings);
  settle(ctx);
}

/**
 * Bring the host's alerts up to date, in the tick after the serves were checked: the exposure's alerts at once, and the slow reads when {@link HOST_ALERTS_EVERY_MS} has passed since the last. Null when no read is due, so
 * a pass that has nothing to read gives up no turn of the event loop; a read never throws.
 */
export function refreshHostAlerts(ctx: PoolContext): Promise<void> | null {
  const { hostAlertReads: reads } = ctx.deps;
  const { at } = ctx.hostAlerts;
  if (reads === undefined || (at !== null && ctx.now() - at < HOST_ALERTS_EVERY_MS)) {
    settle(ctx);
    return null;
  }
  return readHost(ctx, reads);
}
