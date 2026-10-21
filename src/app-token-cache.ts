// module: the reader of the App-token cache that core still needs (A11-160)
//
// The GitHub plugin's minter (`plugins/github/app-token.ts`) writes one file per role, `<cache dir>/<role>.token`, holding `<expiry epoch seconds> <token>`, and the routing wrapper reads it in shell. Wake asks one
// question of it: is the reviewer's token missing or about to die, so that it mints a new one BEFORE the reviewer's sandbox needs it (agent-org#1348). That question stays here, reading the format and nothing
// else (never the token it holds), until the reviewer's identity moves into the plugin with the reviewer's other GitHub calls (A11-160, step 3), which deletes this file. A core file imports no plugin's code,
// and the minter is a program that imports no core's, so the format is written down twice and `app-token-cache.test.ts` holds the two to one.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A token with less than this left is replaced: the minter's own margin (`REFRESH_MARGIN_SECONDS` there). */
export const REFRESH_MARGIN_SECONDS = 300;

/** The cache path for a role: beside the other roles', one file each, so a role's refresh never races another's. */
export const tokenPath = (cacheDir: string, role: string): string => join(cacheDir, `${role}.token`);

/** When a cached token dies, in epoch seconds, or `null` for a file that is not the format: a torn or foreign file is a miss, never a token. */
export function expiryOf(text: string): number | null {
  const match = /^(\d{1,12}) (\S+)\n?$/.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * Is the role's cached token missing, or with no more than `marginSeconds` left at `now` (epoch seconds)? The cache file is read here with the rest of the cache, so no other module reads it
 * or holds the token it contains.
 */
export function tokenNeedsRefresh({ cacheDir, role, now, marginSeconds = REFRESH_MARGIN_SECONDS }: { cacheDir: string; role: string; now: number; marginSeconds?: number }): boolean {
  let expiresAt: number | null;
  try {
    expiresAt = expiryOf(readFileSync(tokenPath(cacheDir, role), "utf8"));
  } catch {
    // an absent or unreadable file is a miss; the mint that follows is the thing that reports a real fault
    expiresAt = null;
  }
  return expiresAt === null || expiresAt - now <= marginSeconds;
}
