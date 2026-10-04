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
// **NOTHING IS SENT TO A WORKER FROM HERE.** `handle` says `forward` for an accepted message and `createForwarder` hands it to `answers.mjs`
// (#2908), which checks it with `isAccepted` and writes the chairman-attributed comment and the labels; the chairman is told what happened.
// What is NOT an answer (a message that replies to nothing the organisation asked) goes to row 10's `converse`, which queues it for the `liaison` and nobody else.
//
// **THE QUEUE LOADS ON THE FIRST MESSAGE, AND ONLY `converse.mjs` NAMES IT.** `prompt-session.mjs` and `wake.mjs` read the project's declaration when they are
// imported and REFUSE without it (the `chairman-listen` unit sets `$AGENT_ORG_HOST`, #3064). A message `converse` could not queue for that reason is TOLD to the
// chairman (a send) and ledgered `refused` by `tellingWhenUndelivered`, never dropped.
//
// **THE GITHUB WRITES ARE THE UNIT'S ACCOUNT, NEVER THE PERSON'S (#1967).** This is the one program here that writes to GitHub, so it refuses to
// start where no account is declared, as `watch.mjs` does for its reads.
//
// EXIT CODES: 0 stopped when told to (or messaging is off), 1 failed while running, 2 REFUSED to start or told to stop by Telegram (config,
// secrets, no chairman paired yet, the lock, a 409). The unit does not restart a 2: a refusal does not mend itself, and restarting one
// that is a 409 makes this listener the second poller in a fight.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { toolVersionLine } from "../lib/tool-version.mjs";
import { ANSWER_PREFIX } from "../project-vocabulary.mjs";
import { createAnswers } from "./answers.mjs";
import { MessagingConfigRefusal, readMessagingConfig } from "./config.mjs";
import { createConverse, notReached } from "./converse.mjs";
import { createGithubWriter } from "./github-writer.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger, describeError } from "./ledger.mjs";
import { createOffsetStore, createTelegramPollingProvider, PollConflictError, runListener } from "./providers/telegram/poll.mjs";
import { readSecretFile, SecretFileRefusal } from "./secret.mjs";
import { accountIsDeclared, defaultLedgerPath, readChairman } from "./state.mjs";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const LOCK_FILE = "listener.lock";
const OFFSET_FILE = "offset.json";
const LOCK_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
/** Field 22 of `/proc/<pid>/stat` is the start time. Everything up to the command's closing parenthesis is skipped, since a command may hold spaces, so the
 * array begins at field 3 (the state) and field 22 is index 22 - 3 = 19. It was 20, which is field 23, the virtual size: a different number that passed every test that injects it. */
const START_TIME_FIELD = 19;

/** The label that wakes `ceo` with the answer: the vocabulary's answer prefix and the session, never a literal (`project-vocabulary.test.ts` refuses one). */
const ANSWER_LABEL = `${ANSWER_PREFIX}ceo`;
const WRITE_FAILED_TEXT = "Could not reach GitHub to record that. Nothing was written; do it again to retry.";

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
  converse: /** @type {((accepted: Readonly<Record<string, any>>) => Promise<void> | void) | undefined} */ (undefined),
  github: /** @type {import("./answers.mjs").GithubWriter | undefined} */ (undefined),
  env: /** @type {Record<string, string | undefined>} */ (process.env),
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
 * A message `converse` could not take, because it threw before it wrote a ledger line of its own (the queue would not load, which is what a missing
 * `$AGENT_ORG_HOST` looks like, or would not run), is TOLD to the chairman as not delivered and ledgered `refused`, then thrown. One `converse` did account
 * for keeps its own line, and its throw stands: a second line would say the same message was refused after it was queued.
 *
 * @param {{ ledger: { read: () => Record<string, any>[], append: (entry: Record<string, unknown>) => unknown }, send: (message: { text: string, replyTo?: string }) => Promise<{ messageRef: string }>,
 *   converse: (accepted: Readonly<Record<string, any>>) => Promise<unknown> | unknown }} parts
 * @returns {(accepted: Readonly<Record<string, any>>) => Promise<void>}
 */
export function tellingWhenUndelivered({ ledger, send, converse }) {
  /** @param {Readonly<Record<string, any>>} accepted @param {unknown} cause @returns {Promise<never>} */
  async function refuse(accepted, cause) {
    /** @type {{ ref: string | null, error: unknown }} */
    let ack = { ref: null, error: null };
    try {
      ack = { ref: (await send({ text: notReached(describeError(cause)), replyTo: String(accepted.messageId) })).messageRef, error: null };
    } catch (error) {
      ack = { ref: null, error };
    }
    ledger.append({
      direction: "in", origin: "converse", updateId: accepted.updateId, messageRef: String(accepted.messageId), verdict: "refused", handoff: null,
      ackRef: ack.ref, error: describeError(cause),
    });
    if (ack.error !== null) throw new Error("the queue could not be reached and the chairman could not be told", { cause: ack.error });
    throw new Error(`the queue could not be reached (message update ${accepted.updateId})`, { cause });
  }

  return async (accepted) => {
    try {
      await converse(accepted);
    } catch (cause) {
      if (ledger.read().some((line) => line.origin === "converse" && line.updateId === accepted.updateId)) throw cause;
      await refuse(accepted, cause);
    }
  };
}

