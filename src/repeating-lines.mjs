// @ts-check
// A LOG LINE THAT REPEATS ABOUT A FAULT IS A DEFECT, AND NOTHING COUNTED THEM (#2848, the chairman's standing Boy Scout rule).
//
// MEASURED 2026-10-01 over 24 hours of `journalctl --user -u a11ign-work-tick`, numbers and timestamps normalised:
// 944 x `NOT RELEASED decline of N ... (Refusing rather than ignoring it ...)` and 935 x `UNDELIVERED claim release not
// done`, the flag guard rejecting the gate's own flag; they were logged for days and fixed by hand. Nobody was woken,
// because the tick is not a reader of its own stderr. A line that says in its own text "if this repeats, no session is
// taking this work" (668 x) had been repeating for a day.
//
// SO THE GATE READS ITS OWN JOURNAL. One `journalctl` call (0.1 s for 24 hours, 12k lines), split into ticks, each line
// normalised, and a line present in K CONSECUTIVE complete ticks is OFFERED to `orchestrator` WITH its count and
// first-seen time, which is `org-routing-and-timers.md`'s rule for a question: it goes in the gate, not in a cron.
//
// A LEAF, RELATIVE IMPORTS ONLY, like `work-gate.mjs` itself, which imports this: it runs before any `pnpm install`/build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// A LEAF (`claim-labels.mjs` imports nothing), so this file keeps its own: the label is read from where it is declared.
import { READY_LABEL } from "./claim-labels.mjs";

/**
 * HOW MANY CONSECUTIVE TICKS MAKE A REPETITION -- 30, which is about an hour at the 2.1-minute tick.
 *
 * FROM THE 7-DAY TABLE ON #2848, NOT GUESSED. 4,763 ticks 2026-09-24..10-01 (journal read as `-o short-iso`, normalised as
 * `normaliseLine` does, longest run of consecutive ticks per line): of 1,547 distinct lines (stack frames and systemd
 * boilerplate left out) 966 never repeated, 90 repeated to a run of exactly two, 130 to 3-4, 126 to 5-9 and 75 to 10-19: that
 * band is the org's weather (a rate limit, a reviewer busy for twenty minutes). From 20 up the population is a fault or an
 * expected state seen for the better part of an hour or more: 58 lines at 20-39, 41 at 40-99 and 61 at 100+, and every fault
 * named in the table ran for hours or DAYS (`NOT RELEASED` 683 ticks, `nowhere to go` 630, the dirty-primary stack trace 684,
 * the 2026-09-26 network outage 562), so an hour's delay costs nothing the line did not already cost. Replaying the detector
 * over the same 4,762 complete ticks with this K and the allowlist offers 37 groups in 7 days, about five a day, each once per
 * judgment window; K=10 would have reached 276 lines against 158 at K=30 (counting every line that ever ran that long).
 */
export const REPEAT_TICKS = 30;

/** How far back the journal is read. 24 h is about 680 ticks, so a run is counted to 680 and reported as "at least" past it. */
export const JOURNAL_SINCE = "-24h";

/** The declared allowlist: ONE file, each entry carrying the reason the line is expected. */
export const ALLOWLIST_FILE = new URL("./repeating-lines.allowlist.json", import.meta.url);

const MINUTES_PER_TICK = 2.1;
const MINUTES_PER_HOUR = 60;

/** How many repetition groups one tick may offer -- a cap on the report, `MAX_ROW_ORDERS_PER_TICK`'s argument. */
export const MAX_GROUPS_PER_TICK = 5;

/** How many lines of one group the prompt quotes: a stack trace is thirty lines and the first six name the fault. */
const MAX_LINES_QUOTED = 6;

/**
 * THE PREFIX THIS MODULE WRITES ON STDERR, and the code (not the allowlist) drops it from what it reads. A line the
 * detector writes every tick for as long as a fault lasts is itself a line repeating for K ticks, so a detector that
 * counted its own report would offer the offer; it is excluded here, with the reason beside it, rather than by an entry
 * in the list it maintains.
 */
const SELF = "repeating-lines:";

/** A tick is complete when systemd has said it finished; the newest tick is usually the one running this very gate. */
const TICK_START = /^Starting a11ign-work-tick\.service/;
const TICK_END = /^(Finished|Failed with result .*) a11ign-work-tick\.service|^a11ign-work-tick\.service: Failed/;

/**
 * One line with what varies between two copies of the SAME line replaced: ISO timestamps, then hex ids (a commit sha, a
 * handoff id -- seven or more hex digits with at least one digit, so an English word is not touched), then every digit
 * run. `#2623` and `#2624`, `worker-2623` and `worker-2624`, and the same sha in different words are one line.
 * @param {string} line
 */
