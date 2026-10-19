// a11ign/a11ign#4505, agent-org#903: a day's manager spend read from the trace. Fixtures only: a store file in a temp directory, no `gh`, no model.
// no-token: gh -- every source is an injected fixture
//
// THE FIXTURE is three UTC days, 2026-10-09 to 2026-10-11, and one session that is not a manager. All prices are `claude-fable-5-1`'s (PRICES: $10/M input, $0.25/M cache read,
// and $0.20/M cache read at the client rate), so every figure below is worked by hand:
//   ceo, 10-10:              turns 1M input = $10.00; 2M cache read = $0.50 primary, $0.40 client       => $10.50 / $10.40, 2 turns
//   product-manager, 10-10:  turn 2M input = $20.00 both                                                => $20.00 / $20.00, 1 turn
//   orchestrator, 10-10:     nothing                                                                    => $0, 0 wakes
//   total                    $30.50 / $30.40, 3 turns
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readStore } from "./store.ts";
import type { TraceEvent } from "./store.ts";
import { BASELINE_USD, isManagerSpend, managerSpendReading, parseManagerSpendArgs, renderReading, TARGET_BAND } from "./manager-spend.ts";

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const DAY = "2026-10-10";
const tokens = (input: number, cacheRead = 0) => ({ input, output: 0, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });
const M = 1_000_000;

let serial = 0;
/** A fixture event; `servedBy` is not on `TraceEvent` until the cutover-seam row, so extras ride on a record type. */
type Fixture = TraceEvent & Record<string, unknown>;
const base = (kind: "turn" | "wake", session: string, when: number): Fixture => {
  serial += 1;
  return { id: `${kind}:${session}:${when}:${serial}`, kind, source: kind === "wake" ? "wake-ledger" : "transcript", at: when, session, row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null };
};
const turn = (session: string, when: number, usage: ReturnType<typeof tokens>): Fixture => ({ ...base("turn", session, when), model: "claude-fable-5-1", tokens: usage, costUsd: 999 });
const wake = (session: string, when: number, extra: Record<string, unknown> = {}): Fixture => ({ ...base("wake", session, when), ...extra });

const ON_DAY = [
  turn("ceo", at(DAY, 1), tokens(M)), turn("ceo", at(DAY, 2), tokens(0, 2 * M)), turn("product-manager", at(DAY, 3), tokens(2 * M)),
  wake("ceo", at(DAY, 1), { outcome: "wrote", servedBy: "run" }), wake("ceo", at(DAY, 2), { outcome: "no-op", servedBy: "seat" }), wake("ceo", at(DAY, 3), { outcome: null }),
  wake("product-manager", at(DAY, 4), { outcome: "wrote", servedBy: "run" }), wake("product-manager", at(DAY, 5), { outcome: "escalated", servedBy: "seat" }),
];
/** Everything that must NOT be in 2026-10-10: the neighbouring days (one at the day's last millisecond, one at the next day's first), and a worker's turn on the day. */
const AROUND = [
  turn("ceo", at("2026-10-09", 23), tokens(50 * M)), wake("ceo", at("2026-10-09", 23), { outcome: "wrote", servedBy: "run" }),
  turn("ceo", Date.parse("2026-10-11T00:00:00Z"), tokens(50 * M)), wake("orchestrator", Date.parse("2026-10-11T00:00:00Z"), { outcome: "wrote", servedBy: "run" }),
  turn("ceo", Date.parse("2026-10-10T23:59:59.999Z"), tokens(0, 4 * M)),
  turn("worker-agent-org-903", at(DAY), tokens(50 * M)), wake("worker-agent-org-903", at(DAY), { outcome: "wrote", servedBy: "run" }),
];
// the 4M cache-read turn at 23:59:59.999 is IN the day: $1.00 primary, $0.80 client, so ceo is $11.50 / $11.20

const row = (reading: ReturnType<typeof managerSpendReading>, session: string) => reading.rows.find((r) => r.session === session) as ReturnType<typeof managerSpendReading>["rows"][number];

