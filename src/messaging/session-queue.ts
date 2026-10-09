// @ts-check
// `chairman:queue` (a11ign/a11ign#3427, D1 of epic #3409; chairman point 4): "CAN YOU DO IT FOR ME?" -- A QUEUE FOR THE CHAIRMAN'S OWN SESSION, WRITTEN ONLY AFTER HIS OK IN CHAT.
//
//   pnpm run chairman:queue -- add --message=45 --what=... --why=... --result-wanted=...   (the chairman's OK, as he wrote it, on stdin)
//   pnpm run chairman:queue -- list | take <id> | done <id> --result=<one line> [--hand-fix] | status
//
// **THERE IS NO EXECUTOR, AND THAT IS THE DESIGN.** Some acts the chairman's Claude session can do with his OK (admin writes, UniFi, switch reads, control-plane reads) and an org agent
// must never be given the credential for. So the org writes the ask here and a HUMAN'S SESSION reads it: nothing in this repository reads the queue file but this command, and
// `session-queue.test.mjs` scans `src/messaging/` for a module that touches the file and also spawns a process. The file's mode is 0600 and no credential, and no directory a
// credential lives in, is named by this module.
//
// **THE FILE HOLDS ONE KIND OF LINE: THE ASK.** `{ id, askedAt, approvedByMessage, what, why, resultWanted }`, a CLOSED schema (`ASK_FIELDS`), appended by `add` and never edited.
// What happened to an ask (`take`, `done`), and when the chairman's session last read the queue, are `direction: "queue"` lines in the DELIVERY LEDGER, with no `key`, so the
// ledger's fold never takes one for a notification. That keeps "is it open" a fold over lines and not a rewrite of a file the chairman's session is reading.
//
// **AN ASK NEEDS HIS OK, VERIFIED AS `chairman:record`'s IS.** `--message` is either (a) a message the ledger took in from him, with his words on stdin hashed and compared with the
// receipt's, or (b) the bot message a `forme` ("Do it for me") press sat under, which is `answers.mjs`'s line (`direction: "answer", step: "forme"`, `via: "button"`, one per message; a press is not an
// answer, so it leaves the row's label alone). **ONE OK IS ONE ASK**: a ref that already has an ask is refused, so an OK for one act cannot be replayed into a second.
// HONEST LIMIT, as `record.mjs`'s: an agent with a shell can append to the ledger or the file with no check at all. This makes an ask DETECTABLE against his chat, never impossible.
//
// **`what`, `why` AND `resultWanted` PASS THE CLASSIFIER'S SECRET SCAN** (`classifyText`, the one the chat passes): an ask carrying a credential shape is refused and the file is
// unchanged. Only a secret verdict refuses here; the classifier's deletion and spending refusals are about what the CHAT may pass on, and the chairman's own session may be asked
// to do either with his OK.
//
// **WHETHER HIS SESSION IS RUNNING IS NOT OBSERVABLE FROM HERE.** What is: `list` and `take` write `lastRead`, so `status` can say `never read` or `not read since <time>`, which is the
// only honest answer. `done` is told to the chairman by the liaison; `--hand-fix` counts into `messaging:measure` (hand-fixes by the chairman's session).
//
// EXIT CODES, as `chairman:watch`'s: 0 done, 2 refused (usage, config, an OK that does not verify, a secret shape, an id it does not know; NOTHING was written), 1 a failure.

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { classifyText, VERDICT } from "./classify.ts";
import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { createLedger, describeError } from "./ledger.ts";
import { checkMessage } from "./record.ts";
import { defaultLedgerPath } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
export const QUEUE_FILE = "chairman-session-queue.jsonl";
/** The ledger's direction for what happens to an ask, and for a read of the queue. */
export const QUEUE_DIRECTION = "queue";
/** The closed schema of an ask, in the order it is written. Pinned by the test: a field added here is a field the chairman's session has not been told about. */
export const ASK_FIELDS = Object.freeze(["id", "askedAt", "approvedByMessage", "what", "why", "resultWanted"]);
/** The step `answers.mjs` writes for a "Do it for me" press. */
export const FORME_STEP = "forme";
const FILE_MODE = 0o600;
const GROUP_AND_OTHER = 0o077;
const ID_BYTES = 3;
const MAX_FIELD = 1000;
const TEXT_FIELDS = Object.freeze(["what", "why", "resultWanted"]);

/** @param {string} home @returns {string} where the queue lives: beside the delivery log, in the same 0700 directory */
export function defaultQueuePath(home: string): string {
  return join(home, ".local", "state", "agent-org", "messaging", QUEUE_FILE);
}

