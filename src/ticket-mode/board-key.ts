// @ts-check
// The board's key, kept in a file only its owner can read, for the scripts on this machine that drive the board.
//
// THE KEY NEVER GOES IN A URL, AND NEVER TO A BROWSER. A URL lands in browser history, in a shared screen and in a log, and a browser sends its
// cookies for 127.0.0.1 to every port there. A browser pairs with a one-time code instead (`pairing.ts`) and holds a session of its own
// (`browser-sessions.ts`). Anyone who can read the file can already act as its owner, so a file another user owns, or one whose mode is wider
// than 600, is refused rather than used.
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEY_BYTES = 24;
const KEY_SHAPE = new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}$`);

/** Where the board's key lives under the host's state directory. */
export function boardKeyPath(stateDir: string): string {
  return join(stateDir, "tickets", "board.key");
}

/** What to do about a key file that is missing, and about one that is someone else's or holds no key. */
export type KeyRemedies = Readonly<{ missing: string; remake: string }>;

const OWN_KEY: KeyRemedies = {
  missing: "start the instance once with agent-org ticket:serve, which makes it",
  remake: "delete it, and the instance makes a new one at its next start",
};

/** The key in `path`. REFUSES a missing file, a file a user other than `owner` owns or can read, and one that is not a key. */
export function readBoardKey(path: string, owner: number | undefined = process.getuid?.(), remedies: KeyRemedies = OWN_KEY): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new Error(`${path} does not exist: ${remedies.missing}`);
  }
  try {
    const { mode, uid } = fstatSync(fd);
    if (uid !== owner) throw new Error(`${path} belongs to another user: ${remedies.remake}`);
    if ((mode & 0o077) !== 0) throw new Error(`${path} can be read by other users (mode ${(mode & 0o777).toString(8)}): run chmod 600 on it`);
    const key = readFileSync(fd, "utf8").trim();
    if (!KEY_SHAPE.test(key)) throw new Error(`${path} does not hold a board key: ${remedies.remake}`);
    return key;
  } finally {
    closeSync(fd);
  }
}

/** The key in `path`, made first, with mode 600, when there is none. */
export function boardKey(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return readBoardKey(path);
}
