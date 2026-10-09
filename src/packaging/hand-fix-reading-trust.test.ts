// no-token: gh -- `gatherChanges` takes `git` and `gh` as seams, so nothing here reaches the real `gh`.
/**
 * #3096: A HAND-FIX COUNT IS A READING ONLY WHEN IT CAN BE STOOD BEHIND. The retrospective of 2026-10-03 printed
 * `25 ... of 305 changes ... 280 change(s) UNREAD` -- 92% of the population unattributable -- as a number the report then
 * trended, while a read of the same function at the same `now` on the host printed `169 ... of 650 ... 18 UNREAD`. A
 * count that cannot attribute most of its population, or that was taken against a base that is not `main`'s head, is
 * `unknown`, and `unknown` is not zero (#1286).
 *
 * THE POPULATIONS HERE ARE THE BOUND'S OWN: every share below is derived from `UNREAD_SHARE_BOUND`, so moving the bound
 * moves the grid with it and the test never types a threshold of its own.
 * POSITIVE CONTROLS, NAMED (an emptiness assertion points at its control): "a reading under the bound STILL prints its
 * count" and "a thrown read is unchanged" below, and the retro's own figures (18 of 650) in the first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNREAD_SHARE_BOUND, assertBaseIsLive, gatherChanges, ledgerLine, readLedger,
} from "../hand-fix-ledger.ts";
import { buildReport, compareReadings, readingNumbers } from "../org-retro.ts";

const NOW = new Date("2026-10-03T00:02:46Z");
const DAY = "2026-10-02T12:00:00Z";
const PREVIOUS_DAY = "2026-09-12T12:00:00Z"; // NOW minus 14d is 09-19, so this is in the window before the current one

interface Fixture { examined: number; unread: number; human?: number; at?: string }

/** `examined` changes in one window: `unread` whose commit author GitHub resolves to nobody, `human` hand fixes, the rest clean. */
function window({ examined, unread, human = 0, at = DAY }: Fixture) {
  return Array.from({ length: examined }, (_, i) => {
    const author = i < human ? "DanBeckDev" : "a11ign-ai-workers";
    const actors = [author, ...(i >= human && i < human + unread ? [null] : [])];
    return { key: `pr:${at}:${i}`, number: i, title: "t", at, author, actors, body: "" };
  });
}

/** The unread count that is exactly AT the bound (not above it) for a population, and one more that is above it. */
const atBound = (examined: number) => Math.floor(UNREAD_SHARE_BOUND * examined);
// populations chosen so `bound * examined` is never a whole number, which keeps the grid off the float edge of `>`
const EXAMINED = [7, 33, 305, 647];

