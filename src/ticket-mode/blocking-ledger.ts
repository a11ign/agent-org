// @ts-check
// module: which synchronous spawns held this process's loop, and for how long (A11-282) -- a count, the total and the longest call of each call site
//
// THE SPAWNS ARE TIMED WHERE NODE MAKES THEM, NOT WHERE THEY ARE WRITTEN. There are hundreds of `spawnSync`, `execFileSync` and `execSync` calls in `src/` and `plugins/`.
// `install` puts a timed wrapper in place of each of the three on `node:child_process` and calls `syncBuiltinESMExports`, so the named imports every module already holds
// go through the wrappers too. No call site is edited.
//
// A WRAPPER CHANGES NOTHING. It calls the original with the same arguments and answers, or throws, what the original did. It only measures.
//
// THE CALL SITE IS THE CODE THAT ASKED, as `path:line` from the checkout's root: the first frame of the stack outside Node, this file and the SEAMS, the modules whose one job
// is to hand a spawn on (`realExec`, and the `gh` runner made of it), which would otherwise stand for every plugin call at once. A call that holds the loop
// SLOW_MS or more is written to stderr as one line when it returns.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const CHECKOUT = join(dirname(HERE), "..", "..");
/** A call that holds the loop this long, in ms, is logged as it returns. */
export const SLOW_MS = 250;
/** The modules that only pass a spawn on: a frame in one of them is not the call site. Paths from the checkout's root. */
const SEAMS: readonly string[] = ["src/plugins/real-seams.ts", "plugins/github/gh.ts"];
const SYNC_SPAWNS = ["spawnSync", "execFileSync", "execSync"] as const;
type SyncSpawn = (typeof SYNC_SPAWNS)[number];

/** One call site's account: the program it ran, how many calls, their total and the longest, in ms. */
export type BlockingSite = Readonly<{ site: string; program: string; count: number; totalMs: number; maxMs: number }>;

export type LedgerDeps = Readonly<{
  /** The clock the calls are timed by, in ms. */
  now?: () => number;
  /** Where a slow call is said. */
  err?: (line: string) => void;
  /** The name the slow-call line starts with: the command, such as `ticket:serve`. */
  name?: string;
  /** The stack the call site is read from: this call's own unless a test gives one. */
  stack?: () => string;
}>;

export type BlockingLedger = Readonly<{
  /** `original`, timed into this ledger as `kind`. */
  wrap: <F extends (...args: never[]) => unknown>(kind: SyncSpawn, original: F) => F;
  /** Puts the wrappers in place on `node:child_process`, once however often it is called, and answers how to put the originals back. */
  install: () => () => void;
  /** The `count` sites with the most time held in total, the worst first. */
  worst: (count: number) => readonly BlockingSite[];
}>;

/** The program a synchronous spawn ran: the file's own name, or a command line's first word for `execSync`, and `node` for this Node. PURE. */
export function programOf(kind: SyncSpawn, first: unknown): string {
  const text = typeof first === "string" ? first : String(first);
  const file = kind === "execSync" ? (text.trim().split(/\s+/)[0] ?? "") : text;
  return file === process.execPath ? "node" : basename(file);
}

/** A stack frame's file and line, as `at fn (file:line:col)` or `at file:line:col` write it, or null when it names none. PURE. */
function frameOf(line: string): Readonly<{ file: string; line: string }> | null {
  const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):\d+\)?\s*$/.exec(line.trim());
  if (match === null || !line.trim().startsWith("at ")) return null;
  const file = match[1].startsWith("file://") ? fileURLToPath(match[1]) : match[1];
  return { file, line: match[2] };
}

/** The call site a stack names: the first frame outside Node, this file and the seams, as `path:line` from `root`, or `unknown`. PURE. */
export function callSiteOf(stack: string, root: string = CHECKOUT, own: string = HERE): string {
  for (const line of stack.split("\n").slice(1)) {
    const frame = frameOf(line);
    if (frame === null || frame.file.startsWith("node:") || frame.file === own) continue;
    const path = frame.file.startsWith("/") ? relative(root, frame.file) : frame.file;
    if (SEAMS.includes(path)) continue;
    return `${path}:${frame.line}`;
  }
  return "unknown";
}

const ownStack = (): string => {
  const { stackTraceLimit } = Error;
  // The frames of the seams and the wrappers come first, so the default ten could stop before the code that asked.
  Error.stackTraceLimit = 30;
  try {
    return new Error("call site").stack ?? "";
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
};

const round = (ms: number): number => Math.round(ms * 10) / 10;

/** A ledger of this process's synchronous spawns. `install` it once at start; `worst` reads it. */
export function createBlockingLedger({ now = () => performance.now(), err = (line) => process.stderr.write(line), name = "agent-org", stack = ownStack }: LedgerDeps = {}): BlockingLedger {
  const sites = new Map<string, { site: string; program: string; count: number; totalMs: number; maxMs: number }>();
  let uninstall: (() => void) | null = null;

  function record(site: string, program: string, ms: number): void {
    const key = `${site} ${program}`;
    const account = sites.get(key) ?? { site, program, count: 0, totalMs: 0, maxMs: 0 };
    account.count += 1;
    account.totalMs += ms;
    account.maxMs = Math.max(account.maxMs, ms);
    sites.set(key, account);
    if (ms >= SLOW_MS) err(`${name}: a synchronous ${program} held the loop ${Math.round(ms)} ms, at ${site}\n`);
  }

  /** Counts one call. A ledger that cannot count it (a stack it cannot read, a stderr that refuses the line) counts nothing, and never stands in for the spawn's own answer. */
  function count(kind: SyncSpawn, first: unknown, ms: number): void {
    try {
      record(callSiteOf(stack()), programOf(kind, first), ms);
    } catch {
      // Measuring is never worth changing what the spawn answered.
    }
  }

  function wrap<F extends (...args: never[]) => unknown>(kind: SyncSpawn, original: F): F {
    return function timed(this: unknown, ...args: Parameters<F>): ReturnType<F> {
      const started = now();
      try {
        return original.apply(this, args) as ReturnType<F>;
      } finally {
        count(kind, args[0], now() - started);
      }
    } as F;
  }

  function install(): () => void {
    if (uninstall !== null) return uninstall;
    const originals = Object.fromEntries(SYNC_SPAWNS.map((kind) => [kind, childProcess[kind]])) as Pick<typeof childProcess, SyncSpawn>;
    const target = childProcess as Record<SyncSpawn, unknown>;
    for (const kind of SYNC_SPAWNS) target[kind] = wrap(kind, originals[kind]);
    syncBuiltinESMExports();
    uninstall = () => {
      for (const kind of SYNC_SPAWNS) target[kind] = originals[kind];
      syncBuiltinESMExports();
      uninstall = null;
    };
    return uninstall;
  }

  const worst = (count: number): readonly BlockingSite[] => [...sites.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, count)
    .map((account) => ({ ...account, totalMs: round(account.totalMs), maxMs: round(account.maxMs) }));

  return { wrap, install, worst };
}
