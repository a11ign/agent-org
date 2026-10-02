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
// **NOTHING IS SENT TO A WORKER FROM HERE.** `handle` says `forward` for an accepted value and `forwarding` below hands it to its consumer by
// `kind`: a message to `converse` (queued for `ceo` and nobody else, #2909), a button press to `answers` (a chairman-attributed row comment,
// #2908). Each checks it with `isAccepted` itself, so this file only chooses; it never builds an accepted value or writes to a row of its own.
//
// **THE QUEUE LOADS ON THE FIRST MESSAGE, AND ONLY `converse.mjs` NAMES IT.** `prompt-session.mjs` and `wake.mjs` read the project's declaration when they are
// imported and REFUSE when it cannot be found, and `createConverse` imports them on first use. A message it could not queue because of that is TOLD to the
// chairman (a send) and ledgered `refused`, never dropped. (This file's own imports reach the declaration through `watch.mjs` and `herdr-agents.mjs`, so without
// `$AGENT_ORG_HOST` the listener does not start at all; the `chairman-listen` unit sets it.)
//
// EXIT CODES: 0 stopped when told to (or messaging is off), 1 failed while running, 2 REFUSED to start or told to stop by Telegram (config,
// secrets, no chairman paired yet, the lock, a 409). The unit does not restart a 2: a refusal does not mend itself, and restarting one
// that is a 409 makes this listener the second poller in a fight.

import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { stateEntryPath } from "../host-config.mjs";
import { ANSWER_PREFIX } from "../project-vocabulary.mjs";
import { createAnswers } from "./answers.mjs";
import { MessagingConfigRefusal, readMessagingConfig } from "./config.mjs";
import { createConverse } from "./converse.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger, describeError } from "./ledger.mjs";
import { createOffsetStore, createTelegramPollingProvider, PollConflictError, runListener } from "./providers/telegram/poll.mjs";
import { readSecretFile, secretFileProblem, SecretFileRefusal } from "./secret.mjs";
import { defaultLedgerPath } from "./watch.mjs";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const LOCK_FILE = "listener.lock";
const OFFSET_FILE = "offset.json";
/** The queue file's name beside the wake ledger: `wake.mjs`'s `HANDOFF_QUEUE_FILE`, which this file may not import (see `handoffQueueBeside`); the test pins the two equal. */
const HANDOFF_QUEUE_FILE = "prompt-session-handoffs";
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

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
/** The session a chairman's answer wakes. The label is this under the vocabulary's answer prefix: `ceo` is decision 2(c)'s, as `converse`'s recipient is 2(b)'s. */
const ANSWER_SESSION = "ceo";

