// no-token: gh -- the hook decides on text; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { stopVerdict } from "./hook.ts";
import { outcomeWritten } from "./pool-outcome.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, type HeldClaim } from "./path-claims.ts";
import { FINDINGS_GIVEN_FILE, ORDER_FILE, QUESTION_FILE } from "./worker-files.ts";

const PLANNED = { kind: "planned" };
const SHELL_RUN: HeldClaim = { key: "A11-196", state: "running", paths: ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts"] };
const planWith = (...paths: string[]): string => `# Plan\n\n## Approach\n\nDo it.\n\n## Paths\n\n${paths.map((path) => `- \`${path}\``).join("\n")}\n`;

/**
 * A planning run's ticket dir: its outcome, the paths other tickets held when its brief was written, the list of its tickets with their plan folders (the one the findings check reads too), and each
 * ticket's plan files (`plans[key]`, file name to text). `order` is the batch's `order.json`, when it has one.
 */
function planningRun(plans: Record<string, Record<string, string>>, { claims = [SHELL_RUN], order }: { claims?: readonly HeldClaim[] | null; order?: object } = {}) {
  const dir = tmpDir("ticket-hook-claims-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(PLANNED));
  if (claims !== null) writeFileSync(join(dir, CLAIMS_GIVEN_FILE), JSON.stringify(claims));
  const rows = Object.keys(plans).map((key) => ({ key, planDir: join(dir, "plan", key), urls: [] }));
  writeFileSync(join(dir, FINDINGS_GIVEN_FILE), JSON.stringify(rows));
  for (const { key, planDir } of rows) {
    mkdirSync(planDir, { recursive: true });
    for (const [name, text] of Object.entries(plans[key])) writeFileSync(join(planDir, name), text);
  }
  if (order !== undefined) writeFileSync(join(dir, "plan", ORDER_FILE), JSON.stringify(order));
  return { dir, planDir: (key: string) => join(dir, "plan", key) };
}

/** The planner writing its outcome again after a retry, as the refusal tells it to: a file newer than the stale mark the retry left. */
function writeOutcomeAgain(dir: string): void {
  const later = Date.now() / 1000 + 5;
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(PLANNED));
  utimesSync(join(dir, "outcome.json"), later, later);
}

test("A11-212: a planned stop whose plan claims a folder another ticket writes in is refused once, naming the folder and the narrower paths, and the outcome is stale until it is written again", () => {
  const { dir, planDir } = planningRun({ "A11-200": { "plan.md": planWith("agent-org:ui/test/", "agent-org:ui/src/pages/settings/") } });
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2);
  const said = refused.say.join("\n");
  for (const part of ["A11-200 (plan in ", planDir("A11-200"), "`agent-org:ui/test/` is a folder A11-196 (`ui/test/fixtures.ts`) also writes into", "a folder of its own such as `ui/test/<feature>/`", "the one automatic retry", `write ${join(dir, "outcome.json")} again as the last thing you do`]) {
    assert.ok(said.includes(part), `the refusal says ${part}`);
  }
  assert.equal(said.includes("ui/src/pages/settings"), false, "it names only the folder that is shared");
  assert.deepEqual((JSON.parse(readFileSync(join(dir, CLAIMS_RETRIED_FILE), "utf8")) as { folders: string[] }).folders, ["agent-org:ui/test/"]);
  assert.equal(existsSync(join(dir, "stop-refusals")), false, "the retry does not use the outcome refusal count");
  assert.equal(outcomeWritten(dir), false, "the refused outcome is stale, so the board does not settle the plan while the planner narrows it");
  writeFileSync(join(planDir("A11-200"), "plan.md"), planWith("agent-org:ui/test/settings/", "agent-org:ui/src/pages/settings/"));
  writeOutcomeAgain(dir);
  assert.equal(outcomeWritten(dir), true, "the outcome the planner writes again is the board's to read");
  assert.equal(stopVerdict(dir).code, 0, "a plan that now claims its own folders is allowed");
});

test("A11-212: a plan that claims the folder again is allowed through the second time, for the board to send to a person: the mark is all that bounds the retry", () => {
  const { dir } = planningRun({ "A11-200": { "plan.md": planWith("agent-org:ui/test/") } });
  assert.equal(stopVerdict(dir).code, 2, "the first claim is asked about");
  writeOutcomeAgain(dir);
  assert.deepEqual(Array.from({ length: 3 }, () => stopVerdict(dir).code), [0, 0, 0]);
});

test("A11-212: a folder in a step section is read like one in the Paths section", () => {
  const plan = `# Plan\n\n### Step 1 of 2: shell\n\n- \`agent-org:ui/test/\`\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;
  const { dir } = planningRun({ "A11-200": { "plan.md": plan } });
  assert.equal(stopVerdict(dir).code, 2);
});

test("A11-212: a plan of files, of folders nobody else writes in, or of a file another ticket claims too is never retried", () => {
  for (const paths of [["agent-org:ui/test/fixtures.ts", "agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/test/settings/", "agent-org:docs/"], ["agent-org:.acceptance/", "agent-org:.changeset/"]]) {
    const { dir } = planningRun({ "A11-200": { "plan.md": planWith(...paths) } });
    assert.equal(stopVerdict(dir).code, 0, paths.join(", "));
    assert.equal(existsSync(join(dir, CLAIMS_RETRIED_FILE)), false, "no mark when nothing was claimed");
  }
});

