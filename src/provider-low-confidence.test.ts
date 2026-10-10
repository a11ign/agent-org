// #4750: a question under the floor on MORE than 30% of at least 20 decisions files its own improvement row, once, and a host with no provider files and asks nothing.
// no-token: gh -- every `gh` call in this file is an injected fake tracker and every `row-file` call an injected fake filer; the CLI cases read a temporary log and never reach `gh`.
//
// THE FAKES ARE STRICT: the tracker answers only the two calls this module makes and throws on any other, and the filer RECORDS its argv. Every "files nothing" case has a twin that DOES file over
// the same facts with ONE thing changed, so a filer that never files turns the twin red and one that always files turns the case red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { confidenceReading, type ConfidenceReading } from "./provider-confidence.ts";
import {
  CLASS_ID, MIN_DECISIONS, MIN_UNDER_FLOOR_SHARE, fileLowConfidence, improvementArgv, improvementBody, improvementTitle, lowConfidenceQuestions, questionVerdict, regionFiles,
  windowText, type FilingIo,
} from "./provider-low-confidence.ts";
import { bodyFromArgv, fileRefusalReason } from "./row-file.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-10T08:00:00Z");
const REPO = "a11ign/a11ign";
const SCRIPT = new URL("./provider-low-confidence.ts", import.meta.url).pathname;

type Line = Record<string, unknown>;
const given: Line = { value: "no", confidence: 0.9, fellBack: false };
const under = (confidence = 0.5): Line => ({ value: "no", confidence, fellBack: true, asked: "yes", reason: `yes at ${confidence}, under the floor 0.7` });
const refused: Line = { value: "no", fellBack: true, reason: "the API answered HTTP 422" };
const line = (use: string, question: string, answer: Line, at = NOW - HOUR): Line =>
  ({ use, id: "row-1", fields: ["title"], questions: [question], answers: { [question]: answer }, via: "jev", fellBack: answer.fellBack, at });

/** `total` decisions of one question, `held` of them held back by the floor and `refusals` of them refused; the rest are answered at the floor or over it. */
function decisions(use: string, question: string, { total, held, refusals = 0 }: { total: number; held: number; refusals?: number }): Line[] {
  return Array.from({ length: total }, (_, i) => line(use, question, i < held ? under() : i < held + refusals ? refused : given));
}
const readingOf = (lines: Line[], windowMs = DAY): ConfidenceReading => confidenceReading(lines, { now: NOW, windowMs });
const keysOf = (reading: ConfidenceReading): string[] => lowConfidenceQuestions(reading).map((row) => `${row.use}/${row.question}`);

// ---- THE EDGES ----

test("the constants are the row's: 20 decisions and MORE than 30%", () => {
  assert.equal(MIN_DECISIONS, 20);
  assert.equal(MIN_UNDER_FLOOR_SHARE, 0.3);
  assert.equal(CLASS_ID, "provider-low-confidence");
});

test("19 decisions at 100% under the floor is not a question worth a row, and its 20-decision twin is", () => {
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 19, held: 19 }))), []);
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 20, held: 20 }))), ["model-routing/score"]);
});

test("20 decisions at EXACTLY 30% is not, and 20 at 35% is: the share is exclusive", () => {
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 20, held: 6 }))), []);
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 20, held: 7 }))), ["model-routing/score"]);
});

test("the edges move with the options a caller names, so they are the two numbers and not two copies of them", () => {
  const reading = readingOf(decisions("model-routing", "score", { total: 10, held: 6 }));
  assert.deepEqual(lowConfidenceQuestions(reading), []);
  assert.equal(lowConfidenceQuestions(reading, { minDecisions: 10 }).length, 1);
  assert.deepEqual(lowConfidenceQuestions(reading, { minDecisions: 10, share: 0.6 }), []);
});

test("a refusal, a 422 or a timeout is not low confidence: 20 decisions with 10 refused and none under the floor files nothing, and the same 10 under the floor does", () => {
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 20, held: 0, refusals: 10 }))), []);
  assert.deepEqual(keysOf(readingOf(decisions("model-routing", "score", { total: 20, held: 10 }))), ["model-routing/score"]);
});

test("decisions older than the window are not counted: the same 20 are low inside it and nothing outside it", () => {
  const old = decisions("model-routing", "score", { total: 20, held: 20 }).map((l) => ({ ...l, at: NOW - 2 * DAY }));
  assert.deepEqual(keysOf(readingOf(old)), []);
  assert.deepEqual(keysOf(readingOf(old, 3 * DAY)), ["model-routing/score"]);
});

