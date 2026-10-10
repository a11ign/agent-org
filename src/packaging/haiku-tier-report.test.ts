// no-token: gh -- every closed row is a fixture and the store is a list of events; nothing here reaches `gh` (agent-org#469)
/**
 * `trace/haiku-tier-report.ts`'s EFFORT (agent-org#469): the Haiku trial reading says what effort each row's turns ran at, so a row started at `low` before the launch moved to
 * `high` is told apart from the rest. The stop rule is not what changes, so the same input must give the same verdicts with the effort on its turns and with it taken off.
 *
 * EVERY CLAIM HERE HAS A NEGATIVE CONTROL: a row whose turns name no effort is `unknown` beside the rows that are `low`, and a store turn whose record names none carries no `effort`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsOfTranscript, repriceEvents, type TraceEvent } from "../trace/store.ts";
import { HAIKU_MODEL_ID } from "../worker-profile.ts";
import { effortOfTurns, firstHaikuStart, measuresOf, MIN_RATE_ROWS, reportLines, stopRule, type RowMeasures } from "../trace/haiku-tier-report.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 10);
const REPO = "a11ign/agent-org";

/** `efforts` is what each of the row's turns names (`undefined`: a turn whose record names none). */
type Fixture = { number: number; haiku: boolean; closedAt: number; efforts?: (string | undefined)[]; rejections?: number };

function eventsOf(row: Fixture, { withEffort = true } = {}): Record<string, unknown>[] {
  const model = row.haiku ? HAIKU_MODEL_ID : "claude-sonnet-5-5";
  const efforts = row.efforts ?? ["high", "high"];
  const turns = efforts.map((effort, i) => ({ id: `t${row.number}-${i}`, kind: "turn", source: "transcript", at: T0 + row.number + i, session: `worker-${row.number}`, row: row.number, pr: null, repo: null,
    model, tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, ...(withEffort && effort !== undefined ? { effort } : {}) }));
  const github = (kind: string, key: string, extra = {}) => ({ id: `gh:${REPO}#${row.number}:${kind}:${key}`, kind, source: "github", at: T0, session: "github", row: null, pr: row.number, repo: null, ...extra });
  const reviews = Array.from({ length: row.rejections ?? 0 }, (_, i) => github("reviewed", String(i), { state: "CHANGES_REQUESTED" }));
  return [...turns, ...reviews, github("merged", "m")];
}

const closedRow = (row: Fixture) => ({ number: row.number, haiku: row.haiku, closedAt: row.closedAt, pr: { repo: REPO, number: row.number } });
const fixtureRows = (haiku: boolean, count: number, tweak: (i: number) => Partial<Fixture> = () => ({})): Fixture[] =>
  Array.from({ length: count }, (_, i) => ({ number: (haiku ? 1000 : 2000) + i, haiku, closedAt: T0 + (i + 1) * HOUR, ...tweak(i) }));

function reading(all: Fixture[], options = { withEffort: true }, now = T0 + 100 * HOUR) {
  const events = repriceEvents(all.flatMap((row) => eventsOf(row, options)) as unknown as TraceEvent[]);
  const closed = all.map(closedRow);
  const measured = all.map((row) => measuresOf(closedRow(row), events));
  const haiku: RowMeasures[] = measured.filter((m) => m.haiku);
  const other: RowMeasures[] = measured.filter((m) => !m.haiku);
  const verdicts = stopRule({ haiku, other, closedInWindow: haiku.length, started: firstHaikuStart(closed.filter((row) => row.haiku), events), now });
  return { lines: reportLines({ closed, events, now }), measured, verdicts };
}

const haikuBlock = (lines: string[]) => lines.slice(lines.indexOf("tier:haiku rows:"), lines.indexOf("other rows closed in the same window:"));

test("three Haiku rows, two at low and one at high, print as two effort groups with the right counts", () => {
  const haiku = fixtureRows(true, 3, (i) => ({ efforts: i < 2 ? ["low", "low"] : ["high", "high"] }));
  const { lines, measured } = reading([...haiku, ...fixtureRows(false, 2)]);
  assert.deepEqual(measured.filter((m) => m.haiku).map((m) => m.effort), ["low", "low", "high"]);
  const block = haikuBlock(lines);
  const groups = block.filter((line) => /^ {2}at \S+: /.test(line));
  assert.equal(groups.length, 2, block.join("\n"));
  assert.match(groups[0], /^ {2}at low: 2 rows; first-pass merge n=2, not a rate/);
  assert.match(groups[1], /^ {2}at high: 1 rows; first-pass merge n=1, not a rate/);
  assert.ok(block.includes("  per row: #1000 low, #1001 low, #1002 high"), block.join("\n"));
  // the other arm is split on its own figures, not the Haiku arm's
  const other = lines.slice(lines.indexOf("other rows closed in the same window:"));
  assert.ok(other.some((line) => /^ {2}at high: 2 rows;/.test(line)), other.join("\n"));
  assert.ok(!other.some((line) => /^ {2}at low:/.test(line)));
});

