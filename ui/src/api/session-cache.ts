import type { ViewConnection } from "./types.ts";

/**
 * THE LAST GOOD ANSWER OF EACH READ, KEPT FOR THE TAB (A11-270): every route is a page load of its own, so without it each click in the sidebar would start again from a skeleton. A page
 * draws what the tab last read at once and refreshes it in place. It holds no secret: these are the answers the page already held, which `ticket:ui` keeps on disk too (`last-known.ts`).
 * Storage that is refused or full is simply not used: the page then starts from its skeleton, as it did before.
 */

/** A kept answer, and when it was read (milliseconds since the epoch). */
export type Kept<T> = Readonly<{ data: T; readAt: number }>;

/** The browser's `sessionStorage`, or null where it is refused (a private window, a blocked site). */
export function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

const PREFIX = "ticket-mode.read.";

/** Where the answer to `path` from `connection` is kept: one instance's answers are never another's. The connections list is read at the root, as a null connection. */
export const cacheKey = (connection: ViewConnection | null, path: string): string => `${PREFIX}${connection === null ? "" : `${connection.kind}:${connection.name}`} ${path}`;

const isKept = (value: unknown): value is Kept<unknown> => typeof value === "object" && value !== null && "data" in value && typeof (value as { readAt?: unknown }).readAt === "number";

/** The answer kept for `path` from `connection`, or null when there is none or it cannot be read. */
export function readCached<T>(connection: ViewConnection | null, path: string): Kept<T> | null {
  try {
    const stored = tabStorage()?.getItem(cacheKey(connection, path));
    if (stored === null || stored === undefined) return null;
    const kept: unknown = JSON.parse(stored);
    return isKept(kept) ? (kept as Kept<T>) : null;
  } catch {
    return null;
  }
}

/** Keep `data` as the answer to `path` from `connection`, read now. When it does not fit, the older copy goes too, so the next page never draws an answer older than this one. */
export function writeCached<T>(connection: ViewConnection | null, path: string, data: T): void {
  const key = cacheKey(connection, path);
  try {
    tabStorage()?.setItem(key, JSON.stringify({ data, readAt: Date.now() }));
  } catch {
    try {
      tabStorage()?.removeItem(key);
    } catch {
      // Refused storage keeps nothing, and so has nothing older to draw.
    }
  }
}

/** Drop every answer the tab kept, to make room for what a person typed (`use-drafts.ts`), which matters more. */
export function clearCached(): void {
  try {
    const storage = tabStorage();
    if (storage === null) return;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "");
    for (const key of keys.filter((name) => name.startsWith(PREFIX))) storage.removeItem(key);
  } catch {
    // Refused storage keeps nothing to drop.
  }
}