test("two questions of one use are two rows' worth, each judged on its own decisions", () => {
  const lines = [...decisions("model-routing", "score", { total: 20, held: 10 }), ...decisions("model-routing", "mechanical", { total: 20, held: 1 })];
  assert.deepEqual(keysOf(readingOf(lines)), ["model-routing/score"]);
});

// ---- FILING ----

const LOW = decisions("model-routing", "score", { total: 24, held: 10 });
const TWO_LOW = [...LOW, ...decisions("model-routing", "subsystems", { total: 22, held: 15 })];

type Tracked = { number: number; title: string; state: string; closedAt: string | null };

/** A tracker that answers the one listing this module makes and records `label create`; it throws on any other call, so a reader that drifts is red. */
function tracker(rows: Tracked[], { listFails = "" }: { listFails?: string } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "label") {
      assert.deepEqual(args.slice(0, 3), ["label", "create", `class:${CLASS_ID}`]);
      return "";
    }
    assert.deepEqual(args.slice(0, 2), ["issue", "list"], `an unexpected gh call: ${args.join(" ")}`);
    assert.equal(args[args.indexOf("--label") + 1], `class:${CLASS_ID}`);
    if (listFails) throw new Error(listFails);
    return JSON.stringify(rows);
  };
  return { run, calls };
}

function filer({ refuse = "", from = 5000 }: { refuse?: string; from?: number } = {}) {
  const argvs: string[][] = [];
  const fileRow = (argv: string[]) => {
    argvs.push(argv);
    if (refuse) throw Object.assign(new Error("Command failed: row-file\nsecond line"), { stderr: `\n${refuse}\nsecond line\n` });
    return `warning: a line before the url\nhttps://github.com/${REPO}/issues/${from + argvs.length - 1}\n`;
  };
  return { fileRow, argvs };
}

const ON = new Set(["model-routing"]);
const io = (tracked: ReturnType<typeof tracker>, fileRow: ReturnType<typeof filer>, uses: ReadonlySet<string> = ON, extra: Partial<FilingIo> = {}): FilingIo =>
  ({ uses, run: tracked.run, repo: REPO, fileRow: fileRow.fileRow, ...extra });
const openRow = (question: string, number = 4800): Tracked =>
  ({ number, title: improvementTitle({ use: "model-routing", question }), state: "OPEN", closedAt: null });
const closedRow = (question: string, closedAt: number, number = 4700): Tracked =>
  ({ number, title: improvementTitle({ use: "model-routing", question }), state: "CLOSED", closedAt: new Date(closedAt).toISOString() });

test("ONE row is filed for a low question, and it names the question, its share, its mean and median, the window and the method", () => {
  const t = tracker([]);
  const f = filer();
  const outcomes = fileLowConfidence(readingOf(LOW), io(t, f));
  assert.deepEqual(outcomes, { "model-routing/score": { filed: "#5000" } });
  assert.equal(f.argvs.length, 1);
  const body = bodyFromArgv(f.argvs[0]) as string;
  assert.match(body, /model-routing\/score/);
  assert.match(body, /10 of 24 decisions \(42%\)/);
  assert.match(body, /mean confidence of 0\.7\d and a median of 0\.9/);
  assert.match(body, /2026-10-09T08:00:00\.000Z and 2026-10-10T08:00:00\.000Z/);
  for (const part of ["`what`, `not_for` and `examples`", "`levels`", "closed rows", "MAX_STATE_BYTES", "`confidence` page"]) assert.ok(body.includes(part), `the method names ${part}`);
  assert.ok(f.argvs[0].includes(`class:${CLASS_ID}`), "carries the class label");
  assert.ok(!f.argvs[0].includes("--kind"), "an improvement is not a defect, so it owes no Class: line");
});

test("two low questions file two rows, and a question that is not low files none", () => {
  const f = filer();
  const outcomes = fileLowConfidence(readingOf([...TWO_LOW, ...decisions("model-routing", "mechanical", { total: 30, held: 1 })]), io(tracker([]), f));
  assert.deepEqual(Object.keys(outcomes).sort(), ["model-routing/score", "model-routing/subsystems"]);
  assert.deepEqual(f.argvs.map((argv) => argv[argv.indexOf("--title") + 1]).sort(), [improvementTitle({ use: "model-routing", question: "score" }), improvementTitle({ use: "model-routing", question: "subsystems" })]);
});