test("#3096 (1) GRID: a window whose unread share exceeds the bound is `unknown` with the share in `why`; at the bound it is read", () => {
  let over = 0;
  for (const examined of EXAMINED) {
    const tooMany = atBound(examined) + 1;
    const refused = readLedger({ read: () => window({ examined, unread: tooMany, human: 1 }), now: NOW });
    assert.equal(refused.status, "unknown", `${tooMany} of ${examined}`);
    assert.equal(refused.count, null);
    assert.equal(refused.trend, "unknown");
    assert.match(refused.why ?? "", new RegExp(`${tooMany} of ${examined} changes \\(${(100 * tooMany / examined).toFixed(1)}%\\)`));
    assert.match(ledgerLine(refused), /^HAND FIXES \(last 14d, target 0\): UNKNOWN -- .*This is not zero\./);
    assert.doesNotMatch(ledgerLine(refused), /: \d+ \(/, "no count is printed");
    over += 1;
    // POSITIVE CONTROL (named): the same population at the bound keeps its count
    const held = readLedger({ read: () => window({ examined, unread: atBound(examined), human: 1 }), now: NOW });
    assert.equal(held.status, "read", `${atBound(examined)} of ${examined}`);
    assert.equal(held.count, 1);
    assert.match(ledgerLine(held), /^HAND FIXES \(last 14d, target 0\): 1 \(1 derived/);
  }
  assert.equal(over, EXAMINED.length, "the grid ran every population");
});

test("#3096 (1) the retrospective's own two readings: 280 of 305 is unknown, 18 of 650 is a count (positive control)", () => {
  const degraded = readLedger({ read: () => window({ examined: 305, unread: 280, human: 25 }), now: NOW });
  assert.equal(degraded.status, "unknown");
  assert.match(degraded.why ?? "", /280 of 305 changes \(91\.8%\)/);
  const healthy = readLedger({ read: () => window({ examined: 650, unread: 18, human: 169 }), now: NOW });
  assert.equal(healthy.status, "read");
  assert.equal(healthy.count, 169);
  assert.match(ledgerLine(healthy), /169 \(169 derived, 0 declared, 0 both\) of 650 changes.*18 change\(s\) UNREAD/);
});

test("#3096 (1) the PREVIOUS window is held to the bound too, because the trend compares the two", () => {
  const read = () => [
    ...window({ examined: 33, unread: 0, human: 2 }),
    ...window({ examined: 33, unread: atBound(33) + 1, human: 1, at: PREVIOUS_DAY }),
  ];
  const reading = readLedger({ read, now: NOW });
  assert.equal(reading.status, "unknown");
  assert.match(reading.why ?? "", /in the previous window/);
  const clean = readLedger({ read: () => [...window({ examined: 33, unread: 0, human: 2 }), ...window({ examined: 33, unread: 0, human: 1, at: PREVIOUS_DAY })], now: NOW });
  assert.equal(clean.status, "read", "positive control: the same two windows with nothing unread are read");
  assert.equal(clean.trend, "rising");
});

// --- (2) a base that is not main's head ---------------------------------------------------------------------------

const LOCAL = "1".repeat(40);
const LIVE = "2".repeat(40);

/** git and gh seams answering only what the gatherer asks; `liveHead` is what GitHub says `main` is. */
function seams(liveHead: string) {
  const git = (args: string[]) => {
    if (args[0] === "rev-parse") return `${LOCAL}\n`;
    if (args[0] === "log" && args.includes("--first-parent")) return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const gh = (args: string[]) => {
    if (args[0] === "api" && args[1] === "repos/o/r/commits/main") return `${liveHead}\n`;
    if (args[0] === "api") return "";
    if (args[0] === "pr") return "[]";
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { git, gh, repo: "o/r" };
}

test("#3096 (2) a base that is not the live head of main is `unknown`, and `why` names BOTH shas", () => {
  const reading = readLedger({ read: gatherChanges(seams(LIVE)), now: NOW });
  assert.equal(reading.status, "unknown");
  assert.equal(reading.count, null);
  assert.ok(reading.why?.includes(LOCAL) && reading.why.includes(LIVE), `names both shas: ${reading.why}`);
  assert.match(ledgerLine(reading), /^HAND FIXES \(last 14d, target 0\): UNKNOWN -- /);
  assert.throws(() => assertBaseIsLive({ ...seams(LIVE), base: "origin/main" }), /stale/);
});

test("#3096 (2) POSITIVE CONTROL: a base that IS the live head reads, an empty window being a real zero", () => {
  const reading = readLedger({ read: gatherChanges(seams(LOCAL)), now: NOW });
  assert.equal(reading.status, "read");
  assert.equal(reading.count, 0);
  assert.doesNotThrow(() => assertBaseIsLive({ ...seams(LOCAL), base: "origin/main" }));
});

// --- (3) the report's number and verdict --------------------------------------------------------------------------

const noOtherReads = { merged: null, openPrs: null, journal: null, ledger: null, turns: null };

test("#3096 (3) the retro's `handFixes` is null, and its verdict `unknown`, for an unread-heavy read AND a stale base", () => {
  const yesterday = { status: "read" as const, numbers: { handFixes: 100 } };
  const unreadHeavy = readLedger({ read: () => window({ examined: 305, unread: 280, human: 25 }), now: NOW });
  const stale = readLedger({ read: gatherChanges(seams(LIVE)), now: NOW });
  for (const [name, handFixes] of [["unread-heavy", unreadHeavy], ["stale base", stale]] as const) {
    const numbers = readingNumbers(buildReport({ ...noOtherReads, handFixes }, NOW.getTime()));
    assert.equal(numbers.handFixes, null, name);
    const row = compareReadings(numbers, yesterday as never).find((r) => r.id === "handFixes");
    assert.equal(row?.verdict, "unknown", `${name}: not better, not worse`);
    assert.equal(row?.delta, null);
  }
  // POSITIVE CONTROL (named): a trusted reading's number reaches the table and gets a verdict
  const trusted = readLedger({ read: () => window({ examined: 650, unread: 18, human: 169 }), now: NOW });
  const numbers = readingNumbers(buildReport({ ...noOtherReads, handFixes: trusted }, NOW.getTime()));
  assert.equal(numbers.handFixes, 169);
  assert.equal(compareReadings(numbers, yesterday as never).find((r) => r.id === "handFixes")?.verdict, "worse");
});

// --- (4) the thrown read is unchanged -----------------------------------------------------------------------------

test("#3096 (4) POSITIVE CONTROL: a thrown read is still `unknown` with its first line as `why`, as before", () => {
  const reading = readLedger({ read: () => { throw new Error("gh: HTTP 403 rate limit exceeded\nsecond line"); }, now: NOW });
  assert.equal(reading.status, "unknown");
  assert.equal(reading.why, "gh: HTTP 403 rate limit exceeded");
  assert.match(ledgerLine(reading), /UNKNOWN -- the read was refused \(gh: HTTP 403 rate limit exceeded\)\. This is not zero\./);
});
