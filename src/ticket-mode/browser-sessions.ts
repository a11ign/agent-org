// @ts-check
// The browsers paired with the board. Each holds a random session of its own, which the board keeps only as a SHA-256 hash, in a mode-600 file,
// so a paired browser stays paired across restarts.
//
// A SESSION IS NOT THE BOARD'S KEY. A browser sends its 127.0.0.1 cookies to every port there, so one may reach another local server. A leaked
// session is one browser's, ends when it expires, and is revoked by deleting the file, which unpairs every browser. The key stays in its file.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long a paired browser stays paired: a year, within the 400 days browsers allow a cookie. */
export const SESSION_SECONDS = 365 * 24 * 60 * 60;

export type BrowserSessions = Readonly<{
  /** A new session for a browser that has just paired. */
  open: () => string;
  /** Whether `value` is a session the board opened and that has not expired. */
  holds: (value: string) => boolean;
}>;

/** Where the paired browsers' sessions live under the host's state directory. */
export function browserSessionsPath(stateDir: string): string {
  return join(stateDir, "tickets", "browsers.json");
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function readExpiries(path: string): Map<string, number> {
  const refuse = () => new Error(`${path} does not hold the board's browser sessions: delete it, which unpairs every browser, and pair again with agent-org ticket:pair`);
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw refuse();
  }
  if (saved === null || typeof saved !== "object" || Array.isArray(saved)) throw refuse();
  const entries = Object.entries(saved);
  if (!entries.every(([hashed, expires]) => /^[0-9a-f]{64}$/.test(hashed) && Number.isFinite(expires))) throw refuse();
  return new Map(entries as [string, number][]);
}

/** The sessions in `path`: each session's hash, with when it expires. A missing file holds none. REFUSES a file that does not hold sessions. */
export function browserSessions(path: string, now: () => number = Date.now): BrowserSessions {
  const expiries = existsSync(path) ? readExpiries(path) : new Map<string, number>();
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    const next = `${path}.${process.pid}.tmp`;
    writeFileSync(next, `${JSON.stringify(Object.fromEntries(expiries), null, 2)}\n`, { mode: 0o600 });
    renameSync(next, path);
  };
  return {
    open() {
      const session = randomBytes(24).toString("hex");
      for (const [key, expires] of expiries) if (expires <= now()) expiries.delete(key);
      expiries.set(hash(session), now() + SESSION_SECONDS * 1000);
      save();
      return session;
    },
    holds(value) {
      const expires = expiries.get(hash(value));
      return expires !== undefined && expires > now();
    },
  };
}