test("NO SECOND ROW while one is open: the open row's question is skipped and its neighbour is still filed", () => {
  const f = filer();
  const outcomes = fileLowConfidence(readingOf(TWO_LOW), io(tracker([openRow("score")]), f));
  assert.deepEqual(outcomes["model-routing/score"], { skipped: "#4800 is open for it" });
  assert.deepEqual(outcomes["model-routing/subsystems"], { filed: "#5000" });
  assert.equal(f.argvs.length, 1);
  // The twin: the same question with no open row IS filed, so "skipped" is the open row's doing and not a filer that files nothing.
  assert.deepEqual(fileLowConfidence(readingOf(LOW), io(tracker([]), filer())), { "model-routing/score": { filed: "#5000" } });
});

test("a row open for ANOTHER question, or a closed one from before the window, does not hold this question back", () => {
  const f = filer();
  const rows = [openRow("subsystems"), closedRow("score", NOW - 3 * DAY)];
  assert.deepEqual(fileLowConfidence(readingOf(LOW), io(tracker(rows), f)), { "model-routing/score": { filed: "#5000" } });
});

test("a row that CLOSED inside the window holds the question back, because the window still holds the decisions that made it low", () => {
  const f = filer();
  const outcomes = fileLowConfidence(readingOf(LOW), io(tracker([closedRow("score", NOW - 2 * HOUR)]), f));
  assert.match((outcomes["model-routing/score"] as { skipped: string }).skipped, /#4700 closed inside the window/);
  assert.equal(f.argvs.length, 0);
});

test("a tracker that cannot be read files nothing: not seeing an open row is not seeing none", () => {
  const f = filer();
  const outcomes = fileLowConfidence(readingOf(LOW), io(tracker([], { listFails: "HTTP 502" }), f));
  assert.match((outcomes["model-routing/score"] as { refused: string }).refused, /no open row could be ruled out: HTTP 502/);
  assert.equal(f.argvs.length, 0);
});

test("a listing that filled its limit is refused, never read as the whole", () => {
  const many = Array.from({ length: 200 }, (_, i) => openRow(`other-${i}`, 100 + i));
  const f = filer();
  const outcomes = fileLowConfidence(readingOf(LOW), io(tracker(many), f));
  assert.match((outcomes["model-routing/score"] as { refused: string }).refused, /limit/);
  assert.equal(f.argvs.length, 0);
});

test("a refusal by row-file is that question's `refused`, its first non-empty stderr line, and the next run tries again", () => {
  const f = filer({ refuse: "row-file: REFUSING to file -- a title an open row already has" });
  const outcomes = fileLowConfidence(readingOf(LOW), io(tracker([]), f));
  assert.deepEqual(outcomes, { "model-routing/score": { refused: "row-file: REFUSING to file -- a title an open row already has" } });
});

test("NO PROVIDER, NO FILING, NO NOISE: with no use switched on, nothing is filed and gh is not asked anything", () => {
  const t = tracker([]);
  const f = filer();
  assert.deepEqual(fileLowConfidence(readingOf(TWO_LOW), io(t, f, new Set())), {});
  assert.equal(t.calls.length, 0, "gh was not touched");
  assert.equal(f.argvs.length, 0);
  // The twin: the same reading with the use on files, so the empty set is what silenced it.
  assert.equal(Object.keys(fileLowConfidence(readingOf(TWO_LOW), io(tracker([]), filer()))).length, 2);
});

test("a use that is switched off is not filed even when another is on, and an empty reading asks gh nothing", () => {
  const t = tracker([]);
  const f = filer();
  const lines = [...decisions("wake-triage", "route", { total: 30, held: 20 }), ...decisions("model-routing", "score", { total: 30, held: 2 })];
  assert.deepEqual(fileLowConfidence(readingOf(lines), io(t, f)), {});
  assert.equal(t.calls.length, 0, "no candidate of an on use, so the tracker is not read");
  assert.deepEqual(Object.keys(fileLowConfidence(readingOf(lines), io(tracker([]), filer(), new Set(["wake-triage"])))), ["wake-triage/route"]);
  assert.deepEqual(fileLowConfidence(readingOf([]), io(t, f)), {});
});

// ---- THE ROW'S OWN SHAPE ----

test("the Region names files that exist, keyed because they are in another repository, for every use the provider has", () => {
  const root = new URL("../", import.meta.url).pathname;
  for (const use of ["model-routing", "wake-triage", "ci-failure-class", "failure-class-match", "duplicate-row", "review-depth"]) {
    const files = regionFiles(use);
    assert.ok(files.length >= 4, `${use} names its module, its test and the adapter's`);
    for (const file of files) assert.ok(existsSync(join(root, file)), `${use}: ${file} is not in this repository`);
  }
  assert.deepEqual(regionFiles("some-future-use"), ["src/decision-provider.ts", "src/decision-provider.test.ts"]);
});

test("the body and argv pass row-file's OWN validators, so the filer is not refused for its shape", () => {
  const reading = readingOf(LOW);
  const [row] = lowConfidenceQuestions(reading);
  const argv = improvementArgv(row, reading);
  const project = tmpDirForFile("provider-low-confidence-cwd-");
  mkdirSync(join(project, ".agent-org"));
  const before = process.cwd();
  try {
    process.chdir(project);
    assert.equal(fileRefusalReason(bodyFromArgv(argv)), null, "the body names a Region, an Acceptance and an Open-check that row-file accepts");
  } finally {
    process.chdir(before);
  }
});

test("the Open-check is pasted from the formatter, the Acceptance names the question's own tests, and the done-when check is the --question command", () => {
  const reading = readingOf(LOW);
  const [row] = lowConfidenceQuestions(reading);
  const body = improvementBody(row, reading);
  assert.match(body, /\$ node src\/provider-confidence\.ts --since 1d\nProvider confidence, /);
  assert.match(body, /pnpm exec rstest run --config scripts\/rstest\/rstest\.config\.\* src\/engineer-route\.test\.ts src\/decision-provider\.test\.ts/);
  assert.doesNotMatch(body, /\bnpx\b|\bnpm (run|ci|install|test|exec)/, "the tool's remedies say pnpm (remedies-say-pnpm.test.ts)");
  assert.match(body, /node src\/provider-low-confidence\.ts --question=model-routing\/score` run with `--since` set to a window that starts AFTER that release/);
});

test("the window is spelled the way `--since` reads it back", () => {
  const spans = [HOUR, 6 * HOUR, DAY, 7 * DAY].map((windowMs) => windowText(readingOf([], windowMs)));
  assert.deepEqual(spans, ["1h", "6h", "1d", "7d"]);
});

// ---- THE CHECK AND THE COMMAND ----

test("a question is settled only with at least 20 decisions at or under 30%: too few is not settled, and not asked is not settled", () => {
  const verdict = (total: number, held: number) => questionVerdict(readingOf(decisions("model-routing", "score", { total, held })), "model-routing/score").verdict;
  assert.equal(verdict(20, 6), "settled");
  assert.equal(verdict(20, 7), "still-low");
  assert.equal(verdict(19, 0), "too-few");
  assert.equal(questionVerdict(readingOf([]), "model-routing/score").verdict, "not-asked");
});

function cli(args: string[], env: Record<string, string> = {}) {
  const { AGENT_ORG_HOST: _host, ...rest } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...rest, ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test("the command's --question exits 0 when settled, 1 when still low and 2 when it cannot say; and with no provider the plan files nothing and says why", () => {
  const dir = tmpDirForFile("provider-low-confidence-cli-");
  const log = join(dir, "decisions");
  const at = Date.now() - HOUR;
  const lines = [...decisions("model-routing", "score", { total: 24, held: 10 }), ...decisions("model-routing", "mechanical", { total: 24, held: 1 }), ...decisions("model-routing", "few", { total: 5, held: 5 })]
    .map((l) => JSON.stringify({ ...l, at }));
  writeFileSync(log, `${lines.join("\n")}\n`);
  const check = (key: string) => cli([`--question=${key}`, "--since=1d", `--log=${log}`]);
  assert.equal(check("model-routing/mechanical").status, 0);
  assert.match(check("model-routing/mechanical").out, /settled: 1 of 24/);
  assert.equal(check("model-routing/score").status, 1);
  assert.equal(check("model-routing/few").status, 2);
  assert.equal(check("model-routing/never-asked").status, 2);
  const plan = cli(["--since=1d", `--log=${log}`]);
  assert.equal(plan.status, 0);
  assert.match(plan.out, /No decision provider is declared, or no use is switched on: nothing is asked and nothing is filed\./);
  assert.equal(cli(["--bogus"]).status !== 0, true, "an unknown flag is refused");
});
