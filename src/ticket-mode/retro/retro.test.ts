import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import type { ExecResult } from "../../plugins/manifest.ts";
import { appendOutcome, outcomeRecordOf, type OutcomeRecord, outcomesPath } from "../outcomes/outcome-record.ts";
import type { RunEvent } from "../queue/run-log.ts";
import { retroEvidence } from "./evidence.ts";
import { type Lesson, LESSON_TTL_MS, LESSONS_MAX, lessonsDir, lessonsPath, mergeLessons, readLessons, writeLessons } from "./lessons-store.ts";
import { proposalsOf } from "./retro-prompt.ts";
import { askClaude, claudeArgs, RETRO_ENV, type RetroDeps, retroStatePath, retroSweep } from "./retro-job.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 6);

/** Run `n` of ticket `A11-<n>`, started `daysAgo` days back in `repos`, with one hour-long round that opened a pull request. */
function runOf(n: number, daysAgo: number, repos: readonly string[] = ["agent-org"]): OutcomeRecord {
  const since = NOW - daysAgo * DAY;
  return outcomeRecordOf({ ticket: `A11-${n}`, model: "sonnet", effort: "high", repos, labels: [], prs: [] }, { since, rounds: [{ startedAt: since, endedAt: since + 60 * 60_000, outcome: "ready-pr", tokens: {} }] });
}

/** A round the reviewer's feedback started, `minutesIn` after run `run` began, with `reason`. */
const feedback = (run: OutcomeRecord, reason: string, minutesIn = 10): RunEvent => ({ kind: "round", cause: "feedback", reason, at: run.rounds[0]!.startedAt! + minutesIn * 60_000 });

/** The headless run's JSON result answering `reply`. */
const answered = (reply: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: typeof reply === "string" ? reply : JSON.stringify(reply) }), stderr: "" });

type Board = { deps: RetroDeps; prompts: string[]; said: string[]; dir: string; at: { now: number } };

/** A state directory holding `records` in its outcome log, and the retro's deps over `runLog`, asking a model that answers `reply` to every prompt. */
function boardWith({ records = [], runLog = {}, reply = { lessons: [] }, on = true }: { records?: OutcomeRecord[]; runLog?: Record<string, RunEvent[]>; reply?: unknown | ((prompt: string) => ExecResult); on?: boolean }): Board {
  const dir = tmpDir("retro-");
  for (const record of records) appendOutcome(outcomesPath(dir), record);
  const prompts: string[] = [];
  const said: string[] = [];
  const at = { now: NOW };
  const deps: RetroDeps = {
    on: () => on, stateDir: dir, runLog: () => runLog, now: () => at.now, log: (line) => { said.push(line); },
    ask: async (prompt) => { prompts.push(prompt); return typeof reply === "function" ? (reply as (p: string) => ExecResult)(prompt) : answered(reply); },
  };
  return { deps, prompts, said, dir, at };
}

const lesson = (id: string, text: string, confirmedDaysAgo: number, runs: readonly string[] = ["A11-90@1"]): Lesson => ({ id, text, runs, since: NOW - 40 * DAY, confirmedAt: NOW - confirmedDaysAgo * DAY });

test("A11-432: a week of agent-org runs in which three reviews flagged a missing changeset gives one lesson about changesets that names those three runs, and at most 15 lessons", async () => {
  const flagged = [runOf(1, 6), runOf(2, 4), runOf(3, 1)];
  const others = Array.from({ length: 20 }, (_, n) => runOf(10 + n, 2));
  const runLog = Object.fromEntries([
    ...flagged.map((run) => [run.ticket, [feedback(run, "Missing changeset: this changes a published package and adds no .changeset/*.md")]]),
    ...others.map((run) => [run.ticket, [feedback(run, `finding ${run.ticket}`)]]),
  ]);
  const changeset = { text: "Add a .changeset/*.md file to every change to a published package.", runs: [...flagged.map((run) => run.run), "A11-404@1"] };
  const noise = others.map((run, n) => ({ text: `lesson ${n}`, runs: [run.run, others[(n + 1) % others.length]!.run] }));
  const b = boardWith({ records: [...flagged, ...others], runLog, reply: { lessons: [changeset, ...noise] } });

  await retroSweep(b.deps)();

  assert.equal(b.prompts.length, 1, "one model run for the one repository with something to read");
  for (const run of flagged) assert.match(b.prompts[0]!, new RegExp(`\\[${run.run}\\] \\(round:feedback\\) Missing changeset`), "the prompt shows each flagged run's finding beside its run");
  const lessons = readLessons(b.dir, "agent-org");
  assert.equal(lessons.length, LESSONS_MAX, "21 proposals, 15 kept");
  const aboutChangesets = lessons.filter((each) => /changeset/i.test(each.text));
  assert.equal(aboutChangesets.length, 1);
  assert.deepEqual(aboutChangesets[0]!.runs, flagged.map((run) => run.run), "it names the three runs, and not the run the model made up");
});

