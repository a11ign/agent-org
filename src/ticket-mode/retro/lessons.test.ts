// no-token: none -- herdr, git, the tracker and the model are the pool fixture's and the retro's injected fakes; nothing is spawned
// A11-432, step 2: with tickets.lessons on, a worker or planner brief carries its repository's lessons, read as the run starts, and a person edits or deletes a lesson on the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import type { ExecResult } from "../../plugins/manifest.ts";
import { poolFixture } from "../pool-fixture.ts";
import { passedOn } from "../remote-proxy.ts";
import { ticketDir } from "../ticket-paths.ts";
import { BRIEF_FILE } from "../worker-files.ts";
import { appendOutcome, outcomeRecordOf, outcomesPath } from "../outcomes/outcome-record.ts";
import type { RunEvent } from "../queue/run-log.ts";
import { briefLessons, lessonsText } from "./lessons-brief.ts";
import { type Lesson, LESSON_TEXT_MAX, lessonsPath, readLessons, writeLessons } from "./lessons-store.ts";
import { LESSON_DELETE_PATH, LESSON_EDIT_PATH, LESSONS_PATH, lessonsRoute, type LessonsView } from "./lessons-route.ts";
import { runRetro, type RetroDeps } from "./retro-job.ts";

const CHANGESET = "A pull request that changes a published package carries a changeset; three reviews asked for one.";
const lesson = (id: string, text: string, runs: readonly string[] = ["A11-1@1", "A11-2@2"]): Lesson => ({ id, text, runs, since: 1, confirmedAt: 2 });
const PLANNER = { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } };

/** A pool whose one ticket, NBF-1, is planned for agent-org, with agent-org's and toolchain's lessons written, started once: the brief its run was given. */
async function briefOf(tickets: Record<string, unknown>, { plan = false, write = true }: { plan?: boolean; write?: boolean } = {}) {
  const made = poolFixture({ keys: ["NBF-1"], tickets, clones: { "agent-org": "/repos/agent-org", toolchain: "/repos/toolchain" }, ...(plan ? { planFirst: ["NBF-1"] } : {}) });
  const queue = made.store.get();
  made.store.set({ ...queue, entries: queue.entries.map((entry) => ({ ...entry, plannedRepo: "agent-org" })) });
  if (write) {
    writeLessons(made.settings.stateDir, "agent-org", [lesson("L1", CHANGESET)]);
    writeLessons(made.settings.stateDir, "toolchain", [lesson("T1", "A toolchain lesson no agent-org run needs.")]);
  }
  await made.pool.tick();
  return { made, brief: readFileSync(join(ticketDir(made.settings, "NBF-1"), BRIEF_FILE), "utf8") };
}