/** @param {unknown} line @returns {boolean} whether a parsed line is exactly the closed schema, every field a string */
function isAsk(line: unknown): boolean {
  if (line === null || typeof line !== "object") return false;
  const keys = Object.keys(line);
  return keys.length === ASK_FIELDS.length && ASK_FIELDS.every((field) => keys.includes(field) && typeof /** @type {any} */ (line)[field] === "string");
}

/**
 * @typedef {{id: string, askedAt: string, approvedByMessage: string, what: string, why: string, resultWanted: string}} Ask
 * @param {string} path @returns {Ask[]} every ask, oldest first; none when there is no file. A line that is not an ask is a refusal and not a skip: a queue read past its own damage lies.
 */
export function readAsks(path: string): Ask[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((text, index) => {
    if (text.trim() === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(`queue ${path}: line ${index + 1} is not JSON`, { cause });
    }
    if (!isAsk(parsed)) throw new Error(`queue ${path}: line ${index + 1} is not exactly ${ASK_FIELDS.join(", ")}`);
    return [parsed];
  });
}

/** @param {string} path @returns {string | null} why the file, or the directory it sits in, is not private to its owner, or null: a queue anyone can read is not the chairman's. A loose directory is refused and not repaired: it is shared with the ledger and is not this module's to re-mode. */
function modeProblem(path: string): string | null {
  const directory = dirname(path);
  if (existsSync(directory)) {
    const mode = statSync(directory).mode & 0o777;
    if ((mode & GROUP_AND_OTHER) !== 0) return `${directory} has mode ${mode.toString(8)}, not 700, so nothing was written`;
  }
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  return (mode & GROUP_AND_OTHER) === 0 ? null : `${path} has mode ${mode.toString(8)}, not 600, so nothing was written`;
}

/** @param {string} text @returns {string | null} the field's refusal, or null when its text is one the classifier would pass on as not a secret */
function secretProblem(text: string): string | null {
  const verdict = classifyText(text);
  return verdict.verdict === VERDICT.drop || verdict.verdict === VERDICT.withhold ? "it holds something shaped like a credential, so nothing was written; ask without it" : null;
}

/**
 * Is `ref` the chairman's OK? A press is a ledger line; a message needs his words.
 *
 * @param {Record<string, any>[]} lines the delivery ledger @param {{ref: string, words: string | null}} approval
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function verifyApproval(lines: Record<string, any>[], { ref, words }: { ref: string; words: string | null; }): { ok: true; } | { ok: false; why: string; } {
  if (lines.some((line) => line.direction === "answer" && line.step === FORME_STEP && line.via === "button" && line.messageRef === ref)) return { ok: true };
  return checkMessage(lines, { ref, text: words ?? "" });
}

/**
 * @param {{lines: Record<string, any>[], asks: Ask[], fields: Record<string, string>, ref: string, words: string | null}} input
 * @returns {string | null} why the ask is refused, or null
 */
function refusalOf({ lines, asks, fields, ref, words }: { lines: Record<string, any>[]; asks: Ask[]; fields: Record<string, string>; ref: string; words: string | null; }): string | null {
  for (const name of TEXT_FIELDS) {
    const value = fields[name];
    if (typeof value !== "string" || value.trim() === "") return `--${name === "resultWanted" ? "result-wanted" : name} is required`;
    if (value.length > MAX_FIELD) return `--${name} is over ${MAX_FIELD} characters; one line says what, why and what result is wanted`;
    const secret = secretProblem(value);
    if (secret !== null) return `--${name}: ${secret}`;
  }
  const approval = verifyApproval(lines, { ref, words });
  if (!approval.ok) return approval.why;
  return asks.some((ask) => ask.approvedByMessage === ref) ? `message ${ref} already has an ask: one OK is one ask, so ask the chairman again` : null;
}

/** @param {Record<string, any>[]} lines @returns {Map<string, {taken: boolean, done: Record<string, any> | null}>} what has happened to each ask, folded from the ledger */
function outcomes(lines: Record<string, any>[]): Map<string, { taken: boolean; done: Record<string, any> | null; }> {
  const folded = new Map();
  for (const line of lines.filter((candidate) => candidate.direction === QUEUE_DIRECTION && typeof candidate.id === "string")) {
    const state = folded.get(line.id) ?? { taken: false, done: null };
    if (line.op === "take") state.taken = true;
    if (line.op === "done") state.done = line;
    folded.set(line.id, state);
  }
  return folded;
}

/** @param {Record<string, any>[]} lines @returns {string | null} when the chairman's session last ran `list` or `take`, or null if it never has */
export function lastRead(lines: Record<string, any>[]): string | null {
  const reads = lines.filter((line) => line.direction === QUEUE_DIRECTION && line.op === "read");
  return reads.length === 0 ? null : reads[reads.length - 1].ts;
}