test("A11-432: a lesson nobody has re-confirmed for 30 days is gone after the daily retro, even with nothing to read; one confirmed 29 days ago stays", async () => {
  const b = boardWith({});
  writeLessons(b.dir, "agent-org", [lesson("old", "an old lesson", 30), lesson("recent", "a recent lesson", 29)]);
  await retroSweep(b.deps)();
  assert.deepEqual(readLessons(b.dir, "agent-org").map((each) => each.id), ["recent"]);
  assert.equal(b.prompts.length, 0, "nothing to read asks no model");
});

test("A11-432: a lesson found again keeps its text, which a person may have edited, gains the new runs and is confirmed now; one found in a single run is no lesson", () => {
  const existing = [lesson("L1", "Run the changeset check before you push.", 20, ["A11-1@1"])];
  const merged = mergeLessons(existing, [{ id: "L1", text: "reworded by the model", runs: ["A11-2@2", "A11-1@1"] }, { text: "a new one", runs: ["A11-5@5", "A11-6@6"] }], NOW, (n) => `new-${n}`);
  assert.deepEqual(merged.map(({ id, text, runs, confirmedAt }) => ({ id, text, runs, confirmedAt })), [
    { id: "L1", text: "Run the changeset check before you push.", runs: ["A11-1@1", "A11-2@2"], confirmedAt: NOW },
    { id: "new-0", text: "a new one", runs: ["A11-5@5", "A11-6@6"], confirmedAt: NOW },
  ]);
  const runs = new Set(["A11-1@1", "A11-2@2"]);
  assert.deepEqual(proposalsOf(JSON.stringify({ lessons: [{ text: "one run only", runs: ["A11-1@1"] }, { id: "L1", text: "", runs: ["A11-2@2"] }] }), runs, existing),
    [{ id: "L1", text: "", runs: ["A11-2@2"] }], "a new lesson needs two runs, a re-confirmation one");
  assert.deepEqual(proposalsOf("```json\n{\"lessons\": [{\"text\": \"fenced\", \"runs\": [\"A11-1@1\", \"A11-2@2\"]}]}\n```", runs, []), [{ text: "fenced", runs: ["A11-1@1", "A11-2@2"] }], "a fenced answer is read");
  assert.equal(proposalsOf("I could not find anything.", runs, []), null, "no JSON is no answer");
});

test("A11-432: with tickets.lessons off the retro asks nothing and writes nothing", async () => {
  const run = runOf(1, 1);
  const b = boardWith({ records: [run], runLog: { [run.ticket]: [feedback(run, "a finding")] }, on: false });
  await retroSweep(b.deps)();
  assert.equal(b.prompts.length, 0);
  assert.equal(existsSync(lessonsDir(b.dir)), false);
  assert.equal(existsSync(retroStatePath(b.dir)), false);
});

test("A11-432: the retro runs once a UTC day, and a day whose model run failed is not tried again until the next", async () => {
  const run = runOf(1, 1);
  const b = boardWith({ records: [run], runLog: { [run.ticket]: [feedback(run, "a finding")] }, reply: () => ({ status: 1, stdout: "", stderr: "You've hit your limit" }) });
  const sweep = retroSweep(b.deps);
  await sweep();
  await sweep();
  assert.equal(b.prompts.length, 1, "once today");
  assert.deepEqual(b.said, ["the retro of agent-org got no answer it could read (exit 1): You've hit your limit"]);
  b.at.now = NOW + DAY;
  await sweep();
  assert.equal(b.prompts.length, 2, "again tomorrow");
});

test("A11-432: an answer that cannot be read keeps the lessons as they were, and a lessons file that cannot be read is said and left as it is", async () => {
  const run = runOf(1, 1);
  const b = boardWith({ records: [run], runLog: { [run.ticket]: [feedback(run, "a finding")] }, reply: "no JSON here" });
  writeLessons(b.dir, "agent-org", [lesson("L1", "kept", 3)]);
  await retroSweep(b.deps)();
  assert.deepEqual(readLessons(b.dir, "agent-org").map((each) => each.text), ["kept"]);

  const broken = boardWith({});
  mkdirSync(lessonsDir(broken.dir), { recursive: true });
  writeFileSync(lessonsPath(broken.dir, "agent-org"), "{ half");
  await retroSweep(broken.deps)();
  assert.equal(readFileSync(lessonsPath(broken.dir, "agent-org"), "utf8"), "{ half", "not overwritten with no lessons");
  assert.match(broken.said[0] ?? "", /^the retro of agent-org failed: .*agent-org\.json is not JSON/);
});