/** @param {readonly string[]} argv @returns {Promise<string>} what `gh` printed; the environment, and so the account, is the process's own (the unit declares `GH_CONFIG_DIR`) */
async function runGh(argv) {
  const { stdout } = await execFileAsync("gh", [...argv], { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8" });
  return stdout;
}

/**
 * What `answers` needs of GitHub, over `gh` (the platform's own client, as `watch.mjs` reads through): one row read and three writes. A row is `{repo, number}`
 * from the request key the ledger holds, so `--repo` names it and nothing depends on the working directory. `gh issue edit --remove-label` succeeds when the
 * issue lacks the label, which is what a resumed answer needs of `removeLabel`.
 *
 * @param {{ run?: (argv: readonly string[]) => Promise<string> }} [deps] @returns {import("./answers.mjs").GithubWriter}
 */
export function createGhWriter({ run = runGh } = {}) {
  /** @param {{repo: string, number: number}} row @param {string} verb @param {string[]} rest */
  const issue = (row, verb, rest) => run(["issue", verb, String(row.number), "--repo", row.repo, ...rest]);
  return {
    async readRow(row) {
      const read = JSON.parse(await issue(row, "view", ["--json", "state,labels,comments"]));
      return {
        state: read.state, labels: read.labels.map((/** @type {{name: string}} */ label) => label.name),
        comments: read.comments.map((/** @type {Record<string, string>} */ { body, createdAt, authorAssociation }) => ({ body, createdAt, authorAssociation })),
      };
    },
    async comment(row, body) {
      await issue(row, "comment", ["--body", body]);
    },
    async removeLabel(row, label) {
      await issue(row, "edit", ["--remove-label", label]);
    },
    async addLabel(row, label) {
      await issue(row, "edit", ["--add-label", label]);
    },
  };
}

/** @typedef {(message: { text: string, replyTo?: string }) => Promise<{ messageRef: string }>} Send */
/** @typedef {{ converse: { forward: (accepted: Readonly<Record<string, any>>) => Promise<unknown> }, answers: { answer: (accepted: Readonly<Record<string, any>>) => Promise<{ text?: string }> } }} Consumers */

/**
 * `wake.mjs`'s `handoffQueuePath(ledgerPathFrom([]))`, which is what the unit's `work:tick` reads. NOT imported from there: `converse.test.mjs` bounds the files that
 * name the queue's modules to `converse.mjs` alone, and this one has no business with the queue but where it is. `listen.test.mjs` pins the two together.
 * @param {string} wakeLedgerPath @returns {string}
 */
export function handoffQueueBeside(wakeLedgerPath) {
  return join(dirname(wakeLedgerPath), HANDOFF_QUEUE_FILE);
}

/**
 * The two consumers. `createConverse` loads the queue itself, on the first message, and that load is what refuses without `$AGENT_ORG_HOST`; so building it
 * here cannot fail, and a queue that will not load surfaces from `converse.forward`, where `forwarding` tells the chairman.
 *
 * @param {{ chairman: {userId: number, chatId: number}, ledger: ReturnType<typeof createLedger>, send: Send, now: () => number }} parts @returns {Consumers}
 */
function createConsumers({ chairman, ledger, send, now }) {
  const queuePath = handoffQueueBeside(stateEntryPath("wake-ledger"));
  return {
    converse: createConverse({ chairman, queuePath, ledger, send, now }),
    answers: createAnswers({ ledger, github: createGhWriter(), chairman, answerLabel: `${ANSWER_PREFIX}${ANSWER_SESSION}`, now }),
  };
}

/**
 * The listener's `onForward`: an accepted MESSAGE goes to `converse`, an accepted BUTTON PRESS to `answers`, and neither ever reaches the other. A kind
 * that is neither is an error and not a silent return, since an accepted update nobody acts on is the defect this exists to close.
 *
 * A message `converse` could not take, because it threw before it wrote a ledger line of its own (the queue would not load, or would not run), is TOLD to the
 * chairman as not delivered and ledgered `refused`. One `converse` did account for keeps its own line, and its throw stands.
 *
 * @param {{ ledger: ReturnType<typeof createLedger>, send: Send, consumers: Consumers }} parts
 * @returns {(accepted: Readonly<Record<string, any>>) => Promise<void>}
 */
export function forwarding({ ledger, send, consumers }) {
  /** @param {Readonly<Record<string, any>>} accepted @returns {boolean} whether `converse` ledgered this update before it failed */
  const converseAccountedFor = (accepted) => ledger.read().some((line) => line.origin === "converse" && line.updateId === accepted.updateId);

  /** @param {Readonly<Record<string, any>>} accepted @param {unknown} cause @returns {Promise<never>} always throws: a refusal is a failed forward as well as a told one */
  async function refuseUndelivered(accepted, cause) {
    /** @type {{ ref: string | null, error: unknown }} */
    let ack = { ref: null, error: null };
    try {
      ack = { ref: (await send({ text: `I could not queue that for ceo: ${describeError(cause)}. Treat it as NOT delivered.`, replyTo: String(accepted.messageId) })).messageRef, error: null };
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

  /** @param {Readonly<Record<string, any>>} accepted @returns {Promise<void>} */
  async function forwardMessage(accepted) {
    try {
      await consumers.converse.forward(accepted);
    } catch (cause) {
      if (converseAccountedFor(accepted)) throw cause;
      await refuseUndelivered(accepted, cause);
    }
  }

  /** @param {Readonly<Record<string, any>>} accepted @returns {Promise<void>} */
  async function forwardButton(accepted) {
    const result = await consumers.answers.answer(accepted);
    if (result.text !== undefined) await send({ text: result.text });
  }

  return async (accepted) => {
    if (accepted.kind === "message") await forwardMessage(accepted);
    else if (accepted.kind === "button") await forwardButton(accepted);
    else throw new Error(`update ${accepted.updateId} was accepted as a ${String(accepted.kind)}, which nothing consumes`);
  };
}

/** What a caller may leave out. A spread and not parameter defaults, as `watch.mjs` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), home: homedir(), now: Date.now, fetch: globalThis.fetch, signal: /** @type {AbortSignal | undefined} */ (undefined),
  sleep: (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  out: (/** @type {string} */ line) => console.log(line), err: (/** @type {string} */ line) => console.error(line),
  onForward: /** @type {(accepted: Readonly<Record<string, any>>) => Promise<void> | void} */ (undefined),
  /** Replaces the real consumers, so a test drives the wiring without the queue or GitHub. @type {Consumers | undefined} */ consumers: undefined,
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
  const { home, now, fetch: fetchImpl, sleep, err, onForward, consumers } = { ...DEFAULT_DEPS(), ...deps };
  const chairman = readChairman(config.chairmanFile);
  const token = readSecretFile(config.tokenFile);
  const state = stateDirectory(/** @type {string} */ (home));
  const lock = acquireLock(join(state, LOCK_FILE));
  try {
    const ledger = createLedger({ path: defaultLedgerPath(/** @type {string} */ (home)), now });
    const inbound = createInbound({ ledger, chairman });
    const provider = createTelegramPollingProvider({ token, chatId: chairman.chatId, fetch: fetchImpl, sleep, log: err });
    const send = (/** @type {{ text: string, replyTo?: string }} */ message) => provider.send(message);
    await runListener({
      provider, inbound, offsets: createOffsetStore(join(state, OFFSET_FILE), { log: err }), chairman, sleep, log: err, signal: stoppableBy(deps.signal),
      onForward: onForward ?? forwarding({ ledger, send, consumers: consumers ?? createConsumers({ chairman, ledger, send, now }) }),
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
 *   consumers?: Consumers }} [deps]
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