test("A11-432: with tickets.lessons on, a worker run starting in agent-org has agent-org's lessons in its brief, each with its runs, and no other repository's", async () => {
  const { brief } = await briefOf({ lessons: true });
  assert.match(brief, /## Lessons from earlier runs/);
  assert.ok(brief.includes(`### agent-org\n\n- ${CHANGESET} (runs: A11-1@1, A11-2@2)`), brief);
  assert.equal(brief.includes("A toolchain lesson"), false, "lessons are never shared across repositories");
  assert.ok(brief.indexOf("## Lessons from earlier runs") < brief.indexOf("## What to do"), "before the steps the worker follows");
});

test("A11-432: with tickets.lessons off, the default, a worker brief carries no lessons whatever the files hold", async () => {
  const { brief } = await briefOf({});
  assert.equal(brief.includes("Lessons from earlier runs"), false);
  assert.equal(brief.includes(CHANGESET), false);
});

test("A11-432: with tickets.lessons on, a planner run for agent-org has agent-org's lessons in its brief", async () => {
  const { brief } = await briefOf({ lessons: true, ...PLANNER }, { plan: true });
  assert.match(brief, /^# Plan NBF-1/, "POSITIVE CONTROL: this is the planner's brief");
  assert.ok(brief.includes(`- ${CHANGESET} (runs: A11-1@1, A11-2@2)`), brief);
  assert.ok(brief.indexOf("## Lessons from earlier runs") < brief.indexOf("## What to do"));
  assert.match(brief, /Check your plan against each one that applies/);
});

test("A11-432: a repository with no lessons file, or an empty one, adds no section to the brief", async () => {
  const { brief } = await briefOf({ lessons: true }, { write: false });
  assert.equal(brief.includes("Lessons from earlier runs"), false);
  assert.equal(lessonsText([], "worker"), "");
});

test("A11-432: a lessons file that cannot be read is said and left out, and the run still starts", () => {
  const dir = tmpDir("lessons-brief-");
  writeLessons(dir, "agent-org", [lesson("L1", CHANGESET)]);
  writeFileSync(lessonsPath(dir, "toolchain"), "{ not json");
  const said: string[] = [];
  const found = briefLessons({ stateDir: dir, on: true, repos: ["toolchain", "agent-org", null, "agent-org"], log: (line) => { said.push(line); } });
  assert.deepEqual(found.map(({ repo }) => repo), ["agent-org"], "named once, in order, and the unreadable one left out");
  assert.match(said.join("\n"), /the lessons of toolchain are left out of the brief: .*is not JSON/);
});

/** The board's Lessons route over `dir`, as the server calls it. */
function route(dir: string, method: string, path: string, body: Record<string, unknown> = {}): [number, unknown] {
  const answer = lessonsRoute({ stateDir: dir, on: true }, method, path, body);
  assert.ok(answer !== undefined, `${method} ${path} is a Lessons route`);
  return answer;
}

test("A11-432: a lesson a person edits on the board is in the next brief as they wrote it, and one they delete is in none", async () => {
  const { made } = await briefOf({ lessons: true });
  const { stateDir } = made.settings;
  const edited = route(stateDir, "POST", LESSON_EDIT_PATH, { repo: "agent-org", id: "L1", text: "  Add a changeset\nfor any change to a published package.  " });
  assert.equal(edited[0], 200);
  assert.deepEqual((edited[1] as LessonsView).repos.find(({ repo }) => repo === "agent-org")?.lessons.map(({ text }) => text), ["Add a changeset for any change to a published package."]);
  const [kept] = readLessons(stateDir, "agent-org");
  assert.ok(kept !== undefined);
  assert.deepEqual([kept.runs, kept.since, kept.confirmedAt], [["A11-1@1", "A11-2@2"], 1, 2], "an edit keeps the lesson's runs and dates");
  const again = briefLessons({ stateDir, on: true, repos: ["agent-org"], log: () => {} });
  assert.ok(lessonsText(again, "worker").includes("- Add a changeset for any change to a published package. (runs: A11-1@1, A11-2@2)"));
  assert.equal(lessonsText(again, "worker").includes(CHANGESET), false);
  assert.equal(route(stateDir, "POST", LESSON_DELETE_PATH, { repo: "agent-org", id: "L1" })[0], 200);
  assert.equal(lessonsText(briefLessons({ stateDir, on: true, repos: ["agent-org"], log: () => {} }), "worker"), "", "the next brief carries no lesson");
});

test("A11-432: GET /api/lessons lists every repository's lessons, says whether briefs carry them, and names a file it cannot read rather than showing it empty", () => {
  const dir = tmpDir("lessons-route-");
  writeLessons(dir, "agent-org", [lesson("L1", CHANGESET)]);
  writeLessons(dir, "a11ign/toolchain", [lesson("T1", "Another.")]);
  writeFileSync(lessonsPath(dir, "corpus"), "[]");
  const [status, body] = lessonsRoute({ stateDir: dir, on: false }, "GET", LESSONS_PATH, {}) ?? [0, null];
  const view = body as LessonsView;
  assert.equal(status, 200);
  assert.equal(view.on, false);
  assert.deepEqual(view.repos.map(({ repo, lessons }) => [repo, lessons.map(({ id }) => id)]), [["a11ign/toolchain", ["T1"]], ["agent-org", ["L1"]]]);
  assert.deepEqual(view.unreadable.map(({ repo }) => repo), ["corpus"]);
  assert.equal(lessonsRoute({ stateDir: dir, on: false }, "GET", "/api/lessons/other", {}), undefined, "a path it does not name is another route's");
});

test("A11-432: an edit or delete naming no such lesson, no repository, an empty or overlong text, or an unreadable file is a 400 with its reason, and writes nothing", () => {
  const dir = tmpDir("lessons-refuse-");
  writeLessons(dir, "agent-org", [lesson("L1", CHANGESET)]);
  writeFileSync(lessonsPath(dir, "corpus"), "{ not json");
  const before = readFileSync(lessonsPath(dir, "agent-org"), "utf8");
  const refusals: [string, Record<string, unknown>, RegExp][] = [
    [LESSON_EDIT_PATH, { repo: "agent-org", id: "L9", text: "x" }, /agent-org has no lesson L9/],
    [LESSON_DELETE_PATH, { repo: "agent-org", id: "L9" }, /agent-org has no lesson L9/],
    [LESSON_DELETE_PATH, { repo: "toolchain", id: "L1" }, /toolchain has no lesson L1/],
    [LESSON_EDIT_PATH, { id: "L1", text: "x" }, /repo must name the lesson's repository/],
    [LESSON_EDIT_PATH, { repo: "agent-org", id: "L1" }, /text must be the lesson's new text/],
    [LESSON_EDIT_PATH, { repo: "agent-org", id: "L1", text: " \n " }, /a lesson needs some text; delete it to drop it/],
    [LESSON_EDIT_PATH, { repo: "agent-org", id: "L1", text: "x".repeat(LESSON_TEXT_MAX + 1) }, /at most 300 characters/],
    [LESSON_EDIT_PATH, { repo: "corpus", id: "L1", text: "x" }, /corpus's lessons cannot be changed: .*is not JSON/],
  ];
  for (const [path, body, reason] of refusals) {
    const [status, answer] = route(dir, "POST", path, body);
    assert.equal(status, 400, `${path} ${JSON.stringify(body)}`);
    assert.match((answer as { error: string }).error, reason);
  }
  assert.equal(readFileSync(lessonsPath(dir, "agent-org"), "utf8"), before);
  assert.equal(readFileSync(lessonsPath(dir, "corpus"), "utf8"), "{ not json", "an unreadable file is never written over");
});

test("A11-432: the page's calls to the Lessons routes are passed on to an instance, and no other lessons path is", () => {
  assert.equal(passedOn("GET", LESSONS_PATH), true);
  assert.equal(passedOn("POST", LESSON_EDIT_PATH), true);
  assert.equal(passedOn("POST", LESSON_DELETE_PATH), true);
  assert.equal(passedOn("POST", LESSONS_PATH), false);
  assert.equal(passedOn("GET", LESSON_EDIT_PATH), false);
});

test("A11-432: a person's edit or delete while the retro waits on its model is kept: the edited text stays, and the deleted lesson is not written back", async () => {
  const dir = tmpDir("lessons-race-");
  const NOW = Date.UTC(2026, 10, 16, 6);
  const DAY = 24 * 60 * 60 * 1000;
  writeLessons(dir, "agent-org", [{ ...lesson("L1", "Old wording."), confirmedAt: NOW - DAY }, { ...lesson("L2", "Wrong lesson."), confirmedAt: NOW - DAY }]);
  const runs = [1, 2].map((n) => outcomeRecordOf({ ticket: `A11-${n}`, model: "sonnet", effort: "high", repos: ["agent-org"], labels: [], prs: [] },
    { since: NOW - n * 60 * 60_000, rounds: [{ startedAt: NOW - n * 60 * 60_000, endedAt: NOW - n * 60 * 60_000 + 1, outcome: "ready-pr", tokens: {} }] }));
  for (const run of runs) appendOutcome(outcomesPath(dir), run);
  const runLog: Record<string, RunEvent[]> = Object.fromEntries(runs.map((run) => [run.ticket, [{ kind: "round", cause: "feedback", reason: "add a changeset", at: run.rounds[0]!.startedAt! + 1 } as RunEvent]]));
  const ask = async (): Promise<ExecResult> => {
    // The person acts on the board while the model is still answering.
    route(dir, "POST", LESSON_EDIT_PATH, { repo: "agent-org", id: "L1", text: "The person's wording." });
    route(dir, "POST", LESSON_DELETE_PATH, { repo: "agent-org", id: "L2" });
    const reply = { lessons: [{ id: "L1", text: "Model wording.", runs: runs.map(({ run }) => run) }, { id: "L2", text: "Wrong lesson.", runs: runs.map(({ run }) => run) }] };
    return { status: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(reply) }), stderr: "" };
  };
  const deps: RetroDeps = { on: () => true, stateDir: dir, runLog: () => runLog, now: () => NOW, log: () => {}, ask };
  await runRetro(deps, NOW);
  const after = readLessons(dir, "agent-org");
  assert.deepEqual(after.map(({ id, text }) => [id, text]), [["L1", "The person's wording."]]);
  assert.equal(after[0]!.confirmedAt, NOW, "POSITIVE CONTROL: the model's answer was read, and re-confirmed the edited lesson");
});