/**
 * The liaison's status line. It never says the session is up, because that is not observable: it says what the file and the ledger show.
 *
 * @param {{asks: Ask[], lines: Record<string, any>[]}} state @returns {string}
 */
export function statusLine({ asks, lines }: { asks: Ask[]; lines: Record<string, any>[]; }): string {
  const seen = outcomes(lines);
  const open = asks.filter((ask) => seen.get(ask.id)?.done == null);
  const read = lastRead(lines);
  const count = `${open.length} open`;
  if (read === null) return `${count}; the chairman's session has never read the queue`;
  return open.some((ask) => Date.parse(ask.askedAt) > Date.parse(read)) ? `${count}; not read since ${read}` : `${count}; last read ${read}`;
}

/**
 * @param {{path: string, ledger: {append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[]}, now: () => number, newId?: () => string}} deps
 */
export function createSessionQueue({ path, ledger, now, newId = () => `q-${randomBytes(ID_BYTES).toString("hex")}` }: { path: string; ledger: { append: (entry: Record<string, unknown>) => Record<string, any>; read: () => Record<string, any>[]; }; now: () => number; newId?: () => string; }) {
  /** @param {string} id @returns {{ask: Ask, taken: boolean, done: Record<string, any> | null} | null} */
  function find(id: string): { ask: Ask; taken: boolean; done: Record<string, any> | null; } | null {
    const ask = readAsks(path).find((candidate) => candidate.id === id);
    return ask === undefined ? null : { ask, ...(outcomes(ledger.read()).get(id) ?? { taken: false, done: null }) };
  }

  return {
    /** @param {{ref: string, words: string | null, what: string, why: string, resultWanted: string}} input @returns {{outcome: "done" | "refused", say: string}} */
    add({ ref, words, ...fields }: { ref: string; words: string | null; what: string; why: string; resultWanted: string; }): { outcome: "done" | "refused"; say: string; } {
      const mode = modeProblem(path);
      if (mode !== null) return { outcome: "refused", say: mode };
      const refusal = refusalOf({ lines: ledger.read(), asks: readAsks(path), fields, ref, words });
      if (refusal !== null) return { outcome: "refused", say: refusal };
      const ask = { id: newId(), askedAt: new Date(now()).toISOString(), approvedByMessage: ref, what: fields.what, why: fields.why, resultWanted: fields.resultWanted };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(ask)}\n`, { mode: FILE_MODE });
      chmodSync(path, FILE_MODE);
      return { outcome: "done", say: `queued ${ask.id} for the chairman's session. Nothing here acts on it; his session reads it.` };
    },

    /** @returns {string[]} the open asks, oldest first, as lines; writes `lastRead` */
    list(): string[] {
      ledger.append({ direction: QUEUE_DIRECTION, op: "read", via: "list" });
      const seen = outcomes(ledger.read());
      const open = readAsks(path).filter((ask) => seen.get(ask.id)?.done == null);
      return open.length === 0 ? ["nothing is open"] : open.map((ask) => `${ask.id}\t${seen.get(ask.id)?.taken ? "taken" : "open"}\t${ask.askedAt}\tapproved by message ${ask.approvedByMessage}\twhat: ${ask.what}\twhy: ${ask.why}\tresult wanted: ${ask.resultWanted}`);
    },

    /** @param {string} id @returns {{outcome: "done" | "refused", say: string}} writes `lastRead` first, whatever the id */
    take(id: string): { outcome: "done" | "refused"; say: string; } {
      ledger.append({ direction: QUEUE_DIRECTION, op: "read", via: "take" });
      const found = find(id);
      if (found === null) return { outcome: "refused", say: `no ask ${id} is in the queue` };
      if (found.done !== null) return { outcome: "refused", say: `${id} is already done` };
      if (found.taken) return { outcome: "done", say: `${id} was already taken. Nothing was written.` };
      ledger.append({ direction: QUEUE_DIRECTION, op: "take", id });
      return { outcome: "done", say: `took ${id}.` };
    },

    /** @param {{id: string, result: string, handFix: boolean}} input @returns {{outcome: "done" | "refused", say: string}} */
    done({ id, result, handFix }: { id: string; result: string; handFix: boolean; }): { outcome: "done" | "refused"; say: string; } {
      const found = find(id);
      if (found === null) return { outcome: "refused", say: `no ask ${id} is in the queue` };
      if (found.done !== null) return { outcome: "refused", say: `${id} is already done` };
      if (result.trim() === "" || result.includes("\n")) return { outcome: "refused", say: "--result is one line saying what happened" };
      const secret = secretProblem(result);
      if (secret !== null) return { outcome: "refused", say: `--result: ${secret}` };
      ledger.append({ direction: QUEUE_DIRECTION, op: "done", id, result, handFix });
      return { outcome: "done", say: `${id} done${handFix ? " (a hand-fix, counted in the measure)" : ""}. The liaison tells the chairman.` };
    },

    /** @returns {string} */
    status: (): string => statusLine({ asks: readAsks(path), lines: ledger.read() }),
  };
}

