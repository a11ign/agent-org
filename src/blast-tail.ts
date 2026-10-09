// @ts-check
// module: the line that tells a holder what its claim costs (a11ign/a11ign#4605, fix 4 of 4 for the lock-gridlock class, epic #4437)
//
// A holder was told what to do and never what its claim shelves, so it treated landing as one task among others: a11ign#4389's holder filed follow-up rows while 28 others waited behind it.
// `blastTail` is the third tail on a spawned engineer's order and on every later wake for a claimed row (beside `calmTail` and `tripsTail` in `wake.ts`), read from the record the gate's count
// wrote (`blocking-impact.json`, #4602), never recounted: the list in the line IS the count's list. Nothing shelved prints nothing, not a blank line, and a holder blocking 1 to 4 rows gets
// the line too, because the 5-row threshold is for the incident and not for the information.
//
// THIS LEAF IMPORTS NO `corpus`, AND READS ONE FILE through a seam, so its test reaches no host state.
import { readFileSync } from "node:fs";
import { BLOCKING_FILE, MAX_TICK_GAP_MS, parseRecord, type BlockingRecord } from "./blocking-impact.ts";

/**
 * The rows shelved behind whoever holds `row`, from the last tick's holdings, or `[]` when nothing is known to be. A record older than one missed tick is not a reading of NOW (the gate
 * advances it every two minutes, and a gap beyond `MAX_TICK_GAP_MS` is a break in observation), and a record from before `holdings` was kept says nothing: both are an empty list.
 * @param {number} row @param {BlockingRecord | null} record @param {number} now
 */
export function shelvedBehind(row: number, record: BlockingRecord | null, now: number): number[] {
  if (record?.holdings === undefined || now - record.at > MAX_TICK_GAP_MS) return [];
  const rows = Object.values(record.holdings).filter((holding) => holding.heldRows.includes(row)).flatMap((holding) => holding.rows);
  return [...new Set(rows)].sort((a, b) => a - b);
}

/**
 * THE LINE, as the tail of an order (`\n\n` first), or `""` when `row` shelves nothing. It names every row: the list is bounded by the ready rows, and a cut list would be a second reading.
 * @param {number} row @param {BlockingRecord | null} record @param {number} now
 */
export function blastTail(row: number, record: BlockingRecord | null, now: number): string {
  const shelved = shelvedBehind(row, record, now);
  if (shelved.length === 0) return "";
  return `\n\nLanding this is your first job: your claim blocks ${shelved.length} ${shelved.length === 1 ? "row" : "rows"} (${shelved.map((n) => `#${n}`).join(", ")}), `
    + "which the gate cannot offer while you hold this Region. Land it, split the Region, or release the claim.";
}

/** @returns the gate's last record in `stateDir`, or `null` when there is none or it cannot be read (a wake is never refused for a missing reading); an unreadable one is REPORTED, an absent one is the ordinary case before the first tick */
export function readBlockingRecord(stateDir: string, { read = (path: string) => readFileSync(path, "utf8"), log = (line: string) => process.stderr.write(`${line}\n`) }: { read?: (path: string) => string; log?: (line: string) => void } = {}): BlockingRecord | null {
  const path = `${stateDir}/${BLOCKING_FILE}`;
  try {
    return parseRecord(read(path));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") log(`blast-tail: ${path} could not be read (${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}); this wake names no blocked rows`);
    return null;
  }
}
