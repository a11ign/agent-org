// @ts-check
// `messaging:listen` (a11ign/a11ign#2907): THE LONG-RUNNING PROGRAM THE `chairman-listen` UNIT RUNS. It reads the chairman's ids and the bot
// token from their files, takes the single-instance lock, and hands Telegram's updates to the inbound core until it is told to stop.
// `poll.mjs` is the loop; this file is everything that has to be true BEFORE the loop starts, and the exit code after it.
//
// **ONE LISTENER, AND TWO THINGS ENFORCE IT.** The lock file here refuses a second instance on this host, naming the pid that holds it; a
// `409 Conflict` from Telegram refuses one anywhere else (another host with the same token, a `messaging:pair` still running). Neither is
// retried: a listener that waits for the other to stop is a second poller the moment it does.
//
// **A LOCK THAT OUTLIVES ITS HOLDER MUST NOT LOCK THE HOST OUT.** The file names the pid AND the process's start time, so after a crash
// (`Restart=on-failure` restarts the unit with the old file still there) or a reboot that gave the pid to somebody else, the lock is
// recognised as stale and taken over.
//
// **NOTHING IS SENT TO A WORKER FROM HERE.** `handle` says `forward` for an accepted message and this file's default consumer only
// records that it arrived: the row that writes a chairman-attributed comment (#2908) and the queue to `ceo` (#2909) are separate rows,
// and each takes the accepted value through `onForward` and checks it with `isAccepted`.
//
// EXIT CODES: 0 stopped when told to (or messaging is off), 1 failed while running, 2 REFUSED to start or told to stop by Telegram (config,
// secrets, no chairman paired yet, the lock, a 409). The unit does not restart a 2: a refusal does not mend itself, and restarting one
// that is a 409 makes this listener the second poller in a fight.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MessagingConfigRefusal, readMessagingConfig } from "./config.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger } from "./ledger.mjs";
import { createOffsetStore, createTelegramPollingProvider, PollConflictError, runListener } from "./providers/telegram/poll.mjs";
import { readSecretFile, secretFileProblem, SecretFileRefusal } from "./secret.mjs";
import { defaultLedgerPath } from "./watch.mjs";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const LOCK_FILE = "listener.lock";
const OFFSET_FILE = "offset.json";
const LOCK_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
/** Field 22 of `/proc/<pid>/stat` is the start time. Everything up to the command's closing parenthesis is skipped, since a command may hold spaces, so the
 * array begins at field 3 (the state) and field 22 is index 22 - 3 = 19. It was 20, which is field 23, the virtual size: a different number that passed every test that injects it. */
const START_TIME_FIELD = 19;

/** The lock is held by a live listener. `holder` is its pid. */
export class ListenerLockHeld extends Error {
  /** @param {string} path @param {number} holder */
  constructor(path, holder) {
    super(`another messaging:listen is running here (pid ${holder}, lock ${path}): one listener per bot; stop it first`);
    this.name = "ListenerLockHeld";
    this.holder = holder;
  }
}

/** @param {number} pid @returns {string | null} when the process started, as the kernel counts it; null where the kernel does not say (not Linux, or no such process) */
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[START_TIME_FIELD] ?? null;
  } catch {
    // No /proc, or no such pid: either way there is no start time to compare, and the pid alone decides.
    return null;
  }
}

/** @param {number} pid @returns {boolean} whether a process with this pid exists; one we may not signal still exists */
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * @param {string} path @returns {{ pid: number, start: string | null } | null} who the lock file names, or null when it names nobody readable
 */
function readLock(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  const [pidText, start] = text.trim().split(" ");
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, start: start ?? null } : null;
}

/** @param {{ pid: number, start: string | null }} holder @param {{ exists: (pid: number) => boolean, startOf: (pid: number) => string | null }} probes @returns {boolean} */
function holderIsLive({ pid, start }, { exists, startOf }) {
  if (!exists(pid)) return false;
  const current = startOf(pid);
  // A start time that differs means the pid was handed to a different process since: the holder is gone.
  return start === null || current === null || start === current;
}

/**
 * Takes the lock or throws `ListenerLockHeld`. Created exclusively (`wx`), so two instances starting together cannot both succeed on a
 * fresh file; a stale file is removed and the exclusive create tried once more. Two instances racing for the SAME stale file are the
 * one gap, and Telegram's 409 is what closes it.
 *
 * @param {string} path
 * @param {{ pid?: number, exists?: (pid: number) => boolean, startOf?: (pid: number) => string | null }} [deps]
 * @returns {{ path: string, release: () => void }}
 */