export function normaliseLine(line) {
  return line
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?/g, "T")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, "H")
    .replace(/\d+/g, "N");
}

/**
 * The complete ticks in a `journalctl -o short-iso` read, oldest first, each `{ at, lines: Map<normalised, raw> }`.
 *
 * COMPLETE ONLY. The gate runs INSIDE the newest tick, whose journal lines are the ones written so far; counting it would
 * break every run that includes a line written later in a tick (the `wake` half) by a tick that has not got there yet.
 * A tick is complete when it carries systemd's `Finished`/`Failed` line.
 *
 * The tick's own boilerplate lines (the start and end markers) are dropped here, so no allowlist entry is needed for them.
 * @param {string} journal
 * @returns {{ at: string, lines: Map<string, string> }[]}
 */
export function parseTicks(journal) {
  /** @type {{ at: string, lines: Map<string, string>, done: boolean }[]} */
  const ticks = [];
  for (const entry of journal.split("\n")) {
    const m = entry.match(/^(\S+) \S+ [^\s[]+(?:\[\d+\])?: (.*)$/);
    if (!m) continue;
    const [, at, message] = m;
    if (TICK_START.test(message)) {
      ticks.push({ at, lines: new Map(), done: false });
      continue;
    }
    const current = ticks.at(-1);
    if (!current) continue;
    if (TICK_END.test(message)) current.done = true;
    else if (!message.startsWith(SELF)) current.lines.set(normaliseLine(message), message);
  }
  return ticks.filter((t) => t.done).map(({ at, lines }) => ({ at, lines }));
}

/**
 * The allowlist, parsed. A line with no `reason` is refused: an exemption nobody explained is a silence, and the file
 * exists so each one can be argued with.
 * @param {unknown} parsed the whole parsed JSON document
 * @returns {{ pattern: RegExp, reason: string }[]}
 */
export function parseAllowlist(parsed) {
  const entries = /** @type {any} */ (parsed)?.allow;
  if (!Array.isArray(entries)) throw new Error("repeating-lines allowlist: `allow` must be an array");
  return entries.map((/** @type {any} */ e, i) => {
    if (typeof e?.pattern !== "string" || e.pattern === "") {
      throw new Error(`repeating-lines allowlist: entry ${i} has no \`pattern\``);
    }
    if (typeof e?.reason !== "string" || e.reason.trim() === "") {
      throw new Error(`repeating-lines allowlist: entry ${i} (${e.pattern}) has no \`reason\` -- an exemption must say why`);
    }
    return { pattern: new RegExp(e.pattern), reason: e.reason };
  });
}

/** @param {URL | string} [path] */
export function loadAllowlist(path = ALLOWLIST_FILE) {
  return parseAllowlist(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * @typedef {{ lines: string[], count: number, since: string, atLeast: boolean }} RepeatingGroup
 * `lines` are the newest copies, raw, in the order the tick wrote them; `count` is the consecutive-tick run ending at the
 * newest complete tick; `since` is when the run's first tick began; `atLeast` says the run reaches the edge of the window.
 */

/**
 * The lines present in the newest `k` or more consecutive complete ticks, grouped by the tick the run began on.
 *
 * GROUPED, because one fault writes many lines: a thrown error is thirty (`at ...` frames) and they all start and run
 * together. Offering thirty orders for one stack trace would be the noise this question exists to remove, and a session
 * gets one order per tick anyway. A group is the lines whose runs began on the same tick; its headline is its first.
 *
 * `k - 1` is not offered, a line that stopped and restarted counts only from its restart (the walk back ends at the
 * first tick without it), and an allowlisted line is never offered.
 * @param {{ ticks: { at: string, lines: Map<string, string> }[], k?: number,
 *           allow?: { pattern: RegExp, reason: string }[] }} input
 * @returns {RepeatingGroup[]} longest-running first
 */
export function repeatingLines({ ticks, k = REPEAT_TICKS, allow = [] }) {
  const newest = ticks.at(-1);
  if (!newest) return [];
  /** @type {Map<number, { lines: string[], count: number }>} */
  const byStart = new Map();
  for (const [line, raw] of newest.lines) {
    if (allow.some((a) => a.pattern.test(line))) continue;
    let start = ticks.length - 1;
    while (start > 0 && ticks[start - 1].lines.has(line)) start -= 1;
    const count = ticks.length - start;
    if (count < k) continue;
    const group = byStart.get(start) ?? { lines: [], count };
    group.lines.push(raw);
    byStart.set(start, group);
  }
  return [...byStart].map(([start, { lines, count }]) =>
    ({ lines, count, since: ticks[start].at, atLeast: start === 0 }))
    .sort((a, b) => b.count - a.count);
}

/** The minutes a run of ticks spans at the measured 2.1-minute tick, in hours once it passes two. @param {number} ticks */
const spanOf = (ticks) => {
  const minutes = Math.round(ticks * MINUTES_PER_TICK);
  return minutes >= MINUTES_PER_HOUR * 2 ? `${Math.round(minutes / MINUTES_PER_HOUR)} hours` : `${minutes} minutes`;
};

/** @param {RepeatingGroup} g */
const headline = (g) => g.lines[0];

/** @param {string} line a stable, short id for one group's headline -- the ledger's key must not carry the line itself */
const lineId = (line) => createHash("sha1").update(normaliseLine(line)).digest("hex").slice(0, 10);

/**
 * One order per repetition group, to `orchestrator`, capped at `MAX_GROUPS_PER_TICK`.
 *
 * KEYED ON THE HEADLINE'S NORMALISED TEXT ALONE, never on the count or the first-seen time: both move every tick, and a
 * key that moved with them would re-ask every two minutes instead of once per judgment window. THE PROMPT CARRIES THE
 * OTHER GROUPS, because a session is delivered one order per tick (`alsoOwned`'s argument in `work-gate.mjs`).
 *
 * @param {RepeatingGroup[]} groups
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function repeatingLineOrders(groups) {
  return groups.slice(0, MAX_GROUPS_PER_TICK).map((g) => {
    const id = lineId(headline(g));
    const others = groups.filter((o) => o !== g).map((o) => `"${headline(o).slice(0, 100)}"`);
    const quoted = g.lines.slice(0, MAX_LINES_QUOTED).map((l) => `  ${l.slice(0, 300)}`).join("\n");
    const more = g.lines.length > MAX_LINES_QUOTED ? `\n  ... and ${g.lines.length - MAX_LINES_QUOTED} more line(s) of the same fault` : "";
    return {
      session: "orchestrator",
      cause: "repeating-log-line",
      subject: "repeating-line",
      discriminator: id,
      prompt: `A LOG LINE HAS REPEATED ${g.atLeast ? "AT LEAST " : ""}${g.count} CONSECUTIVE TICKS (about ${spanOf(g.count)}), `
        + `first seen ${g.since}${g.atLeast ? " or earlier (the read covers the last 24 hours only)" : ""}:\n${quoted}${more}\n`
        + "A LINE THAT REPEATS ABOUT A FAULT IS A DEFECT (the chairman's standing Boy Scout rule, #2848): the tick is not a "
        + "reader of its own stderr, so nothing else would tell anyone, and the two `NOT RELEASED`/`UNDELIVERED` lines this "
        + "was built for were logged for days before a person saw them. Read it with `journalctl --user -u "
        + "a11ign-work-tick --since -3h -o cat | grep -F '<a distinctive fragment>'`.\n"
        + `FIX THE CAUSE, OR FILE IT \`${READY_LABEL}\` WITH AN OWNER IN THIS TURN. If it is an expected state, add it to `
        + "`packages/agent-org/src/repeating-lines.allowlist.json` with the reason it is expected, which stops this being asked "
        + "and is the only way it stops. Do not rewrite the line to make it stop matching: that hides the fault and keeps it."
        + (others.length > 0 ? `\nALSO REPEATING (${others.length}): ${others.join("; ")}.` : ""),
      causeKey: `orchestrator/repeating-log-line/${id}`,
    };
  });
}

/** @param {string[]} args */
const journalctl = (args) => execFileSync("journalctl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });

/**
 * The detector's whole tick: read the journal, say on stderr what repeats, return the orders. NEVER THROWS -- a detector
 * that can crash the gate stops every order behind it (`diskHeadroomTick`'s rule) -- and a journal that cannot be read is
 * SAID, never reported as a clean bill: absence of a reading is not a reading of absence.
 *
 * @param {{ run?: (args: string[]) => string, allow?: ReturnType<typeof loadAllowlist> | (() => ReturnType<typeof loadAllowlist>),
 *           k?: number, log?: (line: string) => void }} [io]
 */
export function repeatingLinesTick({ run = journalctl, allow = loadAllowlist, k = REPEAT_TICKS,
  log = (line) => process.stderr.write(line) } = {}) {
  try {
    const ticks = parseTicks(run(["--user", "-u", "a11ign-work-tick", "--since", JOURNAL_SINCE, "-o", "short-iso"]));
    const groups = repeatingLines({ ticks, k, allow: typeof allow === "function" ? allow() : allow });
    for (const g of groups) {
      log(`${SELF} ${g.atLeast ? ">=" : ""}${g.count} ticks since ${g.since}: ${headline(g).slice(0, 160)}\n`);
    }
    return repeatingLineOrders(groups);
  } catch (err) {
    log(`${SELF} could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 160)}) -- no order this tick.\n`);
    return [];
  }
}
