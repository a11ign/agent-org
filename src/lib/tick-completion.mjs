// @ts-check
// THE RECORD OF A TICK THAT COMPLETED (a11ign/a11ign#3040). `work-tick.mjs` writes it, `messaging/sources/readers.mjs` reads it, and nothing else does.
//
// WHY A FILE AND NOT THE UNIT'S OWN TIMESTAMP. On 2026-10-02 the work-tick unit ran 63 ticks that each died at import, 15:23Z to about 17:40Z, and
// `InactiveEnterTimestamp` moved on every one exactly as it does on a good tick: it answers "did the unit RUN", and `incident:gate-crash` needs "did
// a tick COMPLETE". Only the tick knows it reached the end of `main()`, so the tick says so, and a tick that died writes nothing.
//
// NODE'S OWN MODULES ONLY, so the reader (a leaf) can import it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COMPLETION_FILE = "work-tick-completion.json";

/**
 * Beside the wake ledger, which the tick already resolves (`--ledger`, else the host's state directory) and which `messaging:watch` can resolve the same way.
 * @param {string} ledgerPath @returns {string}
 */
export function completionPath(ledgerPath) {
  return join(dirname(ledgerPath), COMPLETION_FILE);
}

/**
 * Atomic, so a reader never sees half a record.
 * @param {string} path @param {{ at: number, exit: number }} record `at` is epoch milliseconds, `exit` the code the tick is about to exit with
 */
export function writeCompletion(path, { at, exit }) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ at, exit })}\n`);
  renameSync(temporary, path);
}

/**
 * A record that is absent or unreadable THROWS a `TypeError`: no record is "no tick is known to have completed", and handing a clean reading back would be
 * the all-clear this record exists to refuse.
 * @param {string} path @returns {{ at: number, exit: number }}
 */
export function readCompletion(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new TypeError(`no work-tick completion record at ${path}: no tick is known to have completed (${/** @type {Error} */ (error).message})`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`the work-tick completion record at ${path} is not JSON`, { cause: error });
  }
  if (!Number.isFinite(parsed?.at) || !Number.isInteger(parsed?.exit)) {
    throw new TypeError(`the work-tick completion record at ${path} has no numeric \`at\` and integer \`exit\`: ${text.slice(0, 80).trim()}`);
  }
  return { at: parsed.at, exit: parsed.exit };
}
