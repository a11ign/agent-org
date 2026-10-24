// @ts-check
// module: the last good answer `ticket:ui` read from each SSH remote connection, with when it read it, kept in memory and on disk
//
// A REMOTE THAT CANNOT BE REACHED STILL HAS SOMETHING TO SHOW: the page draws the "Last known" view of it (`remote-proxy.ts` sends this beside its "cannot reach" answer). It is a
// cache of what the instance can answer again, so a file that cannot be read counts as empty and the next good answer overwrites it, where the browser sessions' file is refused.
// One mode-600 file per connection, so one remote's large tickets answer is never rewritten by another's, written atomically as `browser-sessions.ts` writes its file.
//
// AN ANSWER BELONGS TO THE MACHINE IT WAS READ FROM, not to the connection's name: `identity` (the ssh target) is kept with each answer, and one read from another target is never
// recalled, so a connection pointed at a different host does not show the old host's tickets as its own.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A good answer and when it was read, as an ISO time. The page keeps the time and draws none (the boards show no age). */
export type Remembered = Readonly<{ value: unknown; readAt: string }>;

export type LastKnown = Readonly<{
  /** Keep `value` as the last good answer of `connection`, reached as `identity`, to `path` (its `/api` path with any query). */
  remember: (connection: string, identity: string, path: string, value: unknown) => void;
  /** The last good answer of `connection` reached as `identity` to `path`, or undefined when none was read. */
  recall: (connection: string, identity: string, path: string) => Remembered | undefined;
}>;

/** The most paths kept for one connection, oldest dropped first. */
export const MOST_PATHS = 16;
/** A saved answer that did not change is written again only when the file's copy is this old, so a poll every 5s does not rewrite the file every time. */
export const REWRITE_AFTER_MS = 60_000;
/** The fewest milliseconds between two writes of one connection's file: the queue is polled every 5s and changes with every run. A change inside the gap is written when it ends. */
export const WRITE_GAP_MS = 5_000;

const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Where the last known answers live under the host's state directory. */
export function lastKnownDir(stateDir: string): string {
  return join(stateDir, "tickets", "last-known");
}

type Held = Remembered & Readonly<{ identity: string }>;
type Entries = Map<string, Held>;

function readEntries(path: string): Entries {
  try {
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return new Map();
    const entries = Object.entries(saved).filter((entry): entry is [string, Held] => {
      const held = entry[1] as Partial<Held> | null;
      return held !== null && typeof held === "object" && "value" in held && typeof held.identity === "string" && typeof held.readAt === "string" && Number.isFinite(Date.parse(held.readAt));
    });
    return new Map(entries);
  } catch {
    return new Map();
  }
}

/** A connection's answers in memory, what its file holds, and when it was last written. */
type Connection = { entries: Entries; onDisk: Entries; wroteAt: number; pending: ReturnType<typeof setTimeout> | undefined };

export type LastKnownOptions = Readonly<{ now?: () => number; writeGapMs?: number }>;

/** The last known answers kept in the directory `dir`, loaded from a connection's file on its first use. `now` and `writeGapMs` are for a test. */
export function createLastKnown(dir: string, { now = Date.now, writeGapMs = WRITE_GAP_MS }: LastKnownOptions = {}): LastKnown {
  const connections = new Map<string, Connection>();
  const fileOf = (name: string): string => {
    if (!CONNECTION_NAME.test(name)) throw new Error(`${name} is not a connection name`);
    return join(dir, `${name}.json`);
  };
  const connectionOf = (name: string): Connection => {
    let held = connections.get(name);
    if (held === undefined) {
      const entries = readEntries(fileOf(name));
      held = { entries, onDisk: new Map(entries), wroteAt: Number.NEGATIVE_INFINITY, pending: undefined };
      connections.set(name, held);
    }
    return held;
  };
  const differsFromFile = (connection: Connection, path: string, entry: Held): boolean => {
    const onDisk = connection.onDisk.get(path);
    if (onDisk === undefined || onDisk.identity !== entry.identity || JSON.stringify(onDisk.value) !== JSON.stringify(entry.value)) return true;
    return Date.parse(entry.readAt) - Date.parse(onDisk.readAt) >= REWRITE_AFTER_MS;
  };
  /** A file that cannot be written leaves the answers in memory only: the page is answered, and the next good answer tries the file again. */
  const write = (name: string, connection: Connection) => {
    connection.pending = undefined;
    const path = fileOf(name);
    connection.wroteAt = now();
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const next = `${path}.${process.pid}.tmp`;
      writeFileSync(next, JSON.stringify(Object.fromEntries(connection.entries)), { mode: 0o600 });
      renameSync(next, path);
      connection.onDisk = new Map(connection.entries);
    } catch {
      connection.onDisk = new Map();
    }
  };
  const schedule = (name: string, connection: Connection) => {
    const wait = connection.wroteAt + writeGapMs - now();
    if (wait <= 0) return write(name, connection);
    if (connection.pending !== undefined) return;
    connection.pending = setTimeout(() => write(name, connection), wait);
    connection.pending.unref();
  };
  return {
    remember(name, identity, path, value) {
      const connection = connectionOf(name);
      const { entries } = connection;
      const entry: Held = { value, readAt: new Date(now()).toISOString(), identity };
      entries.delete(path);
      entries.set(path, entry);
      for (const oldest of [...entries.keys()].slice(0, Math.max(0, entries.size - MOST_PATHS))) entries.delete(oldest);
      if (differsFromFile(connection, path, entry)) schedule(name, connection);
    },
    recall(name, identity, path) {
      const held = connectionOf(name).entries.get(path);
      return held === undefined || held.identity !== identity ? undefined : { value: held.value, readAt: held.readAt };
    },
  };
}
