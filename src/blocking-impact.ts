// @ts-check
// module: how many rows each holder shelves, and for how long (a11ign/a11ign#4602, fix 3 of 4 for the lock-gridlock class, epic #4437)
//
// B4 shelves a ready row behind a claim: `partitionUnclaimed(...).blocked` carries `{ number, reason }`, and a B4 reason names the row or pull request it overlaps. The tick computed
// that every two minutes and summed none of it, so one holder could shelve 28 rows for hours and nobody was told. This leaf sums it per HOLDER (the session on the held row or
// pull request) and over time: `BLOCKING_MIN_ROWS` rows shelved for `BLOCKING_MIN_MINUTES` minutes is an incident, raised ONCE per holder per episode.
//
// THE CORE IS PURE (`holdingsOf`, `advance`, `topBlocker`): the blocked list and the previous record in, the next record and the incidents out. `blockingImpactTick` is the only
// part that touches a file, and every effect in it (record file, ledger, row comment) goes through a seam, so a test reaches no network and no host state.
//
// AN EPISODE IS A CONTINUOUS RUN OF TICKS in which the holder shelves at least `BLOCKING_MIN_ROWS`. It ends when the count drops below that, and it is also ended by a gap between ticks of
// more than `MAX_TICK_GAP_MS` (a restart, an outage): minutes nobody observed are not counted as shelved, so an incident never rests on a guess.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FAILURE_LEDGER_FILE, recordFailure } from "./failure-ledger.ts";

export const BLOCKING_MIN_ROWS = 5;
export const BLOCKING_MIN_MINUTES = 30;
/** The failure-ledger class key (`FAILURE_KINDS` is the closed list of the first move; this is the third fix's own key, read by `class-repeat` as any ledger key is). */
export const LOCK_GRIDLOCK_KIND = "lock-gridlock";
/** The record's file name in the state directory. */
export const BLOCKING_FILE = "blocking-impact.json";
/** The tick runs every two minutes; a gap beyond this is a break in observation, not a long shelving. */
export const MAX_TICK_GAP_MS = 10 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MS_PER_MINUTE;
const NAMED_ROWS = 12;

/** What a held row or pull request resolves to: the session holding it, and the row it stands for (a pull request's `Closes`), or `null` when none is known. */
export type Held = { holder: string; row: number | null };
export type Ref = { number: number; repo?: string };
export type Shelved = { number: number; reason: string };
/** One holder's shelving at one tick: the shelved rows, and the held rows that shelve them. */
export type Holding = { rows: number[]; heldRows: number[] };
export type Episode = { since: number; rows: number[]; heldRows: number[]; fired: boolean };
/** `minutes` is the time since the previous tick that this sample stands for, so a sample's row-minutes are `rows * minutes`. */
export type Sample = { at: number; holder: string; row: number | null; rows: number; minutes: number };
export type BlockingRecord = { at: number; episodes: Record<string, Episode>; samples: Sample[] };
export type Incident = { holder: string; since: number; minutes: number; rows: number[]; heldRows: number[] };
export type TopBlocker = { holder: string; row: number | null; rows: number; minutes: number; rowMinutes: number };

/**
 * The row or pull request a B4 reason names, or `null` for any other shelving (a template gap, a branch on `origin`, a declared wait). The two B4 texts are
 * `overlaps the Region of #N, a row already claimed ...` and `overlaps #N[ in repo], which already touches ...` (`file-overlap-rule.ts`).
 * @param {string} reason
 */
export function heldRefOf(reason: string): Ref | null {
  const found = /^overlaps (?:the Region of )?#(\d+)(?: in (\S+?),)?/.exec(reason);
  return found ? { number: Number(found[1]), ...(found[2] === undefined ? {} : { repo: found[2] }) } : null;
}

/**
 * WHO HOLDS THE THING A REASON NAMES. A bare `#N` is a claimed ROW first (its own `session:` label, and it stands for itself), then an open pull request of the home repository (its label, and the row
 * its body `Closes`); `#N in <repo>` is a pull request of that repository only. `null` is a thing nobody is known to hold, which `holdingsOf` counts as unattributed.
 * @param {{ rows: { number: number }[], prs: { number: number, repo?: string }[], sessionOf: (item: any) => string | null, closesOf: (pr: any) => number[] }} open
 */