test("POSITIVE CONTROL: three days of known costs give the day's per-session and total spend, wakes and servedBy counts", () => {
  const reading = managerSpendReading([...ON_DAY, ...AROUND], { day: DAY });
  const ceo = row(reading, "ceo");
  assert.deepEqual([ceo.turns, ceo.usd, ceo.usdAtClientRate], [3, 11.5, 11.2]);
  assert.deepEqual([ceo.wakes, ceo.wrote, ceo.noOp, ceo.escalated, ceo.outcomeUnknown, ceo.servedByRun, ceo.lackingServedBy], [3, 1, 1, 0, 1, 1, 1]);
  const pm = row(reading, "product-manager");
  assert.deepEqual([pm.turns, pm.usd, pm.usdAtClientRate, pm.wakes, pm.wrote, pm.escalated, pm.servedByRun, pm.lackingServedBy], [1, 20, 20, 2, 1, 1, 1, 0]);
  const quiet = row(reading, "orchestrator");
  assert.deepEqual([quiet.turns, quiet.usd, quiet.wakes], [0, 0, 0]);
  const { total } = reading;
  assert.deepEqual([total.turns, total.usd, total.usdAtClientRate, total.wakes, total.servedByRun, total.lackingServedBy], [4, 31.5, 31.2, 5, 2, 1]);
  assert.deepEqual([reading.band, reading.baseline], [TARGET_BAND, BASELINE_USD]);
  assert.deepEqual([TARGET_BAND.low, TARGET_BAND.high, BASELINE_USD], [60, 80, 109]);
});