test("A11-432: an event is the run's of its ticket that started last before it, in each of that run's repositories; older events, good ends and runs outside the window are not read", () => {
  const first = runOf(1, 6, ["agent-org"]);
  const second = runOf(1, 3, ["agent-org", "control"]);
  const gone = runOf(2, 20);
  const runLog: Record<string, RunEvent[]> = {
    "A11-1": [
      { kind: "needs-you", reason: "an old cause", at: NOW - 9 * DAY },
      feedback(first, "first run's finding"),
      { kind: "finished", outcome: "ready-pr", reason: "Opened the pull request", at: second.rounds[0]!.startedAt! + 1 },
      { kind: "cap", step: "planner", detail: null, at: second.rounds[0]!.startedAt! + 2 },
    ],
    "A11-2": [feedback(gone, "outside the window")],
  };
  const evidence = retroEvidence({ records: [first, second, gone], runLog, since: NOW - 7 * DAY });
  assert.deepEqual([...evidence.keys()].sort(), ["agent-org", "control"]);
  assert.deepEqual(evidence.get("agent-org")!.map(({ run, source }) => [run, source]), [[first.run, "round:feedback"], [second.run, "cap"]]);
  assert.deepEqual(evidence.get("control")!.map(({ run }) => run), [second.run]);
});

test("A11-432: the retro's model run reads its prompt on stdin, has no tools, no MCP server or connector, keeps no session and is bounded", async () => {
  const calls: unknown[] = [];
  await askClaude(async (file, args, options) => { calls.push({ file, args, options }); return answered({ lessons: [] }); }, "/state")("the prompt");
  assert.deepEqual(calls, [{ file: "claude", args: claudeArgs(), options: { timeoutMs: 15 * 60_000, cwd: "/state", input: "the prompt", env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } } }]);
  assert.deepEqual(claudeArgs(), ["-p", "--output-format", "json", "--model", "sonnet", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none", "--max-turns", "2", "--max-budget-usd", "2"]);
  assert.deepEqual(RETRO_ENV, { ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
});

test("A11-432: an event after a run's latest recorded round is not given to that run: a retry still in its first round waits for its own record", () => {
  const earlier = runOf(1, 5);
  const retryStart = NOW - 1 * DAY;
  const runLog: Record<string, RunEvent[]> = { "A11-1": [feedback(earlier, "the earlier run's finding"), { kind: "needs-you", reason: "the retry's own cause", at: retryStart + 60_000 }] };
  assert.deepEqual(retroEvidence({ records: [earlier], runLog, since: NOW - 7 * DAY }).get("agent-org")!.map(({ text }) => text), ["the earlier run's finding"]);
  const retry = outcomeRecordOf({ ticket: "A11-1", model: "sonnet", effort: "high", repos: ["agent-org"], labels: [], prs: [] }, { since: retryStart, rounds: [{ startedAt: retryStart, endedAt: retryStart + 120_000, outcome: "needs-human", tokens: {} }] });
  assert.deepEqual(retroEvidence({ records: [earlier, retry], runLog, since: NOW - 7 * DAY }).get("agent-org")!.map(({ run }) => run), [earlier.run, retry.run], "once the retry's round is recorded, its event is its own");
});

test("A11-432: a hand-back is read once, from its Needs-you event, and a cap is read when it is reached or decided, not while it waits or resumes", () => {
  const run = runOf(1, 1);
  const at = (minutes: number): number => run.rounds[0]!.startedAt! + minutes * 60_000;
  const runLog: Record<string, RunEvent[]> = { "A11-1": [
    { kind: "finished", outcome: "needs-human", reason: "the plan contradicts a decision", at: at(1) }, { kind: "needs-you", reason: "the plan contradicts a decision", at: at(1) },
    { kind: "cap", step: "planner", detail: null, at: at(2) }, { kind: "cap", step: "decided", detail: "one more round", at: at(3) },
    { kind: "cap", step: "waiting", detail: "A11-2", at: at(4) }, { kind: "cap", step: "resumed", detail: null, at: at(5) },
    { kind: "finished", outcome: "crashed", reason: "the agent exited", at: at(6) },
  ] };
  assert.deepEqual(retroEvidence({ records: [run], runLog, since: NOW - 7 * DAY }).get("agent-org")!.map(({ source }) => source), ["needs-you", "cap", "cap", "finished:crashed"]);
});

test("A11-432: a stray file in the lessons folder whose name is not a repository's stops no repository's retro", async () => {
  const b = boardWith({});
  writeLessons(b.dir, "agent-org", [lesson("old", "an old lesson", 31)]);
  writeFileSync(`${lessonsDir(b.dir)}/%zz.json`, "{}");
  await retroSweep(b.deps)();
  assert.deepEqual(readLessons(b.dir, "agent-org"), []);
  assert.deepEqual(b.said, []);
});

test("A11-432: a lesson nobody re-confirms is dropped at exactly 30 days", () => {
  const merged = mergeLessons([{ ...lesson("edge", "edge", 0), confirmedAt: NOW - LESSON_TTL_MS }, { ...lesson("inside", "inside", 0), confirmedAt: NOW - LESSON_TTL_MS + 1 }], [], NOW, () => "x");
  assert.deepEqual(merged.map((each) => each.id), ["inside"]);
});
