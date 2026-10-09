// @ts-check
// THE SECRET READ BY REFERENCE (a11ign/a11ign#2901; docs/messaging.md decision 1, "Secret by reference only"). A LEAF module.
//
// **A REFUSAL NAMES THE PATH, THE MODE AND THE OWNER, AND NEVER ANY CONTENT.** The file's permissions are judged from the open
// descriptor BEFORE a byte is read, so a refused file is never read at all: there is no content to leak into the message and nothing
// to scrub from it. `O_NOFOLLOW` and `fstat` on the descriptor (not `lstat` then `open`) leave no gap in which a path is swapped for a
// symlink to somebody else's file between the check and the read.
//
// **THE TOKEN LIVES IN A `Secret`, NOT IN A STRING.** `reveal()` is the one door out; `String(secret)`, `JSON.stringify(secret)` and
// `util.inspect(secret)` all say `<secret>`, so a token that wanders into a template literal, a log line or a failed assertion's diff
// does not take its value with it. It is never put in argv, an environment variable or a unit file: a unit names the FILE.
//
// **EVERY ERROR THAT CAN QUOTE A URL GOES THROUGH A REDACTOR.** A failed `fetch` quotes the request URL, and Telegram's URL contains
// `/bot<token>/`. `redactingFetch` wraps a fetch so what it throws has been scrubbed (by the token's own value first, then by the
// shared token-shape patterns) and carries NO `cause`, because the cause is where the unscrubbed URL would still be.

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { inspect } from "node:util";

import { describeError, redact } from "./ledger.ts";

const REDACTED = "<redacted>";
const SECRET_MODE = 0o600;
const MODE_MASK = 0o777;
const WHITESPACE = /\s/;

/** A secret file that is not safe to read, or cannot be. The message names a path, a mode and an owner and nothing it read. */
export class SecretFileRefusal extends Error {
  /** @param {string} path @param {string} reason @param {{ cause?: unknown }} [options] */
  constructor(path: string, reason: string, options: { cause?: unknown; } = {}) {
    super(`${path}: ${reason}`, options);
    this.name = "SecretFileRefusal";
    this.path = path;
  }
}

/**
 * @typedef {{ reveal(): string, scrub(text: string): string, toString(): string, toJSON(): string }} Secret
 */

/** @param {string} value @returns {Secret} */
export function createSecret(value: string): Secret {
  // An empty value would make `scrub`'s split cut between every character.
  if (typeof value !== "string" || value === "") throw new TypeError("a secret is a non-empty string");
  const secret = {
    reveal: () => value,
    /** `text` with this secret's own value removed wherever it appears, then every token-shaped string. */
    scrub: (/** @type {string} */ text: string) => redact(text.split(value).join(REDACTED)),
    toString: () => "<secret>",
    toJSON: () => "<secret>",
    [inspect.custom]: () => "<secret>",
  };
  return Object.freeze(secret);
}

/** @param {number} mode @returns {string} the permission bits as four octal digits, `0644` */
const formatMode = (mode: number): string => (mode & MODE_MASK).toString(8).padStart(4, "0");

/** @param {string} path @returns {number} */
function openWithoutFollowing(path: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = /** @type {{ code?: string }} */ (cause).code;
    const reason = code === "ELOOP" ? "it is a symbolic link, and a secret is read from the file itself" : `it cannot be opened (${code ?? "unknown error"})`;
    throw new SecretFileRefusal(path, reason, { cause });
  }
}

/** @param {string} path @param {import("node:fs").Stats} stats @param {number} uid */
function refuseUnsafe(path: string, stats: import("node:fs").Stats, uid: number) {
  if (!stats.isFile()) throw new SecretFileRefusal(path, "it is not a regular file");
  if (stats.uid !== uid) {
    throw new SecretFileRefusal(path, `it is owned by uid ${stats.uid}, not the running user (uid ${uid}); refusing to read it`);
  }
  if ((stats.mode & MODE_MASK) !== SECRET_MODE) {
    throw new SecretFileRefusal(path, `it has mode ${formatMode(stats.mode)}, not ${formatMode(SECRET_MODE)}; refusing to read it (chmod 600)`);
  }
}

/**
 * The token's text from what the file held. NEVER quotes the content: a file that is wrong is described by its shape.
 * @param {string} path @param {string} content @returns {string}
 */
function tokenFrom(path: string, content: string): string {
  const token = content.trim();
  if (token === "") throw new SecretFileRefusal(path, "it is empty");
  if (WHITESPACE.test(token)) throw new SecretFileRefusal(path, "it holds more than one word or line; a token file holds the token alone");
  return token;
}

/**
 * The descriptor of a secret file that has passed every check, or a refusal. The checks run on the descriptor, before any read.
 * @param {string} path @param {number} uid @returns {number} an open descriptor the caller must close
 */
function openChecked(path: string, uid: number): number {
  const descriptor = openWithoutFollowing(path);
  try {
    refuseUnsafe(path, fstatSync(descriptor), uid);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return descriptor;
}

/** The running user's uid, or -1 where there is none (Windows), which no file is owned by. */
const runningUid = () => process.getuid?.() ?? -1;

/**
 * Read a secret file, or refuse. The file must be a regular file (not a symlink), owned by the running user, with mode exactly 0600.
 * @param {string} path
 * @param {{ uid?: number }} [options] `uid` is the owner the file must have: the running user's, unless a test stands in for another
 * @returns {Secret}
 */
export function readSecretFile(path: string, { uid = runningUid() }: { uid?: number; } = {}): Secret {
  const descriptor = openChecked(path, uid);
  try {
    return createSecret(tokenFrom(path, readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
}

/**
 * What `readSecretFile` would say about this file's permissions, WITHOUT reading it: `messaging:check` makes no network call and has no
 * business holding the token. `null` means the file would be read.
 * @param {string} path @param {{ uid?: number }} [options] @returns {string | null} the refusal's message, or null
 */
export function secretFileProblem(path: string, { uid = runningUid() }: { uid?: number; } = {}): string | null {
  try {
    closeSync(openChecked(path, uid));
    return null;
  } catch (error) {
    if (error instanceof SecretFileRefusal) return error.message;
    throw error;
  }
}

/**
 * A `fetch` whose failures cannot carry the secret. The thrown error holds ONE scrubbed line (the whole `cause` chain flattened, as
 * `describeError` does) and no `cause`: a chained error would keep the original, URL and token intact, one property away.
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} fetchImpl @param {Secret} secret @returns {F}
 */
export function redactingFetch<F>(fetchImpl: F, secret: Secret): F {
  return /** @type {F} */ (async (...args) => {
    try {
      return await fetchImpl(...args);
    } catch (error) {
      const redacted = new Error(secret.scrub(describeError(error)));
      redacted.name = "RedactedFetchError";
      throw redacted;
    }
  });
}