test("NEGATIVE CONTROL: the same event written twice counts once, through readStore and when handed in twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "manager-spend-"));
  made.push(dir);
  const store = join(dir, "events.ndjson");
  const lines = [...ON_DAY, ON_DAY[0], ON_DAY[3]]; // a turn and a wake each on two lines
  writeFileSync(store, `${lines.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const reading = managerSpendReading(readStore(store), { day: DAY });
  assert.deepEqual([reading.total.turns, reading.total.usd, reading.total.wakes], [3, 30.5, 5]);
  const handed = managerSpendReading(lines as TraceEvent[], { day: DAY });
  assert.deepEqual([handed.total.turns, handed.total.usd, handed.total.wakes], [3, 30.5, 5]);
});

test("NEGATIVE CONTROL: a superseded copy of a wake is the later copy, not both", () => {
  const dir = mkdtempSync(join(tmpdir(), "manager-spend-"));
  made.push(dir);
  const store = join(dir, "events.ndjson");
  const first = wake("ceo", at(DAY), { outcome: null });
  writeFileSync(store, `${JSON.stringify(first)}\n${JSON.stringify({ ...first, outcome: "wrote", servedBy: "run" })}\n`);
  const ceo = row(managerSpendReading(readStore(store), { day: DAY }), "ceo");
  assert.deepEqual([ceo.wakes, ceo.wrote, ceo.outcomeUnknown, ceo.servedByRun], [1, 1, 0, 1]);
});

test("NEGATIVE CONTROL: an event outside the day or of a non-manager session is excluded", () => {
  const reading = managerSpendReading(AROUND.filter((event) => event.session !== "ceo" || event.at < at(DAY)), { day: DAY });
  assert.deepEqual([reading.total.turns, reading.total.usd, reading.total.wakes], [0, 0, 0]);
  assert.deepEqual(reading.rows.map((r) => r.session), ["ceo", "product-manager", "orchestrator"]);
  const asked = managerSpendReading(AROUND, { day: DAY, sessions: ["worker-agent-org-903"] });
  assert.deepEqual([asked.total.turns, asked.total.wakes], [1, 1]); // the same events ARE counted when the session is asked for: the exclusion is the filter's, not an accident of the data
});

test("NEGATIVE CONTROL: wakes lacking servedBy are counted in `lacking`, as neither seat nor run", () => {
  const old = [wake("ceo", at(DAY, 1), { outcome: "wrote" }), wake("ceo", at(DAY, 2), { outcome: "no-op", servedBy: null }), wake("ceo", at(DAY, 3), { outcome: "wrote", servedBy: "seat" })];
  const ceo = row(managerSpendReading(old, { day: DAY }), "ceo");
  assert.deepEqual([ceo.wakes, ceo.servedByRun, ceo.lackingServedBy], [3, 0, 2]);
  assert.match(renderReading(managerSpendReading(old, { day: DAY })), /2 wakes carried no `servedBy`/);
});

test("NEGATIVE CONTROL: an empty day renders a table saying zero wakes, not nothing", () => {
  const reading = managerSpendReading(ON_DAY, { day: "2026-10-12" });
  const text = renderReading(reading);
  assert.match(text, /\*\*0 manager wakes\*\*/);
  assert.match(text, /\| total \| 0 \| 0 \| \$0\.00 \|/);
  assert.match(text, /below the target band of \$60 to \$80 a day; baseline \$109\.00/);
  assert.match(renderReading(managerSpendReading([], { day: DAY })), /0 manager wakes/);
});

test("the table of a day with wakes names the figures and its place against the band", () => {
  const text = renderReading(managerSpendReading(ON_DAY, { day: DAY }));
  assert.match(text, /^### Manager spend, 2026-10-10 \(UTC\)/);
  assert.match(text, /\| ceo \| 2 \| 0 \| \$10\.50 \| \$10\.40 \| 3 \| 1 \| 1 \| 0 \| 1 \| 1 \| 1 \|/);
  assert.match(text, /Total at the primary price: \$30\.50 \(below the target band of \$60 to \$80 a day; baseline \$109\.00, difference \$-78\.50\)/);
  assert.doesNotMatch(text, /\*\*0 manager wakes\*\*/);
});

test("the first table is pinned byte for byte: the cause table is added under it and changes none of its cells", () => {
  const table = [
    "| session | turns | unpriced | usd (PRICES) | usd (cache reads at $0.20/M) | wakes | wrote | no-op | escalated | outcome unknown | served by run | servedBy absent |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    "| ceo | 2 | 0 | $10.50 | $10.40 | 3 | 1 | 1 | 0 | 1 | 1 | 1 |",
    "| product-manager | 1 | 0 | $20.00 | $20.00 | 2 | 1 | 0 | 1 | 0 | 1 | 0 |",
    "| orchestrator | 0 | 0 | $0.00 | $0.00 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
    "| total | 3 | 0 | $30.50 | $30.40 | 5 | 2 | 1 | 1 | 1 | 2 | 1 |",
  ].join("\n");
  const text = renderReading(managerSpendReading(ON_DAY, { day: DAY }));
  assert.ok(text.includes(table), text);
  assert.ok(text.includes("| cause | wakes | served by run | share of wakes |\n| --- | ---: | ---: | ---: |\n| (no cause) | 5 | 2 | 100.0% |"), text);
});

test("POSITIVE CONTROL: the day's wakes group by cause, one served by a run, one by a seat and one with no cause, and their rows add up to the day's wakes", () => {
  const byCause = [
    wake("ceo", at(DAY, 1), { cause: "row-call-count-signal", outcome: "wrote", servedBy: "run" }),
    wake("ceo", at(DAY, 2), { cause: "pr-review-blocked", outcome: "no-op", servedBy: "seat" }),
    wake("product-manager", at(DAY, 3), { cause: "pr-review-blocked", outcome: "escalated", servedBy: "seat" }),
    wake("product-manager", at(DAY, 4), { outcome: "wrote", servedBy: "seat" }),
  ];
  const reading = managerSpendReading(byCause, { day: DAY });
  assert.deepEqual(reading.causes.map((c) => [c.cause, c.wakes, c.servedByRun, c.share]), [["pr-review-blocked", 2, 0, 0.5], [null, 1, 0, 0.25], ["row-call-count-signal", 1, 1, 0.25]]);
  const text = renderReading(reading);
  assert.match(text, /^Wakes by cause, largest first \(the rows add up to the 4 wakes\):$/m);
  assert.equal(reading.causes.reduce((sum, c) => sum + c.wakes, 0), reading.total.wakes);
  assert.match(text, /^\| pr-review-blocked \| 2 \| 0 \| 50\.0% \|$/m);
  assert.match(text, /^\| \(no cause\) \| 1 \| 0 \| 25\.0% \|$/m);
  assert.match(text, /^\| row-call-count-signal \| 1 \| 1 \| 25\.0% \|$/m);
  assert.deepEqual(managerSpendReading([], { day: DAY }).causes, []);
  assert.doesNotMatch(renderReading(managerSpendReading([], { day: DAY })), /Wakes by cause/);
});

test("the subcommand: its word is only a command in first place, and its arguments are checked", () => {
  assert.equal(isManagerSpend(["--", "manager-spend", "--day", DAY]), true);
  assert.equal(isManagerSpend(["--cause", "manager-spend"]), false);
  assert.deepEqual(parseManagerSpendArgs(["manager-spend", "--day", DAY, "--store", "/x", "--sessions", "ceo,orchestrator"]), { day: DAY, sessions: ["ceo", "orchestrator"], store: "/x" });
  assert.throws(() => parseManagerSpendArgs(["manager-spend"]), /--day is required/);
  assert.throws(() => parseManagerSpendArgs(["manager-spend", "--day", "2026-02-30"]), /real UTC date/);
  assert.throws(() => parseManagerSpendArgs(["manager-spend", "--day", DAY, "--by", "x"]), /unknown argument/);
});
