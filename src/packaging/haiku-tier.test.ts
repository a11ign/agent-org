/**
 * `packages/agent-org/src/worker-profile.ts`'s Haiku tier and `trace/haiku-tier-report.ts` (a11ign/a11ign#4382, the chairman's spend trial).
 *
 * EVERY CLAIM HERE HAS A POSITIVE AND A NEGATIVE CONTROL: a `tier:haiku` row that gets the profile beside the same row that does not, a switch that
 * is on beside the three ways it is off, and a stop rule that trips on a fixture built to trip EXACTLY ONE condition beside the baseline that trips none.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { haikuTierProfile, readHaikuSwitch, agentArgs, AUTO_COMPACT_TRIGGER_MARGIN_TOKENS, HAIKU_AUTOCOMPACT_WINDOW_TOKENS,
  HAIKU_PROMPT_CEILING_TOKENS, HAIKU_MODEL_ID, DECLARED_CLAUDE_MODELS, profileFor, HAIKU_TIER_SWITCH_PATH, AUTOCOMPACT_WINDOW_TOKENS, type TierProfile } from "../worker-profile.ts";
import { spawnInvocation, spawnClaimer } from "../wake.ts";
import { repriceEvents, type TraceEvent } from "../trace/store.ts";
import { measuresOf, reportLines, stopRule, summarise, firstHaikuStart, median, MIN_RATE_ROWS, type RowMeasures } from "../trace/haiku-tier-report.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "haiku-tier-"));
after(() => { rmSync(SCRATCH, { recursive: true, force: true }); });
const BODY = "## Region\n\n```\nsrc/a.ts\n```\n\n## Acceptance\n\n```bash\npnpm test\n```\n";
const ROW = { number: 4999, labels: ["ready", "tier:haiku"], body: BODY };

function switchFile(name: string, content: string | null): string {
  const path = join(SCRATCH, name);
  if (content !== null) writeFileSync(path, content);
  return path;
}
const ON = switchFile("on.json", '{ "enabled": true }');

function tiered(row = ROW, switchPath = ON): { profile: TierProfile | null; logs: string[] } {
  const logs: string[] = [];
  return { profile: haikuTierProfile(row, { switchPath, log: (line) => logs.push(line) }), logs };
}

test("the shipped switch is ON, and a tier:haiku row gets a claude-haiku-5-5 launch whose autocompact trigger is inside the prompt ceiling", () => {
  assert.deepEqual(readHaikuSwitch(HAIKU_TIER_SWITCH_PATH), { enabled: true });
  const { profile, logs } = tiered();
  assert.ok(profile, "a clean tier:haiku row must get the Haiku profile");
  assert.deepEqual(logs, []);
  const args = agentArgs(profile);
  assert.equal(args[args.indexOf("--model") + 1], HAIKU_MODEL_ID);
  const window = Number(args[args.indexOf("--autocompact") + 1]);
  assert.equal(window, HAIKU_AUTOCOMPACT_WINDOW_TOKENS);
  assert.ok(window - AUTO_COMPACT_TRIGGER_MARGIN_TOKENS <= HAIKU_PROMPT_CEILING_TOKENS, `trigger ${window - AUTO_COMPACT_TRIGGER_MARGIN_TOKENS} is past the ceiling`);
  const ordinary = profileFor("ready-row-unclaimed");
  assert.ok(!("refusal" in ordinary));
  assert.equal(args[args.indexOf("--effort") + 1], ordinary.effort, "a Haiku worker runs at the ordinary worker's effort");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.notEqual(args[args.indexOf("--effort") + 1], "low", "negative control: the assumed floor is not what it starts at");
});

test("a Haiku launch and an ordinary launch for the same cause carry the SAME --effort value, so changing one moves the other or fails", () => {
  const effortOf = (args: string[]) => args[args.indexOf("--effort") + 1];
  const ordinary = spawnInvocation({ cause: "ready-row-unclaimed" }, "worker-1", "p1");
  const haiku = spawnInvocation({ cause: "ready-row-unclaimed" }, "worker-1", "p1", {}, tiered().profile);
  assert.ok(!("refusal" in ordinary) && !("refusal" in haiku));
  assert.equal(effortOf(haiku.args), effortOf(ordinary.args));
  assert.equal(effortOf(haiku.args), DECLARED_CLAUDE_MODELS.sonnet.effortLevel);
  assert.equal(HAIKU_MODEL_ID, "claude-haiku-5-5");
});

test("the same row WITHOUT the label carries the ordinary Sonnet profile byte for byte, and says nothing", () => {
  const { profile, logs } = tiered({ ...ROW, labels: ["ready"] });
  assert.equal(profile, null);
  assert.deepEqual(logs, [], "an unlabelled row is the common case and must not log");
  const ordinary = spawnInvocation({ cause: "ready-row-unclaimed" }, "worker-1", "p1");
  assert.ok(!("refusal" in ordinary));
  assert.deepEqual(spawnInvocation({ cause: "ready-row-unclaimed" }, "worker-1", "p1", {}, null), ordinary);
  assert.ok(ordinary.args.includes(String(AUTOCOMPACT_WINDOW_TOKENS)));
  assert.ok(!ordinary.args.includes(HAIKU_MODEL_ID));
  const haiku = spawnInvocation({ cause: "ready-row-unclaimed" }, "worker-1", "p1", {}, tiered().profile);
  assert.ok(!("refusal" in haiku));
  assert.ok(haiku.args.includes(HAIKU_MODEL_ID) && !haiku.args.includes(String(AUTOCOMPACT_WINDOW_TOKENS)));
});

test("enabled:false, a missing file and a malformed file each give the ordinary profile and log a reason", () => {
  const off = tiered(ROW, switchFile("off.json", '{ "enabled": false }'));
  const missing = tiered(ROW, switchFile("absent.json", null));
  const malformed = tiered(ROW, switchFile("bad.json", "{ enabled: "));
  const untyped = tiered(ROW, switchFile("untyped.json", '{ "enabled": "yes" }'));
  for (const [name, got] of Object.entries({ off, missing, malformed, untyped })) {
    assert.equal(got.profile, null, `${name} must fail safe to the ordinary profile`);
    assert.equal(got.logs.length, 1, `${name} must log exactly one reason`);
    assert.match(got.logs[0], /#4999 is tier:haiku but gets the ordinary profile/);
  }
  assert.match(off.logs[0], /switch is off/);
  assert.match(missing.logs[0], /missing or unreadable/);
  assert.match(malformed.logs[0], /not valid JSON/);
  assert.match(untyped.logs[0], /no boolean "enabled"/);
});

test("a tier label never lowers what a row may touch: lane:ceo, needs:chairman, .github/workflows/ and no Acceptance each get the ordinary profile", () => {
  const refused = {
    "lane:ceo": { ...ROW, labels: [...ROW.labels, "lane:ceo"] },
    "needs:chairman": { ...ROW, labels: [...ROW.labels, "needs:chairman"] },
    workflows: { ...ROW, body: BODY.replace("src/a.ts", ".github/workflows/ci.yml") },
    "no acceptance": { ...ROW, body: "## Region\n\n```\nsrc/a.ts\n```\n" },
    "acceptance none": { ...ROW, body: BODY.replace(/## Acceptance[\s\S]*$/, "Acceptance: none -- a docs row\n") },
  };
  for (const [name, row] of Object.entries(refused)) {
    const got = tiered(row);
    assert.equal(got.profile, null, `${name} must not get the Haiku profile`);
    assert.equal(got.logs.length, 1, `${name} must log its reason`);
  }
  assert.match(tiered(refused["lane:ceo"]).logs[0], /lane:ceo/);
  assert.match(tiered(refused["needs:chairman"]).logs[0], /needs:chairman/);
  assert.match(tiered(refused.workflows).logs[0], /\.github\/workflows\//);
  assert.match(tiered(refused["no acceptance"]).logs[0], /no Acceptance/);
  assert.ok(tiered().profile, "positive control: the row without any of them gets the profile");
});

test("the claimer's tier reads the claimed row; a row it cannot read gets the ordinary profile", () => {
  const claimed = { row: 4999, branch: "b", worktree: "w", launchDir: "l" };
  const labelled = spawnClaimer({ readRow: () => ({ labels: ROW.labels, body: BODY }), switchPath: ON });
  assert.equal(labelled.tier?.(claimed)?.model, HAIKU_MODEL_ID);
  const plain = spawnClaimer({ readRow: () => ({ labels: ["ready"], body: BODY }), switchPath: ON });
  assert.equal(plain.tier?.(claimed), null);
  const unreadable = spawnClaimer({ readRow: () => { throw new Error("gh: HTTP 502"); }, switchPath: ON });
  assert.equal(unreadable.tier?.(claimed), null);
});

// --- the report --------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 10);
const REPO = "a11ign/agent-org";

type Fixture = { number: number; haiku: boolean; closedAt: number; rejections?: number; compactions?: number; bulk?: boolean; oversize?: boolean; merged?: boolean };

/** One closed row and the store events it leaves: its turns (priced by model), compactions, and its pull request's reviews and merge. */
function events(row: Fixture) {
  const model = row.haiku ? HAIKU_MODEL_ID : "claude-sonnet-5-5";
  const turn = (i: number, tokens = { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }) =>
    ({ id: `t${row.number}-${i}`, kind: "turn", source: "transcript", at: T0 + row.number + i, session: `worker-${row.number}`, row: row.number, pr: null, repo: null, model, tokens });
  const big = (input: number) => turn(2, { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  // `bulk` is a turn as large as a Haiku prompt may be (priced by the model, so it is dear on Sonnet and still cheap on Haiku); `oversize` is one a token past the ceiling.
  const turns = [turn(0), turn(1), ...(row.oversize ? [big(HAIKU_PROMPT_CEILING_TOKENS + 1)] : []), ...(row.bulk ? [big(HAIKU_PROMPT_CEILING_TOKENS - 1000)] : [])];
  const compactions = Array.from({ length: row.compactions ?? 0 }, (_, i) => ({ id: `c${row.number}-${i}`, kind: "compaction", source: "transcript", at: T0 + i, session: `worker-${row.number}`, row: row.number, pr: null, repo: null }));
  const github = (kind: string, key: string, extra = {}) => ({ id: `gh:${REPO}#${row.number}:${kind}:${key}`, kind, source: "github", at: T0, session: "github", row: null, pr: row.number, repo: null, ...extra });
  const reviews = Array.from({ length: row.rejections ?? 0 }, (_, i) => github("reviewed", String(i), { state: "CHANGES_REQUESTED" }));
  return [...turns, ...compactions, ...reviews, ...(row.merged === false ? [] : [github("merged", "m")])];
}

const closedRow = (row: Fixture) => ({ number: row.number, haiku: row.haiku, closedAt: row.closedAt, pr: { repo: REPO, number: row.number } });

/** `count` rows of one tier, closed an hour apart from T0, taking `tweak` to differ from the baseline. */
function rows(haiku: boolean, count: number, tweak: (i: number) => Partial<Fixture> = () => ({})): Fixture[] {
  return Array.from({ length: count }, (_, i) => ({ number: (haiku ? 1000 : 2000) + i, haiku, closedAt: T0 + (i + 1) * HOUR, ...tweak(i) }));
}

function verdictsOf(all: Fixture[], now = T0 + 100 * HOUR) {
  const evts = repriceEvents(all.flatMap(events) as unknown as TraceEvent[]);
  const lines = reportLines({ closed: all.map(closedRow), events: evts, now });
  const measured = all.map((row) => measuresOf(closedRow(row), evts));
  const haiku: RowMeasures[] = measured.filter((m) => m.haiku);
  const other: RowMeasures[] = measured.filter((m) => !m.haiku);
  const verdicts = stopRule({ haiku, other, closedInWindow: haiku.length, started: firstHaikuStart(all.filter((r) => r.haiku).map(closedRow), evts), now });
  return { lines, tripped: verdicts.filter((v) => v.tripped === true).map((v) => v.id), unreadable: verdicts.filter((v) => v.tripped === null).map((v) => v.id) };
}

const BASELINE = [...rows(true, MIN_RATE_ROWS), ...rows(false, MIN_RATE_ROWS)];

test("the baseline fixture (eight rows a side, nothing wrong) trips no condition and reads every one", () => {
  const got = verdictsOf(BASELINE);
  assert.deepEqual(got.tripped, []);
  assert.deepEqual(got.unreadable, []);
  assert.equal(median([3, 1, 2]), 2);
  assert.ok(got.lines.some((line) => /first-pass merge: 100% \(n=8\)/.test(line)));
});

test("each of (a) to (e) is tripped by a fixture that trips exactly that one", () => {
  const tweakHaiku = (tweak: (i: number) => Partial<Fixture>) => [...rows(true, MIN_RATE_ROWS, tweak), ...rows(false, MIN_RATE_ROWS)];
  // (a) 4 of 8 Haiku rows need a rework: 50% against 100% is 50 points; one rejection each keeps (b) at 0.5, which is not above 0.5.
  assert.deepEqual(verdictsOf(tweakHaiku((i) => ({ rejections: i < 4 ? 1 : 0 }))).tripped, ["a"]);
  // (b) every Haiku row is rejected once and the others never: 1.0 above the others' 0, with the rate fixture below the minimum so (a) cannot decide.
  const fewHaiku = [...rows(true, 4, () => ({ rejections: 1 })), ...rows(false, 4)];
  assert.deepEqual(verdictsOf(fewHaiku).tripped, ["b"]);
  // (c) one Haiku worker compacting 11 times; and separately one turn recorded above the prompt ceiling.
  assert.deepEqual(verdictsOf(tweakHaiku((i) => ({ compactions: i === 0 ? 11 : 0 }))).tripped, ["c"]);
  assert.deepEqual(verdictsOf(tweakHaiku((i) => ({ oversize: i === 0 }))).tripped, ["c"]);
  // (d) no saving: every Haiku row spends a prompt-ceiling turn the Sonnet rows do not, so its cost is not 40% below.
  assert.deepEqual(verdictsOf(tweakHaiku(() => ({ bulk: true }))).tripped, ["d"]);
  // (e) three Haiku rows closed, and the 72 hours have run.
  const few = [...rows(true, 3), ...rows(false, MIN_RATE_ROWS)];
  assert.deepEqual(verdictsOf(few).tripped, ["e"]);
});

test("controls on the controls: ten compactions is not past the line, and (e) waits for the window", () => {
  const ten = [...rows(true, MIN_RATE_ROWS, (i) => ({ compactions: i === 0 ? 10 : 0 })), ...rows(false, MIN_RATE_ROWS)];
  assert.deepEqual(verdictsOf(ten).tripped, []);
  const few = [...rows(true, 3), ...rows(false, MIN_RATE_ROWS)];
  const early = verdictsOf(few, T0 + 10 * HOUR);
  assert.deepEqual(early.tripped, [], "inside the 72 hours (e) decides nothing");
  assert.ok(early.unreadable.includes("e"));
});

test("a rate over fewer than eight rows says n=<k>, not a rate, and decides nothing", () => {
  const small = [...rows(true, 3), ...rows(false, 3)];
  const got = verdictsOf(small);
  assert.ok(got.lines.some((line) => /first-pass merge: n=3, not a rate/.test(line)), got.lines.join("\n"));
  assert.ok(got.unreadable.includes("a"));
  assert.ok(!got.tripped.includes("a"));
  const summary = summarise([]);
  assert.equal(summary.firstPassRate, null);
});

test("the report separates the tiers: Haiku rows in one block, the rest closed in the same window in another, and rows closed before the first worker are left out", () => {
  const before = { number: 3000, haiku: false, closedAt: T0 - HOUR };
  const lines = verdictsOf([...BASELINE, before]).lines;
  const otherBlock = lines.slice(lines.indexOf("other rows closed in the same window:"));
  assert.match(lines.join("\n"), /tier:haiku rows:\n {2}n=8 closed/);
  assert.match(otherBlock[1], /n=8 closed/, "the row closed before the window must not count");
  assert.equal(firstHaikuStart([], []), null);
});