export function resolverOf({ rows, prs, sessionOf, closesOf }: { rows: { number: number }[]; prs: { number: number; repo?: string }[]; sessionOf: (item: any) => string | null; closesOf: (pr: any) => number[] }): (ref: Ref) => Held | null {
  return ({ number, repo }) => {
    const row = repo === undefined ? rows.find((r) => Number(r.number) === number) : undefined;
    const rowHolder = row === undefined ? null : sessionOf(row);
    if (rowHolder !== null) return { holder: rowHolder, row: number };
    const pr = prs.find((p) => Number(p.number) === number && p.repo === repo);
    const prHolder = pr === undefined ? null : sessionOf(pr);
    return pr === undefined || prHolder === null ? null : { holder: prHolder, row: closesOf(pr)[0] ?? null };
  };
}

/**
 * Per holder, the rows the gate shelves behind it THIS tick. A shelving whose reason names no held thing, or names one nobody is known to hold, belongs to no holder and is
 * COUNTED in `unattributed` rather than dropped, so a resolver that cannot place anything shows as a number and not as an empty gridlock.
 * @param {Shelved[]} blocked @param {(ref: Ref) => Held | null} resolve
 */
export function holdingsOf(blocked: Shelved[], resolve: (ref: Ref) => Held | null): { holdings: Map<string, Holding>; unattributed: number } {
  const holdings = new Map<string, Holding>();
  let unattributed = 0;
  for (const { number, reason } of blocked) {
    const ref = heldRefOf(reason);
    const held = ref === null ? null : resolve(ref);
    if (held === null) { if (ref !== null) unattributed += 1; continue; }
    const prior = holdings.get(held.holder) ?? { rows: [], heldRows: [] };
    holdings.set(held.holder, {
      rows: [...prior.rows, number].sort((a, b) => a - b),
      heldRows: held.row === null || prior.heldRows.includes(held.row) ? prior.heldRows : [...prior.heldRows, held.row].sort((a, b) => a - b),
    });
  }
  return { holdings, unattributed };
}

/** The episodes that carry on from the previous tick, and the new ones. Fired episodes stay fired for as long as they last. */
function nextEpisodes(previous: BlockingRecord | null, { now, holdings, continuous }: { now: number; holdings: Map<string, Holding>; continuous: boolean }): Record<string, Episode> {
  const episodes: Record<string, Episode> = {};
  for (const [holder, holding] of holdings) {
    if (holding.rows.length < BLOCKING_MIN_ROWS) continue;
    const prior = continuous ? previous?.episodes[holder] : undefined;
    episodes[holder] = { since: prior?.since ?? now, rows: holding.rows, heldRows: holding.heldRows, fired: prior?.fired ?? false };
  }
  return episodes;
}

/**
 * ONE TICK: the next record, and the incidents newly due. An incident is due the first tick an episode has lasted `BLOCKING_MIN_MINUTES`, and not again until the episode has
 * ended and a new one has lasted as long. `samples` accrue for EVERY holder shelving anything, below the incident threshold too, so the daily top blocker is not limited to
 * holders that were ever an incident; they are kept for 24 hours.
 * @param {BlockingRecord | null} previous `null` for a record nobody could read, which starts every episode afresh
 * @param {{ now: number, holdings: Map<string, Holding> }} tick
 */
export function advance(previous: BlockingRecord | null, { now, holdings }: { now: number; holdings: Map<string, Holding> }): { record: BlockingRecord; incidents: Incident[] } {
  const continuous = previous !== null && now >= previous.at && now - previous.at <= MAX_TICK_GAP_MS;
  const episodes = nextEpisodes(previous, { now, holdings, continuous });
  const incidents: Incident[] = [];
  for (const [holder, episode] of Object.entries(episodes)) {
    if (episode.fired || now - episode.since < BLOCKING_MIN_MINUTES * MS_PER_MINUTE) continue;
    episode.fired = true;
    incidents.push({ holder, since: episode.since, minutes: Math.floor((now - episode.since) / MS_PER_MINUTE), rows: episode.rows, heldRows: episode.heldRows });
  }
  const minutes = previous !== null && continuous ? (now - previous.at) / MS_PER_MINUTE : 0;
  const fresh: Sample[] = minutes === 0 ? [] : [...holdings].map(([holder, holding]) => ({ at: now, holder, row: holding.heldRows[0] ?? null, rows: holding.rows.length, minutes }));
  const kept = (previous?.samples ?? []).filter((sample) => sample.at > now - DAY_MS);
  return { record: { at: now, episodes, samples: [...kept, ...fresh] }, incidents };
}