const DEFAULT_DEPS = () => ({
  root: process.cwd(), home: homedir(), now: Date.now, stdin: readStdin,
  out: (/** @type {string} */ line: string) => console.log(line), err: (/** @type {string} */ line: string) => console.error(line),
});

/** @returns {Promise<string>} what is on stdin; "" for a terminal, which would otherwise hang waiting for a person */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  /** @type {Buffer[]} */
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Thrown for a command that cannot start (usage, config): none of those mends itself by retrying. */
class Refusal extends Error {}

const USAGE = "usage: chairman:queue add --message=<ref> --what=... --why=... --result-wanted=... | list | take <id> | done <id> --result=<one line> [--hand-fix] | status";

/** @param {string[]} positionals @param {number} count @returns {string[]} */
function expectArguments(positionals: string[], count: number): string[] {
  if (positionals.length !== count) throw new Refusal(USAGE);
  return positionals;
}

/** @param {Error} error @returns {number} */
function exitCodeFor(error: Error): number {
  const isUsage = /** @type {any} */ (error).code?.startsWith?.("ERR_PARSE_ARGS") === true;
  return isUsage || error instanceof Refusal || error instanceof MessagingConfigRefusal ? EXIT.refused : EXIT.failed;
}

/**
 * @param {ReturnType<typeof createSessionQueue>} queue @param {{verb: string, positionals: string[], values: Record<string, any>, stdin: () => Promise<string>}} command
 * @returns {Promise<{lines: string[], code: number}>}
 */
async function perform(queue: ReturnType<typeof createSessionQueue>, { verb, positionals, values, stdin }: { verb: string; positionals: string[]; values: Record<string, any>; stdin: () => Promise<string>; }): Promise<{ lines: string[]; code: number; }> {
  const one = (/** @type {{outcome: string, say: string}} */ outcome: { outcome: string; say: string; }) => ({ lines: [outcome.say], code: outcome.outcome === "refused" ? EXIT.refused : EXIT.ok });
  if (verb === "list") return { lines: queue.list(), code: EXIT.ok };
  if (verb === "status") return { lines: [queue.status()], code: EXIT.ok };
  if (verb === "take") return one(queue.take(expectArguments(positionals, 1)[0]));
  if (verb === "done") return one(queue.done({ id: expectArguments(positionals, 1)[0], result: values.result ?? "", handFix: values["hand-fix"] === true }));
  if (verb !== "add") throw new Refusal(USAGE);
  expectArguments(positionals, 0);
  if (typeof values.message !== "string" || values.message === "") throw new Refusal("--message=<the chairman's OK: a message ref> is required");
  return one(queue.add({ ref: values.message, words: await stdin(), what: values.what ?? "", why: values.why ?? "", resultWanted: values["result-wanted"] ?? "" }));
}

/**
 * Only `add` needs messaging switched on: it is the org's side. The chairman's session runs the rest on the same host and needs no declaration.
 *
 * @param {string[]} argv @param {Partial<ReturnType<typeof DEFAULT_DEPS>>} [deps] @returns {Promise<number>} the exit code
 */
export async function main(argv: string[], deps: Partial<ReturnType<typeof DEFAULT_DEPS>> = {}): Promise<number> {
  const { root, home, now, stdin, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: { message: { type: "string" }, what: { type: "string" }, why: { type: "string" }, "result-wanted": { type: "string" }, result: { type: "string" }, "hand-fix": { type: "boolean" } },
    });
    const [verb = "", ...rest] = positionals;
    if (verb === "add" && !readMessagingConfig(resolve(root), { home }).enabled) throw new Refusal("messaging is OFF (no `messaging` key in .agent-org/project.json); nothing was written");
    const queue = createSessionQueue({ path: defaultQueuePath(home), ledger: createLedger({ path: defaultLedgerPath(home), now }), now });
    const { lines, code } = await perform(queue, { verb, positionals: rest, values, stdin });
    for (const line of lines) (code === EXIT.ok ? out : err)(code === EXIT.ok ? line : `chairman:queue: ${line}`);
    return code;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`chairman:queue: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${describeError(error)}`);
    return exitCodeFor(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
