// @ts-check
// One-time codes that pair a browser with the board. A person reads the code in a terminal and types it into the browser, so the board's key
// never travels in a URL.
//
// One code is live at a time, for ten minutes, and it works once. Five wrong guesses burn it, so a process on this machine cannot walk the
// code space: eight characters from an alphabet of 30 is about 6.6e11 codes, and a guesser gets five.
import { randomInt, timingSafeEqual } from "node:crypto";

export const PAIR_MINUTES = 10;
const PAIR_TRIES = 5;
/** Characters a person cannot misread for one another: no 0 or O, no 1, I or L, and no U. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 8;

export type Pairing = Readonly<{
  /** Makes a new code, which replaces any code still live, and returns it as a person reads it: `ABCD-EFGH`. */
  mint: () => string;
  /** Whether `given` is the live code. A match uses the code up. Case, spaces and dashes in `given` do not matter. */
  redeem: (given: unknown) => boolean;
}>;

export function createPairing(now: () => number = Date.now, pick: (n: number) => number = randomInt): Pairing {
  let live: { code: string; expires: number; tries: number } | null = null;
  return {
    mint() {
      const code = Array.from({ length: LENGTH }, () => ALPHABET[pick(ALPHABET.length)]).join("");
      live = { code, expires: now() + PAIR_MINUTES * 60_000, tries: 0 };
      return `${code.slice(0, LENGTH / 2)}-${code.slice(LENGTH / 2)}`;
    },
    redeem(given) {
      const code = String(given ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
      if (live === null || now() > live.expires) {
        live = null;
        return false;
      }
      if (code.length === live.code.length && timingSafeEqual(Buffer.from(code), Buffer.from(live.code))) {
        live = null;
        return true;
      }
      live.tries += 1;
      if (live.tries >= PAIR_TRIES) live = null;
      return false;
    },
  };
}