/**
 * THE DAILY PASS'S LINE: the holder with the most ROW-MINUTES (rows shelved times minutes shelved) in the 24 hours to `now`, with the row it holds, the most rows it shelved at a
 * tick and the minutes it shelved anything. `null` when nothing was shelved behind anyone in the window (which is a reading, and the caller says so).
 * @param {BlockingRecord} record @param {number} now
 */
export function topBlocker(record: BlockingRecord, now: number): TopBlocker | null {
  const byHolder = new Map<string, TopBlocker>();
  for (const sample of record.samples.filter((s) => s.at > now - DAY_MS && s.at <= now).sort((a, b) => a.at - b.at)) {
    const prior = byHolder.get(sample.holder);
    byHolder.set(sample.holder, {
      holder: sample.holder, row: sample.row ?? prior?.row ?? null, rows: Math.max(prior?.rows ?? 0, sample.rows),
      minutes: (prior?.minutes ?? 0) + sample.minutes, rowMinutes: (prior?.rowMinutes ?? 0) + sample.rows * sample.minutes,
    });
  }
  const ranked = [...byHolder.values()].sort((a, b) => b.rowMinutes - a.rowMinutes || a.holder.localeCompare(b.holder));
  return ranked[0] ?? null;
}

/** @param {number[]} numbers `#1 #2 ...`, cut after `NAMED_ROWS` with the count of the rest */
function rowList(numbers: number[]): string {
  const named = numbers.slice(0, NAMED_ROWS).map((n) => `#${n}`).join(" ");
  return numbers.length > NAMED_ROWS ? `${named} +${numbers.length - NAMED_ROWS} more` : named;
}

/** What the holder is woken with: the count, the minutes and the rows, and the three ways out. */
export function wakeText(incident: Incident): string {
  const held = incident.heldRows.length > 0 ? ` behind ${rowList(incident.heldRows)}` : "";
  return `you are blocking ${incident.rows.length} rows; land, split or release. These ready rows have been shelved${held} for ${incident.minutes} minutes `
    + `(B4: no two rows are worked on the same file at once): ${rowList(incident.rows)}. Land the work, split the Region so the rows stop overlapping it, or release the claim.`;
}

/** The row write on a held row: the same fact for the seat that owns it, with no turn spent (a report that needs no decision is a row write). */
export function rowComment(incident: Incident): string {
  return `<!-- lock-gridlock: ${incident.holder} since ${new Date(incident.since).toISOString()} -->\n`
    + `**This row shelves ${incident.rows.length} ready rows** (${rowList(incident.rows)}) and has for ${incident.minutes} minutes: the gate cannot offer them while \`${incident.holder}\` holds this Region. `
    + "Land, split or release.";
}

/** The ledger ref of an episode: the holder and when it began, so a second episode is a second event and `repeatsIn` can see the class repeat. */
export function episodeRef(incident: Pick<Incident, "holder" | "since">): string {
  return `${incident.holder}@${new Date(incident.since).toISOString()}`;
}

export type BlockingOrder = { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string };

/** The wake order. `ready-row-unclaimable` is the existing judgment cause for "whose tree is it, and should it be released"; a new cause would be a change to the closed vocabulary. */
export function wakeOrder(incident: Incident): BlockingOrder {
  const discriminator = `${incident.holder}-${incident.since}`;
  return { session: incident.holder, cause: "ready-row-unclaimable", subject: incident.heldRows[0] === undefined ? `holder-${incident.holder}` : `row-${incident.heldRows[0]}`,
    discriminator, prompt: wakeText(incident), causeKey: `${incident.holder}/lock-gridlock/${discriminator}` };
}

/** @returns the record; throws for text that is not one (the caller tells an absent file, ENOENT, from a corrupt one) */
export function parseRecord(text: string): BlockingRecord {
  const parsed = JSON.parse(text);
  if (typeof parsed?.at !== "number" || typeof parsed.episodes !== "object" || parsed.episodes === null || !Array.isArray(parsed.samples)) {
    throw new Error(`${BLOCKING_FILE} is not a blocking record: ${text.slice(0, 120)}`);
  }
  return parsed as BlockingRecord;
}

