// `chairman:watch` (a11ign/a11ign#3418, A5; epic #3409, chairman point 2): "KEEP ME POSTED ON X" IS RECORDED ONCE, TOLD WHEN X CHANGES STATE, AND ENDS WHEN X ENDS.
// Nothing held it before: a thing the chairman asked about lived in the conversation's context, which is cleared or compacted, so the follow-up never came.
//
//   pnpm run chairman:watch -- add <row|pr|run|unit> <id> --message=45     start watching (the ref is a message of the chairman's the ledger took in)
//   pnpm run chairman:watch -- list                                          what is being watched
//   pnpm run chairman:watch -- remove <row|pr|run|unit> <id>                 stop, without a message
//
// **THE LEDGER IS THE LIST, AND THERE IS NO SECOND FILE.** `add` and `remove` are `direction: "watch"` lines carrying the `thing`, and no `key`, so `foldLedger` never
// takes one for a notification. The telling is the core's own `watch:<thing>` delivery line. So "what is being watched" is a fold of the ledger (`foldWatches`) and
// nothing else has to be kept in step with it.
//
// **A WATCH ENDS WHEN ITS FINAL STATE HAS BEEN TOLD, NOT WHEN IT WAS OBSERVED.** The end is derived: the ledger holds a `sent` or `digested` delivery for the thing whose
// `stateHash` is a terminal state's. A final telling that FAILED or was deferred leaves the watch listed, and the next tick offers it again; a line written at observation
// time could not do that. The same fold gives the second tick nothing to tell, which is why removal-on-terminal needs no separate "ended" line.
//
// **THE STATE IS READ THROUGH THE PLACEHOLDER VOCABULARY (`placeholders.ts`)**, so "the state of a pull request" means here exactly what it means in a reply to the chairman,
// and a thing the vocabulary cannot read is refused at `add` and not at the first tick. A run is read by `{{run:ID.status}}`, which is the run's status while it
// runs and its conclusion once it has one, so a run in progress can be watched and a run that has concluded is refused at `add` like any other thing already final.
//
// **KNOWN EDGE:** a thing removed and added again while the core still holds its old `watch:<thing>` delivery is compared by the core against that older state, so a first
// change back to exactly the state last told is not told. A thing that has ended is refused at `add`, which is the common form of this.
//
// EXIT CODES, as `chairman:record`'s: 0 done (or already so), 2 refused (usage, config, a ref or a thing that cannot be used; NOTHING was written), 1 an unexpected failure.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { completionPath } from "../lib/tick-completion.ts";
import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { stateFingerprint } from "./event.ts";
import { STATUS, createLedger, describeError } from "./ledger.ts";
import { createGhReaders, parsePlaceholders, readPlaceholders } from "./placeholders.ts";
import type { Readers } from "./placeholders.ts";
import { assertReadOnlyGh, assertReadOnlySystemctl } from "./reply-cli.ts";
import { checkMessage } from "./record.ts";
import { accountIsDeclared, defaultLedgerPath, trackerRepo } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
/** The ledger `direction` of `add` and `remove`, and the event `kind` the watcher tells (`event.ts`). */
export const WATCH_DIRECTION = "watch";
export const WATCH_KIND = "watch";
const KEY_PREFIX = "watch:";
const NUMBER = /^[1-9]\d*$/;
/** A systemd unit name, as the vocabulary's: it starts with a letter or digit so it can never be read as a flag. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 64_000_000;
const execFileAsync = promisify(execFile);

/** The values of a workflow run's `conclusion` (GitHub's REST schema): a run that has one has ended. */
const RUN_CONCLUSIONS = Object.freeze(["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "startup_failure"]);

/**
 * What can be watched, by the word the chairman's liaison types. `placeholder` is the vocabulary placeholder whose value IS the state; `terminal` lists the states after
 * which nothing can change (a run's are the conclusions GitHub names, so a status such as `in_progress` or a word it adds later is never taken for an end).
 */
export const WATCHABLE: Readonly<Record<string, { id: RegExp; placeholder: (id: string) => string; label: (id: string) => string; terminal: readonly string[]; link: ((repo: string, id: string) => string) | null; }>> = Object.freeze({
  row: { id: NUMBER, placeholder: (id) => `{{issue:${id}.state}}`, label: (id) => `Row #${id}`, terminal: ["closed"], link: (repo, id) => `https://github.com/${repo}/issues/${id}` },
  pr: { id: NUMBER, placeholder: (id) => `{{pr:${id}.state}}`, label: (id) => `PR #${id}`, terminal: ["merged", "closed"], link: (repo, id) => `https://github.com/${repo}/pull/${id}` },
  run: { id: NUMBER, placeholder: (id) => `{{run:${id}.status}}`, label: (id) => `Run ${id}`, terminal: RUN_CONCLUSIONS, link: (repo, id) => `https://github.com/${repo}/actions/runs/${id}` },
  unit: { id: UNIT_NAME, placeholder: (id) => `{{unit:${id}.state}}`, label: (id) => `Unit ${id}`, terminal: [], link: null },
});

/** `say` is what the command prints */
export type Outcome = { outcome: "done" | "already" | "refused"; say: string };
export type Ports = { ledger: { append: (entry: Record<string, unknown>) => Record<string, any>; read: () => Record<string, any>[] }; readers: Readers; now: () => number };
export type Watch = { thing: string; kind: string; id: string; messageRef: string; addedAt: string; baselineHash: string; toldHash: string | null; active: boolean; ended: boolean };

/** `thing`: `kind:id` */
export function splitThing(thing: string): { kind: string; id: string; } {
  const at = thing.indexOf(":");
  return { kind: thing.slice(0, at), id: thing.slice(at + 1) };
}

/** Returns the event key the core dedupes this watch under */
export function watchKey(thing: string): string {
  return `${KEY_PREFIX}${thing}`;
}

/** Returns whether nothing can change after `state` */
export function isTerminal(kind: string, state: string): boolean {
  return WATCHABLE[kind].terminal.includes(state);
}

/** Returns whether `hash` is the fingerprint of a final state (a delivery line holds the hash, not the state) */
function isTerminalHash(kind: string, hash: string): boolean {
  return WATCHABLE[kind].terminal.some((state) => stateFingerprint({ state }) === hash);
}

const isTold = (line: Record<string, any>): boolean => line.direction !== "in" && (line.status === STATUS.sent || line.status === STATUS.digested);

/** Every thing ever watched, as the ledger now says it is. Lines are applied in order, so a thing added again after it was removed starts afresh. */
export function foldWatches(lines: Record<string, any>[]): Map<string, Watch> {
  const watches: Map<string, Watch> = new Map();
  for (const line of lines) {
    if (line.direction === WATCH_DIRECTION && typeof line.thing === "string") {
      const existing = watches.get(line.thing);
      if (line.op === "add") watches.set(line.thing, { ...splitThing(line.thing), thing: line.thing, messageRef: String(line.messageRef), addedAt: String(line.ts), baselineHash: String(line.stateHash), toldHash: null, active: true, ended: false });
      else if (line.op === "remove" && existing !== undefined) existing.active = false;
    } else if (typeof line.key === "string" && line.key.startsWith(KEY_PREFIX) && isTold(line)) {
      const watch = watches.get(line.key.slice(KEY_PREFIX.length));
      if (watch !== undefined && watch.active && !watch.ended) Object.assign(watch, { toldHash: String(line.stateHash), ended: isTerminalHash(watch.kind, String(line.stateHash)) });
    }
  }
  return watches;
}

/** Returns the watches still running: added, not removed, and not yet told their final state */
export function activeWatches(lines: Record<string, any>[]): Watch[] {
  return [...foldWatches(lines).values()].filter((watch) => watch.active && !watch.ended);
}

/** The state of one thing, read through the placeholder vocabulary's own readers. A reader that cannot answer THROWS, never returns an empty state. */
export async function readState({ kind, id }: { kind: string; id: string; }, { readers, now }: { readers: Readers; now: () => number; }): Promise<string> {
  const { placeholders, problems } = parsePlaceholders(WATCHABLE[kind].placeholder(id));
  if (problems.length > 0) throw new TypeError(problems[0].reason);
  const { values, failures } = await readPlaceholders(placeholders, { readers, now });
  if (failures.length > 0) throw new Error(failures[0].reason);
  return String(values.get(placeholders[0].raw));
}

/** Returns why `kind id` is not something that can be watched, or null */
function whyNotWatchable(kind: string, id: string): string | null {
  if (!Object.hasOwn(WATCHABLE, kind)) return `"${kind}" is not something that can be watched (the kinds: ${Object.keys(WATCHABLE).join(", ")})`;
  return WATCHABLE[kind].id.test(id) ? null : `"${id}" is not the id of a ${kind}`;
}

export function createWatchList({ ledger, readers, now }: Ports) {
  return {
    /**
     * `request`: `ref` is a message of the chairman's the ledger took in
     * Never throws for a refusal: it is a value, and nothing was written
     */
    async add({ kind, id, ref }: { kind: string; id: string; ref: string; }): Promise<Outcome> {
      const bad = whyNotWatchable(kind, id);
      if (bad !== null) return { outcome: "refused", say: bad };
      const checked = checkMessage(ledger.read(), { ref, text: null });
      if (!checked.ok) return { outcome: "refused", say: checked.why };
      const thing = `${kind}:${id}`;
      const label = WATCHABLE[kind].label(id);
      if (activeWatches(ledger.read()).some((watch) => watch.thing === thing)) return { outcome: "already", say: `${label} is already being watched. Nothing was written.` };
      let state: string;
      try {
        state = await readState({ kind, id }, { readers, now });
      } catch (error) {
        return { outcome: "refused", say: `${label} cannot be read, so it was not watched: ${describeError(error)}` };
      }
      if (isTerminal(kind, state)) return { outcome: "refused", say: `${label} is already ${state}: nothing will change, so it was not watched` };
      ledger.append({ direction: WATCH_DIRECTION, op: "add", thing, messageRef: ref, state, stateHash: stateFingerprint({ state }) });
      return { outcome: "done", say: `watching ${label} (now ${state}); the chairman is told when its state changes, and it ends when it does.` };
    },
    list(): { thing: string; label: string; since: string; messageRef: string; }[] {
      return activeWatches(ledger.read()).map((watch) => ({ thing: watch.thing, label: WATCHABLE[watch.kind].label(watch.id), since: watch.addedAt, messageRef: watch.messageRef }));
    },
    /** Ends the watch WITHOUT a message */
    remove({ kind, id }: { kind: string; id: string; }): Outcome {
      const bad = whyNotWatchable(kind, id);
      if (bad !== null) return { outcome: "refused", say: bad };
      const thing = `${kind}:${id}`;
      const label = WATCHABLE[kind].label(id);
      if (!activeWatches(ledger.read()).some((watch) => watch.thing === thing)) return { outcome: "refused", say: `${label} is not being watched` };
      ledger.append({ direction: WATCH_DIRECTION, op: "remove", thing });
      return { outcome: "done", say: `no longer watching ${label}. Nothing was sent.` };
    },
  };
}

/** Returns a runner that refuses every argv a reader does not build */
function guardedRunner(file: string, assertRead: (argv: readonly string[]) => void): (argv: string[]) => Promise<string> {
  return async (argv) => {
    assertRead(argv);
    const { stdout } = await execFileAsync(file, argv, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, encoding: "utf8" });
    return stdout;
  };
}

/**
 * The files `{{fleet.*}}` and `{{gate.*}}` read, named the way `watch.ts` names them for the watcher: the two files `fleet-watch` writes under the project's `runs/`,
 * and the tick's completion record beside the wake ledger. WITHOUT THEM those placeholders refuse ("this host named no fleet-watch state files"), which is the right
 * failure and, for a `Verify:` over a worker power-on, a procedure that never advances (#3646). `host-config.ts` is imported WHEN ASKED, as `reply-cli.ts` does:
 * it resolves the host at import, and a host that cannot name the record must cost `{{gate.*}}` and nothing else.
 * Returns no `gateRecordPath` when the host could not name one, said on `err`
 */
export async function hostFiles({ root, err }: { root: string; err: (line: string) => void; }): Promise<{ fleet: { statePath: string; capturesPath: string; }; gateRecordPath?: string; }> {
  const fleet = { statePath: join(root, "runs", "fleet-watch-state.json"), capturesPath: join(root, "runs", "fleet-captures-state.json") };
  try {
    const { stateEntryPath } = await import("../host-config.ts");
    return { fleet, gateRecordPath: completionPath(stateEntryPath("wake-ledger")) };
  } catch (error) {
    err(`this host could not name the work-tick completion record, so {{gate.*}} will refuse: ${describeError(error)}`);
    return { fleet };
  }
}

/**
 * `files`: what `hostFiles` names
 * Returns the real reads, over `gh` and `systemctl` runners that make no write
 */
export function createWatchReaders(repo: string, now: () => number = Date.now, files: { fleet?: { statePath: string; capturesPath: string; }; gateRecordPath?: string; } = {}): Readers {
  return createGhReaders({ gh: guardedRunner("gh", assertReadOnlyGh), systemctl: guardedRunner("systemctl", assertReadOnlySystemctl), repo, now, ...files });
}

/** What a caller may leave out. A spread and not parameter defaults, as `record.ts` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: process.env as Record<string, string | undefined>, home: homedir(), now: Date.now,
  readers: undefined as Readers | undefined,
  out: (line: string) => console.log(line), err: (line: string) => console.error(line),
});

/** Thrown for a command that cannot start (usage, config, no account): none of those mends itself by retrying. */
class Refusal extends Error {}

function expectArguments(positionals: string[], count: number, usage: string): string[] {
  if (positionals.length !== count) throw new Refusal(`usage: ${usage}`);
  return positionals;
}

function exitCodeFor(error: Error): number {
  const isUsage = (error as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS") === true;
  return isUsage || error instanceof Refusal || error instanceof MessagingConfigRefusal ? EXIT.refused : EXIT.failed;
}

async function perform(watches: ReturnType<typeof createWatchList>, verb: string, positionals: string[], ref: string | undefined): Promise<{ lines: string[]; code: number; }> {
  if (verb === "list") {
    const rows = watches.list();
    return { lines: rows.length === 0 ? ["nothing is being watched"] : rows.map((row) => `${row.thing}\t${row.label}\tsince ${row.since}\tmessage ${row.messageRef}`), code: EXIT.ok };
  }
  if (verb !== "add" && verb !== "remove") throw new Refusal("usage: chairman:watch add <row|pr|run|unit> <id> --message=<ref> | list | remove <row|pr|run|unit> <id>");
  const [kind, id] = expectArguments(positionals, 2, `chairman:watch ${verb} <row|pr|run|unit> <id>${verb === "add" ? " --message=<the chairman's message ref>" : ""}`);
  if (verb === "remove") return report(watches.remove({ kind, id }));
  if (ref === undefined || ref === "") throw new Refusal("--message=<the chairman's message ref> is required");
  return report(await watches.add({ kind, id, ref }));
}

function report(outcome: Outcome): { lines: string[]; code: number; } {
  return { lines: [outcome.say], code: outcome.outcome === "refused" ? EXIT.refused : EXIT.ok };
}

/**
 * Messaging being OFF is a refusal and not a silent success, as `chairman:record`'s: a caller believes it is recording something.
 * Returns the exit code
 */
export async function main(argv: string[], deps: Partial<ReturnType<typeof DEFAULT_DEPS>> = {}): Promise<number> {
  const { root, env, home, now, readers, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { message: { type: "string" } } });
    if (!readMessagingConfig(resolve(root), { home }).enabled) throw new Refusal("messaging is OFF (no `messaging` key in .agent-org/project.json); nothing was written");
    if (!accountIsDeclared(env)) throw new Refusal("no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to read as whoever `gh` last logged in as (#1967)");
    const watches = createWatchList({ ledger: createLedger({ path: defaultLedgerPath(home), now }), readers: readers ?? createWatchReaders(trackerRepo(resolve(root)), now), now });
    const [verb = "", ...rest] = positionals;
    const { lines, code } = await perform(watches, verb, rest, values.message);
    for (const line of lines) (code === EXIT.ok ? out : err)(code === EXIT.ok ? line : `chairman:watch: ${line}`);
    return code;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`chairman:watch: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${describeError(error)}`);
    return exitCodeFor(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
