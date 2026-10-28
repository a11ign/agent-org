// module: how many calls the plugin makes to GitHub, and how often (A11-365) -- the count `/api/health` serves and the line the plugin logs
//
// EVERY `gh` THE PLUGIN STARTS IS COUNTED, at the one seam they all go through (`countingDeps` wraps `deps.exec` and `deps.execAsync`), so a reader added later is counted without being told to. A call is a
// `graphql` one (`gh api graphql`), a `rest` one (`gh api <path>`), or a `cli` one (any other `gh` command, which spends the same pools on its own). A conditional read that GitHub answered 304 is counted
// where it was made and again under `notModified`, because that is the call whose cost is nil (A11-365).
//
// A SWEEP IS ONE WINDOW OF `SWEEP_MS`, the length a repository's snapshot is kept for (`pull-snapshot.ts`): every reader in a window shares the snapshot the first one made, so the calls in a window are the
// calls of one sweep. The counter keeps the window open from its first call, and writes the closed window's line and the last minute's line when the next call arrives (no timer: a quiet plugin writes nothing).
import type { GithubCallCounts } from "../../src/plugins/contracts/call-counts.ts";
import type { ExecOptions, ExecResult, PluginDeps } from "../../src/plugins/manifest.ts";

export type { GithubCallCounts };

/** The length of a sweep window and the repository snapshot's life, in ms. */
export const SWEEP_MS = 30_000;

/** The span the per-minute figure covers, in ms. */
export const MINUTE_MS = 60_000;

/** The kinds a call is counted under. */
export type CallKind = "graphql" | "rest" | "cli";

/** The kind of a `gh` call, from its arguments. */
export function kindOf(args: readonly string[]): CallKind {
  if (args[0] !== "api") return "cli";
  return args.includes("graphql") ? "graphql" : "rest";
}

export type CallCounter = Readonly<{
  /** Counts one call that is about to be made. */
  record(args: readonly string[]): void;
  /** Counts that a call just counted was a conditional read GitHub answered with 304. */
  notModified(): void;
  /** The counts now. */
  read(): GithubCallCounts;
}>;

export type CallCounterDeps = Readonly<{ now?: () => number; log?: (line: string) => void }>;

const plural = (calls: number): string => `${calls} call${calls === 1 ? "" : "s"}`;

/** A counter of the plugin's calls. */
export function createCallCounter({ now = Date.now, log = () => undefined }: CallCounterDeps = {}): CallCounter {
  const since = now();
  const byKind: Record<CallKind, number> = { graphql: 0, rest: 0, cli: 0 };
  let total = 0;
  let unchanged = 0;
  let recent: number[] = [];
  let sweepStart: number | null = null;
  let sweepCalls = 0;
  let lastSweep: GithubCallCounts["lastSweep"] = null;
  let minuteLogged = since;

  const prune = (at: number): void => { recent = recent.filter((stamp) => stamp > at - MINUTE_MS); };

  /** Closes the window that has run out and writes its line, and the minute's line when a minute has passed since the last one. */
  function settle(at: number): void {
    if (sweepStart !== null && at - sweepStart >= SWEEP_MS) {
      lastSweep = { at: new Date(sweepStart).toISOString(), calls: sweepCalls };
      log(`github: sweep of ${new Date(sweepStart).toISOString()} made ${plural(sweepCalls)}`);
      sweepStart = null;
      sweepCalls = 0;
    }
    if (at - minuteLogged >= MINUTE_MS) {
      prune(at);
      log(`github: ${plural(recent.length)} in the last minute (${total} since start, ${unchanged} answered 304)`);
      minuteLogged = at;
    }
  }

  return {
    record(args) {
      const at = now();
      settle(at);
      byKind[kindOf(args)] += 1;
      total += 1;
      recent.push(at);
      sweepStart ??= at;
      sweepCalls += 1;
    },
    notModified() {
      unchanged += 1;
    },
    read() {
      const at = now();
      prune(at);
      return { since: new Date(since).toISOString(), total, perMinute: recent.length, notModified: unchanged, byKind: { ...byKind },
        currentSweep: sweepStart === null ? null : { at: new Date(sweepStart).toISOString(), calls: sweepCalls }, lastSweep };
    },
  };
}

/** `deps` with `gh` counted: `exec` and `execAsync` tell `counter` of every `gh` they start. Any other program is not a call to GitHub. */
export function countingDeps(deps: PluginDeps, counter: CallCounter): PluginDeps {
  return {
    ...deps,
    exec: (file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
      if (file === "gh") counter.record(args);
      return deps.exec(file, args, options);
    },
    execAsync: (file: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
      if (file === "gh") counter.record(args);
      return deps.execAsync(file, args, options);
    },
  };
}