export function acquireLock(path, { pid = process.pid, exists = pidExists, startOf = processStart } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });
  for (const attempt of [1, 2]) {
    try {
      const descriptor = openSync(path, "wx", LOCK_FILE_MODE);
      try {
        writeSync(descriptor, `${pid} ${startOf(pid) ?? ""}\n`);
      } finally {
        closeSync(descriptor);
      }
      return { path, release: () => releaseLock(path, pid) };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      const holder = readLock(path);
      if (holder !== null && holderIsLive(holder, { exists, startOf })) throw new ListenerLockHeld(path, holder.pid);
      if (attempt === 2) throw new Error(`${path}: could not take the lock after clearing a stale one`, { cause: error });
      unlinkSync(path);
    }
  }
  throw new Error(`${path}: unreachable`);
}

/** @param {string} path @param {number} pid removes the lock only while it is still this process's: a successor's is not ours to delete */
function releaseLock(path, pid) {
  if (readLock(path)?.pid === pid) unlinkSync(path);
}

/** @param {string} path @returns {Record<string, unknown>} the file's JSON object, or a refusal: a file that is not JSON is not mended by a restart */
function parsedIds(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch (cause) {
    throw new SecretFileRefusal(path, "it is not valid JSON; pair again", { cause });
  }
}

/**
 * The chairman's ids, from the file `messaging:pair` wrote. Permissions are checked before the content is read.
 * @param {string} path @returns {{ userId: number, chatId: number }}
 */
export function readChairman(path) {
  const problem = secretFileProblem(path);
  if (problem !== null) throw new SecretFileRefusal(path, `the chairman file is not usable (${problem}); has \`messaging:pair\` been run?`);
  const { userId, chatId } = parsedIds(path);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId)) throw new SecretFileRefusal(path, "it holds no integer userId and chatId; pair again");
  return { userId, chatId };
}

/** @param {string} home @returns {string} where the listener keeps its lock and offset: beside the ledger it shares with the watcher */
export function stateDirectory(home) {
  return dirname(defaultLedgerPath(home));
}

/** What a caller may leave out. A spread and not parameter defaults, as `watch.mjs` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), home: homedir(), now: Date.now, fetch: globalThis.fetch, signal: /** @type {AbortSignal | undefined} */ (undefined),
  sleep: (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  out: (/** @type {string} */ line) => console.log(line), err: (/** @type {string} */ line) => console.error(line),
  onForward: /** @type {(accepted: Readonly<Record<string, any>>) => Promise<void> | void} */ (undefined),
});

/** @param {AbortSignal | undefined} given @returns {AbortSignal} one that also aborts on SIGTERM and SIGINT, so `systemctl stop` ends a long poll at once */
function stoppableBy(given) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (given?.aborted === true) stop();
  given?.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return controller.signal;
}

/**
 * @param {Parameters<typeof main>[0]} deps @param {{ tokenFile: string, chairmanFile: string }} config @returns {Promise<void>}
 */
async function listen(deps, config) {
  const { home, now, fetch: fetchImpl, sleep, err, onForward } = { ...DEFAULT_DEPS(), ...deps };
  const chairman = readChairman(config.chairmanFile);
  const token = readSecretFile(config.tokenFile);
  const state = stateDirectory(/** @type {string} */ (home));
  const lock = acquireLock(join(state, LOCK_FILE));
  try {
    const inbound = createInbound({ ledger: createLedger({ path: defaultLedgerPath(/** @type {string} */ (home)), now }), chairman });
    const provider = createTelegramPollingProvider({ token, chatId: chairman.chatId, fetch: fetchImpl, sleep, log: err });
    await runListener({
      provider, inbound, offsets: createOffsetStore(join(state, OFFSET_FILE), { log: err }), chairman, sleep, log: err, signal: stoppableBy(deps.signal),
      // Until rows 9 and 10 consume it, an accepted message is recorded in the ledger by `handle` and goes no further: say so, never drop it silently.
      onForward: onForward ?? ((accepted) => err(`messaging:listen: update ${accepted.updateId} (${accepted.kind}) was accepted and has no consumer yet; it is in the ledger and nothing acts on it`)),
    });
  } finally {
    lock.release();
  }
}

/** @param {unknown} error @returns {number} the exit code: a refusal that restarting cannot mend is `refused`, anything else `failed` */
function exitCodeFor(error) {
  return error instanceof MessagingConfigRefusal || error instanceof SecretFileRefusal || error instanceof ListenerLockHeld || error instanceof PollConflictError
    ? EXIT.refused : EXIT.failed;
}

/**
 * @param {{ root?: string, home?: string, now?: () => number, fetch?: typeof fetch, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>,
 *   out?: (line: string) => void, err?: (line: string) => void, onForward?: (accepted: Readonly<Record<string, any>>) => Promise<void> | void }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(deps = {}) {
  const { root, home, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const config = readMessagingConfig(root, { home });
    // OFF IS SILENT AND CONSTRUCTS NOTHING: no secret is read, no lock taken, no directory made.
    if (!config.enabled) {
      out("messaging: OFF (no `messaging` key in .agent-org/project.json); nothing to listen for");
      return EXIT.ok;
    }
    await listen(deps, config);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`messaging:listen: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${error.message}`);
    return exitCodeFor(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