/**
 * What the listener does with an accepted value: it answers a request on its row and tells the chairman what happened, and hands anything else to
 * `converse`. `send` speaks to the chairman's chat, so a reply needs no chat id, and a button press is NOT answered again here: `runListener` stops
 * the spinner of every press before the core sees it, and Telegram takes one answer per query.
 *
 * A message the answers path says can no longer be answered has its keyboard taken off FIRST (a11ign/a11ign#3423), so a second press cannot happen while the
 * reply is on its way; a failure to do it is logged and does not stop the reply, which is what the chairman is owed.
 *
 * @param {{ answers: { answer: (accepted: unknown) => Promise<import("./answers.mjs").Answered> }, send: (message: { text: string }) => Promise<unknown>,
 *   converse: (accepted: Readonly<Record<string, any>>) => Promise<void> | void, log: (line: string) => void,
 *   clearKeyboard?: (messageRef: string) => Promise<void> }} parts `clearKeyboard` is the provider's; a caller with none draws no keyboards
 * @returns {(accepted: Readonly<Record<string, any>>) => Promise<void>}
 */
export function createForwarder({ answers, send, converse, log, clearKeyboard }) {
  return async (accepted) => {
    /** @type {import("./answers.mjs").Answered | null} */
    let result = null;
    try {
      result = await answers.answer(accepted);
    } catch (error) {
      // The update is in the ledger already, so it will not come again; the chairman is told, and the next press resumes from the last step recorded.
      log(`messaging:listen: update ${accepted.updateId} could not be answered: ${error instanceof Error ? error.message : String(error)}`);
      await send({ text: WRITE_FAILED_TEXT });
      return;
    }
    if (result.action !== "reply") return converse(accepted);
    if (result.clearKeyboard !== null && clearKeyboard !== undefined) {
      await clearKeyboard(result.clearKeyboard).catch((error) => log(`messaging:listen: could not take the keyboard off message ${result.clearKeyboard}: ${error instanceof Error ? error.message : String(error)}`));
    }
    await send({ text: result.text });
  };
}

/**
 * @param {Parameters<typeof main>[0]} deps @param {{ tokenFile: string, chairmanFile: string }} config @returns {Promise<void>}
 */
async function listen(deps, config) {
  const { home, now, fetch: fetchImpl, sleep, err, onForward, converse, github } = { ...DEFAULT_DEPS(), ...deps };
  const chairman = readChairman(config.chairmanFile);
  const token = readSecretFile(config.tokenFile);
  const state = stateDirectory(/** @type {string} */ (home));
  const lock = acquireLock(join(state, LOCK_FILE));
  try {
    const ledger = createLedger({ path: defaultLedgerPath(/** @type {string} */ (home)), now });
    const inbound = createInbound({ ledger, chairman });
    const provider = createTelegramPollingProvider({ token, chatId: chairman.chatId, fetch: fetchImpl, sleep, log: err });
    const send = (/** @type {{ text: string, replyTo?: string }} */ message) => provider.send(message);
    // The queue is `prompt:session`'s own, at the path it and the gate resolve from no `--ledger`: a message for the liaison lands where the liaison's next wake reads it.
    const conversation = createConverse({ chairman, ledger, send, now });
    // `explain` and `stuck` order the liaison through the one module that queues (`converse.mjs`); nothing else here can.
    const answers = createAnswers({ ledger, github: github ?? createGithubWriter(), chairman, answerLabel: ANSWER_LABEL, now, orders: { liaison: (order) => conversation.orderLiaison(order) } });
    await runListener({
      provider, inbound, offsets: createOffsetStore(join(state, OFFSET_FILE), { log: err }), chairman, sleep, log: err, signal: stoppableBy(deps.signal),
      onForward: onForward ?? createForwarder({ answers, send, converse: tellingWhenUndelivered({ ledger, send, converse: converse ?? conversation.forward }), log: err, clearKeyboard: (ref) => provider.clearKeyboard(ref) }),
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
 *   out?: (line: string) => void, err?: (line: string) => void, onForward?: (accepted: Readonly<Record<string, any>>) => Promise<void> | void,
 *   converse?: (accepted: Readonly<Record<string, any>>) => Promise<void> | void, github?: import("./answers.mjs").GithubWriter,
 *   env?: Record<string, string | undefined> }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(deps = {}) {
  const { root, home, out, err, env, github } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const config = readMessagingConfig(root, { home });
    // OFF IS SILENT AND CONSTRUCTS NOTHING: no secret is read, no lock taken, no directory made.
    if (!config.enabled) {
      out("messaging: OFF (no `messaging` key in .agent-org/project.json); nothing to listen for");
      return EXIT.ok;
    }
    if (github === undefined && !accountIsDeclared(env)) {
      err("messaging:listen: no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to write as whoever `gh` last logged in as (#1967)");
      return EXIT.refused;
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
  // #3443: THE LISTENER IS LONG-RUNNING AND HOLDS ITS MODULES, so its journal's first line says which agent-org version it loaded: the proof that a move of the tool
  // checkout was followed by a restart, and the line `orchestrator`'s read-back after a move looks for.
  console.log(toolVersionLine());
  process.exitCode = await main();
}