test("a row whose turns disagree prints mixed; a row whose turns name none prints unknown and is not counted as low (negative control)", () => {
  const haiku = [
    ...fixtureRows(true, 1, () => ({ efforts: ["low", "low"] })),
    { number: 1500, haiku: true, closedAt: T0 + 2 * HOUR, efforts: ["low", "high"] },
    { number: 1501, haiku: true, closedAt: T0 + 3 * HOUR, efforts: [undefined, undefined] },
    { number: 1502, haiku: true, closedAt: T0 + 4 * HOUR, efforts: [] },
  ] satisfies Fixture[];
  const { lines, measured } = reading([...haiku, ...fixtureRows(false, 1)]);
  const byNumber = Object.fromEntries(measured.map((m) => [m.number, m.effort]));
  assert.equal(byNumber[1000], "low");
  assert.equal(byNumber[1500], "mixed");
  assert.equal(byNumber[1501], "unknown");
  assert.equal(byNumber[1502], "unknown", "a row with no turns at all is unknown, not low");
  const block = haikuBlock(lines);
  assert.ok(block.some((line) => /^ {2}at low: 1 rows;/.test(line)), `only the one row that named low is at low:\n${block.join("\n")}`);
  assert.ok(block.some((line) => /^ {2}at mixed: 1 rows;/.test(line)));
  assert.ok(block.some((line) => /^ {2}at unknown: 2 rows;/.test(line)));
  assert.ok(block.includes("  per row: #1000 low, #1500 mixed, #1501 unknown, #1502 unknown"), block.join("\n"));
  // a turn that names no effort is not a vote: it neither makes a row mixed nor makes it low
  assert.equal(effortOfTurns([{ effort: "high" }, {}] as unknown as TraceEvent[]), "high");
  assert.equal(effortOfTurns([{ effort: "" }] as unknown as TraceEvent[]), "unknown");
});

test("the stop rule's verdicts on the same input are identical with the effort on the turns and with it taken off", () => {
  const baseline = [...fixtureRows(true, MIN_RATE_ROWS, (i) => ({ efforts: i % 2 === 0 ? ["low"] : ["high"] })), ...fixtureRows(false, MIN_RATE_ROWS)];
  // (a) trips on 4 of 8 reworked Haiku rows; a baseline that trips nothing is read beside it.
  const reworked = [...fixtureRows(true, MIN_RATE_ROWS, (i) => ({ rejections: i < 4 ? 1 : 0, efforts: i < 4 ? ["low"] : ["high"] })), ...fixtureRows(false, MIN_RATE_ROWS)];
  for (const [name, input, tripped] of [["baseline", baseline, []], ["reworked", reworked, ["a"]]] as const) {
    const withEffort = reading(input);
    const without = reading(input, { withEffort: false });
    assert.deepEqual(withEffort.verdicts, without.verdicts, `${name}: the verdicts must not move with the effort`);
    assert.deepEqual(withEffort.verdicts.filter((v) => v.tripped === true).map((v) => v.id), tripped, name);
    assert.ok(without.measured.every((m) => m.effort === "unknown"), "positive control: with the effort taken off the rows really are unknown");
    assert.ok(withEffort.measured.some((m) => m.effort === "low") && withEffort.measured.some((m) => m.effort === "high"));
  }
});

// --- the store keeps it on the turn ------------------------------------------------------------------------------------

const wake = (timestamp: string) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: "\n\n<pasted_content id=\"1\">\nYou are `worker-9001` -- row 9001 has been claimed for you.\n</pasted_content>" } });
const assistant = (timestamp: string, id: string, extra: Record<string, unknown>) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`, ...extra,
  message: { id, model: HAIKU_MODEL_ID, role: "assistant", content: [{ type: "text", text: "x" }], usage: { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
});

test("a transcript turn keeps the effort Claude Code wrote on its record: perTurnEffort first, effort second, and a record that names none leaves the turn without one", () => {
  const text = [
    wake("2026-10-10T10:00:00.000Z"),
    assistant("2026-10-10T10:00:04.000Z", "msg_both", { effort: "high", perTurnEffort: "low" }),
    assistant("2026-10-10T10:00:08.000Z", "msg_session", { effort: "medium" }),
    assistant("2026-10-10T10:00:12.000Z", "msg_none", {}),
  ].join("\n");
  const { events } = eventsOfTranscript({ text, file: "w.jsonl", ledger: [], rowRepo: "a11ign/a11ign" });
  const turn = (id: string) => events.find((event) => event.id === `turn:${id}`) as TraceEvent;
  assert.equal(turn("msg_both").effort, "low", "the turn's own effort, not the session's");
  assert.equal(turn("msg_session").effort, "medium");
  assert.ok(!("effort" in turn("msg_none")), "negative control: no effort named is no `effort` key, not `low` and not null");
  assert.equal(effortOfTurns(events.filter((event) => event.kind === "turn")), "mixed");
});
