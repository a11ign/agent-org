// @ts-check
// THE SPAWNER DOES NOT ADD A PROCESS TO A HOST THAT IS OUT OF MEMORY -- #2508 (`ceo`, #2470 comment 5833038644, M2).
//
// Measured by `ceo` on 2026-09-25: the host went from 25.7 GB free to 351 MB AVAILABLE while ONE runaway `node` ran
// (30.8 GB total), and a spawn in that window would have added a `claude` process (about 200 MB each, `ceo`'s 12:01Z
// process table) to a host the kernel was already choosing victims on. M1 (#2507) caps the process a test run starts;
// this stops the org adding agents to a host that is already short.
//
// A LEAF, LIKE `claim-stall.mjs`: it imports only `node:fs`, so `wake.mjs` can take it and no test that imports
// `wake.mjs` has to know it exists. It DECIDES; `wake.mjs` places the decision (`spawnWorker`, `reviewerTarget`).
//
// THE HOLD IS A REFUSAL AND NOTHING ELSE. It is the same shape as the six `no spawn:` refusals already in the tick log,
// it is never written to the ledger, and so the order is offered again on the next tick: nothing is dropped and nothing
// is counted toward `MAX_DELIVERIES`.
import { readFileSync } from "node:fs";

/** Where the reading comes from, and the name every refusal quotes it under. */
export const MEMINFO_PATH = "/proc/meminfo";

/**
 * A run may name another file, which is what lets a test drive the wake ENTRY (a subprocess) without reading the host
 * it runs on. The host never sets it.
 */
export const MEMINFO_ENV = "A11Y_MEMINFO_PATH";

const KB_PER_MB = 1024;
const KB_PER_GB = 1024 * 1024;

/**
 * THE FLOOR: 5 GiB of `MemAvailable`. **CHOSEN, NOT MEASURED** -- no distribution of `MemAvailable` over the tick
 * ledger exists yet, and until one does this is an argument, not a reading. The argument, all three of it:
 *   - ABOVE the runaway's 351 MB, which is the reading to stay above and not a floor to copy (`ceo`, 2026-09-25);
 *   - WELL BELOW the idle host, 23.8 GB when the row was filed and 27356 MB read by `free -m` when it was claimed, so it does not bite
 *     an ordinary tick;
 *   - NOT SMALLER than M1's cap plus one instance: `DEFAULT_MEMORY_MAX` (`test-memory-cap.mjs`) is 4G and an instance is
 *     about 200 MB, so 4.2 GB is the least at which a spawn that starts a capped run does not begin with the cap already
 *     out of reach. 5 GiB leaves that with about 0.8 GB over.
 * A measured value replaces it in a later PR with no other change.
 */
export const SPAWN_MEMORY_FLOOR_KB = 5 * KB_PER_GB;

/**
 * `MemAvailable` in kB from the text of `/proc/meminfo`, or `null` when the line is absent or is not a number. The
 * kernel's own estimate of what can be started without swapping -- NOT `MemFree`, which counts the page cache as used
 * and would hold a spawn on an idle host that has simply been busy reading files (7.4 GB of `buff/cache` on the reading
 * above).
 * @param {string} text @returns {number | null}
 */
export function parseMemAvailableKb(text) {
  const line = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  return line === null ? null : Number(line[1]);
}

/** @param {number} kb @returns {string} */
function inGb(kb) {
  return kb >= KB_PER_GB ? `${(kb / KB_PER_GB).toFixed(1)} GB` : `${Math.round(kb / KB_PER_MB)} MB`;
}

/**
 * The refusal for a reading below the floor, or `null` at or above it. PURE: it is given a reading and cannot fetch
 * one, so it cannot answer "I could not look", which is {@link spawnMemoryGate}'s to say aloud.
 *
 * THE SENTENCE NAMES THE READING, THE FLOOR AND WHERE THE READING CAME FROM, and says the floor is chosen, so a person
 * reading the tick log needs nothing else to judge whether the hold was right.
 * @param {{availableKb: number, floorKb: number}} reading @returns {string | null}
 */
export function holdForMemory({ availableKb, floorKb }) {
  if (availableKb >= floorKb) return null;
  return `held for memory: the host's MemAvailable is ${inGb(availableKb)} (${availableKb} kB, from ${MEMINFO_PATH}), `
    + `below the ${inGb(floorKb)} floor (${floorKb} kB, CHOSEN -- not yet measured, #2508); a new instance would add a `
    + "process to a host the kernel may already be choosing victims on, so the order is offered again next tick";
}

/**
 * The reading, or WHY there is none -- never a number standing in for an unreadable file. A missing file (a non-Linux
 * host, a stub) and a file with no `MemAvailable` line are different faults and are told apart.
 * @param {{read?: (path: string) => string, path?: string}} [seams]
 * @returns {{availableKb: number} | {unavailable: string}}
 */
export function readMemAvailable({ read = (p) => readFileSync(p, "utf8"), path = MEMINFO_PATH } = {}) {
  let text;
  try {
    text = read(path);
  } catch (err) {
    return { unavailable: `${path} could not be read (${String(err instanceof Error ? err.message : err).split("\n")[0]})` };
  }
  const availableKb = parseMemAvailableKb(text);
  return availableKb === null ? { unavailable: `${path} carries no MemAvailable line` } : { availableKb };
}

/**
 * The gate `wake.mjs` asks before it starts a process: the refusal to quote, or `null` to go ahead. Each call READS
 * afresh -- a tick that starts two instances must not spend one reading twice.
 *
 * AN UNREADABLE READING IS NEITHER A HOLD NOR A SILENT PASS: it spawns as before and `warn`s, so "I could not look" and
 * "memory is fine" are different lines in the tick log (Done-when 4). Holding on it would stop the org on any host
 * without `/proc/meminfo`, which is a worse outage than the one this guards.
 * @param {{read?: (path: string) => string, path?: string, floorKb?: number, warn?: (line: string) => void}} [seams]
 * @returns {() => string | null}
 */
export function spawnMemoryGate({ read, path = process.env[MEMINFO_ENV] || MEMINFO_PATH, floorKb = SPAWN_MEMORY_FLOOR_KB,
  warn = (line) => { process.stderr.write(`${line}\n`); } } = {}) {
  return () => {
    const reading = readMemAvailable({ read, path });
    if ("unavailable" in reading) {
      warn(`wake: memory reading unavailable (${reading.unavailable}) -- spawning WITHOUT the memory check, which is not `
        + "the same as memory being fine.");
      return null;
    }
    return holdForMemory({ availableKb: reading.availableKb, floorKb });
  };
}