test("A11-212: only a planned outcome with a list is retried: a needs-human outcome, a run with no list or an unreadable one, and a plan folder with a question or no plan are not", () => {
  const broad = { "A11-200": { "plan.md": planWith("agent-org:ui/test/") } };
  const asked = planningRun(broad);
  writeFileSync(join(asked.dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which?" }));
  assert.equal(stopVerdict(asked.dir).code, 0, "a needs-human outcome");
  assert.equal(stopVerdict(planningRun(broad, { claims: null }).dir).code, 0, "a run with no list (a worker's run, or a board older than this)");
  const unreadable = planningRun(broad);
  writeFileSync(join(unreadable.dir, CLAIMS_GIVEN_FILE), "{}");
  const said = stopVerdict(unreadable.dir);
  assert.equal(said.code, 0);
  assert.match(said.say.join("\n"), /is not a list of held paths, so the plan was not checked and the stop is ALLOWED/);
  assert.equal(stopVerdict(planningRun({ "A11-200": { [QUESTION_FILE]: "which?" } }).dir).code, 0, "a ticket that wrote a question");
  const empty = planningRun({ "A11-200": {} });
  assert.equal(stopVerdict(empty.dir).code, 0, "a plan folder with no plan is the board's refusal");
});

test("A11-212: a plan folder that cannot be read is allowed out loud, for the board's check to decide", () => {
  const { dir, planDir } = planningRun({ "A11-200": { "plan.md": planWith("agent-org:ui/test/") } });
  const said = stopVerdict(dir, { read: (path) => { if (path.startsWith(planDir("A11-200"))) throw new Error("EIO"); return readFileSync(path, "utf8"); } });
  assert.equal(said.code, 0);
  assert.match(said.say.join("\n"), /could not check the plan against .*\(EIO\), so the stop is ALLOWED/);
});

test("A11-212: the tickets of a batch are checked against each other, unless the batch's order sequences them", () => {
  const plans = { "A11-200": { "plan.md": planWith("agent-org:ui/test/") }, "A11-201": { "plan.md": planWith("agent-org:ui/test/fixtures.ts", "agent-org:ui/src/pages/tickets/") } };
  const together = planningRun(plans, { claims: [] });
  const refused = stopVerdict(together.dir);
  assert.equal(refused.code, 2, "A11-200's folder holds A11-201's file");
  assert.match(refused.say.join("\n"), /A11-200 \(plan in .*\): `agent-org:ui\/test\/` is a folder A11-201 \(`ui\/test\/fixtures\.ts`\) also writes into/);
  assert.equal(refused.say.join("\n").includes("A11-201 (plan in"), false, "A11-201 claims a file: it is not asked to narrow");
  const unrelated = planningRun({ ...plans, "A11-201": { "plan.md": planWith("agent-org:ui/src/pages/tickets/") } }, { claims: [] });
  assert.equal(stopVerdict(unrelated.dir).code, 0, "per-feature paths run side by side");
  const ordered = planningRun(plans, { claims: [], order: { "A11-200": { repo: "agent-org", after: [] }, "A11-201": { repo: "agent-org", after: ["A11-200"] } } });
  assert.equal(stopVerdict(ordered.dir).code, 0, "a ticket after another is not run beside it");
  const refusedOrder = planningRun(plans, { claims: [], order: { "A11-200": { repo: "agent-org", after: ["A11-200"] } } });
  assert.equal(stopVerdict(refusedOrder.dir).code, 2, "an order the board would refuse sequences nothing");
});

test("A11-212: a plan that misses a blocker's findings and claims a folder is asked about the findings first, and about the folder at the next stop", () => {
  const { dir, planDir } = planningRun({ "A11-200": { "plan.md": planWith("agent-org:ui/test/") } });
  const url = "https://github.com/a11ign/agent-org/pull/1841";
  writeFileSync(join(dir, FINDINGS_GIVEN_FILE), JSON.stringify([{ key: "A11-200", planDir: planDir("A11-200"), urls: [url] }]));
  const first = stopVerdict(dir);
  assert.equal(first.code, 2);
  assert.ok(first.say.join("\n").includes(url), "the findings first");
  assert.equal(existsSync(join(dir, CLAIMS_RETRIED_FILE)), false);
  writeFileSync(join(planDir("A11-200"), "plan.md"), `# Plan\n\n## What the blockers found\n\n- ${url}: no effect.\n\n## Paths\n\n- \`agent-org:ui/test/\`\n`);
  writeOutcomeAgain(dir);
  const second = stopVerdict(dir);
  assert.equal(second.code, 2);
  assert.ok(second.say.join("\n").includes("`agent-org:ui/test/` is a folder A11-196"), "then the folder");
});

test("A11-212: a run whose list of plan folders is missing is allowed out loud, for the board's check to decide", () => {
  const { dir } = planningRun({ "A11-200": { "plan.md": planWith("agent-org:ui/test/") } });
  rmSync(join(dir, FINDINGS_GIVEN_FILE));
  const said = stopVerdict(dir);
  assert.equal(said.code, 0);
  assert.match(said.say.join("\n"), /is missing or is not a list, so the plan was not checked and the stop is ALLOWED/);
});