/** The one line per holder a tick logs, so `work:tick` prints each holder's shelved count (the row's Done-when 2). */
export function holdingLines(holdings: Map<string, Holding>, { episodes, unattributed }: { episodes: Record<string, Episode>; unattributed: number }): string[] {
  const lines = [...holdings].map(([holder, h]) => `blocking-impact: ${holder} shelves ${h.rows.length} rows${h.heldRows.length > 0 ? ` behind ${rowList(h.heldRows)}` : ""}: ${rowList(h.rows)}${episodes[holder] ? " (episode open)" : ""}`);
  return unattributed > 0 ? [...lines, `blocking-impact: ${unattributed} B4 shelvings name a row or pull request nobody is known to hold`] : lines;
}

export type BlockingIo = {
  read?: (path: string) => string; write?: (path: string, text: string) => void;
  comment?: (row: number, body: string) => void; record?: typeof recordFailure; log?: (line: string) => void;
};

const readText = (path: string) => readFileSync(path, "utf8");
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
const logToStderr = (line: string) => process.stderr.write(`${line}\n`);
const firstLine = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);

/** @returns the previous record, or `null` for none or one that cannot be read; an unreadable one is REPORTED, so a corrupt file is not mistaken for a first tick */
function previousRecord(path: string, { read, log }: Required<Pick<BlockingIo, "read" | "log">>): BlockingRecord | null {
  try {
    return parseRecord(read(path));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") log(`blocking-impact: ${path} could not be read (${firstLine(cause)}); every episode starts afresh`);
    return null;
  }
}

/** Raise an incident: the ledger event, the row writes, and the wake order. Each effect reports its own refusal and none stops the others. */
function raise(incident: Incident, { logPath, now, io }: { logPath: string; now: number; io: Required<BlockingIo> }): BlockingOrder {
  io.record({ logPath, classKey: LOCK_GRIDLOCK_KIND, ref: episodeRef(incident), now, report: io.log });
  for (const row of incident.heldRows) {
    try {
      io.comment(row, rowComment(incident));
    } catch (cause) {
      io.log(`blocking-impact: the row write on #${row} was refused (${firstLine(cause)})`);
    }
  }
  return wakeOrder(incident);
}

/**
 * THE ONE CALL THE GATE MAKES. Sums this tick's `blocked` per holder, advances the record in `stateDir`, and for each incident newly due records it, writes the held rows and
 * returns the holder's wake order. Never throws. A record that could not be WRITTEN raises the incident's ledger event and order (the wake and the ledger de-duplicate by key) but
 * writes no row comment, which would otherwise be repeated every tick.
 * @param {{ blocked: Shelved[], resolve: (ref: Ref) => Held | null, stateDir: string, now: number } & BlockingIo} tick
 */
export function blockingImpactTick({ blocked, resolve, stateDir, now, ...seams }: { blocked: Shelved[]; resolve: (ref: Ref) => Held | null; stateDir: string; now: number } & BlockingIo): BlockingOrder[] {
  const io: Required<BlockingIo> = { read: readText, write: writeAtomic, comment: () => {}, record: recordFailure, log: logToStderr, ...seams };
  const path = `${stateDir}/${BLOCKING_FILE}`;
  try {
    const { holdings, unattributed } = holdingsOf(blocked, resolve);
    const { record, incidents } = advance(previousRecord(path, io), { now, holdings });
    for (const line of holdingLines(holdings, { episodes: record.episodes, unattributed })) io.log(line);
    const kept = persisted(path, record, io);
    return incidents.map((incident) => raise(incident, { logPath: `${stateDir}/${FAILURE_LEDGER_FILE}`, now, io: kept ? io : { ...io, comment: () => {} } }));
  } catch (cause) {
    io.log(`blocking-impact: this tick's count was not made (${firstLine(cause)})`);
    return [];
  }
}

/** @returns whether the record was kept; a refusal is reported */
function persisted(path: string, record: BlockingRecord, io: Required<BlockingIo>): boolean {
  try {
    io.write(path, JSON.stringify(record));
    return true;
  } catch (cause) {
    io.log(`blocking-impact: ${path} was not written (${firstLine(cause)}); an open episode will be counted again next tick`);
    return false;
  }
}
