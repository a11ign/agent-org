// no-token: gh -- `addressed` only builds a string and the fixture roles directories are temp dirs; nothing here reaches `gh` or `herdr`
/**
 * a11ign/agent-org#828 (Phase 1b of a11ign/a11ign#4505, CAPABILITY ONLY): A SPAWNED SEAT CAN BE BRIEFED WITH A NAMED ROLE BRIEF,
 * THE ENGINEER'S BY DEFAULT.
 *
 * WHAT IS PINNED: the default is the sentence `origin/main` carried, byte for byte (as a literal, so a refactor of the
 * module cannot move it unseen); `orchestrator` names its own brief and not the engineer's; a name outside the list, a path
 * and the empty string are refused by name; a listed role whose file is absent is refused naming the path; the standing-seat
 * branch ignores the option; and no routing moved (`SPAWN_CAUSES`, `spawnableRole`'s addressee), read from the source text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressed } from "./wake/fyi-queue.ts";
import { ENGINEER_BRIEF } from "./wake/ended-sessions.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { SPAWN_BRIEF_ROLES, engineerBriefSentence, briefRoleSentence } from "./spawn-role-brief.ts";
import { moduleSource } from "./lib/module-source.ts";

const ORDER = { session: "engineers", prompt: "claim row 1 as `<you>`", cause: "ready-row-unclaimed" };
const SPAWNED = { row: 828, branch: "agent/a-spawned-seat-828", worktree: "/tmp/wt-828", launchDir: "/tmp/wt-828" };
const spawn = (extra: { briefRole?: string; } = {}) => addressed(ORDER, "worker-9", { spawned: SPAWNED, ...extra });

/**
 * The sentence at `origin/main` 5b68f561 (`wake.ts`'s `ENGINEER_BRIEF_SENTENCE`), as a literal, with the one change #850 made: the
 * brief is named by its ABSOLUTE path under `root` (the home project's by default), never relative to the worktree.
 */
const mainSentenceAt = (root: string) => `Before you start, read \`${root}/.agent-org/roles/engineer.md\`: the resource ban, the acceptance standard and `
  + "the habits every engineer is held to. Nothing else tells you them.";
const MAIN_SENTENCE = mainSentenceAt(HOME_CHECKOUT);

/** A project root with a declaration and a roles directory holding exactly `files`. */
function fixtureRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "spawn-role-brief-"));
  mkdirSync(join(root, ".agent-org/roles"), { recursive: true });
  writeFileSync(join(root, ".agent-org/project.json"), JSON.stringify({ roles: { dir: ".agent-org/roles" } }));
  for (const file of files) writeFileSync(join(root, ".agent-org/roles", file), `# ${file}\n`);
  return root;
}

test("the default is the engineer's, and its sentence is the text at origin/main, byte for byte", () => {
  assert.ok(Buffer.byteLength(MAIN_SENTENCE) > 100, "the pinned sentence is not empty, so an empty sentence cannot pass");
  assert.equal(engineerBriefSentence(ENGINEER_BRIEF), MAIN_SENTENCE);
  assert.equal(briefRoleSentence(), MAIN_SENTENCE);
  assert.equal(briefRoleSentence("engineer"), MAIN_SENTENCE);
  assert.equal(spawn(), spawn({ briefRole: "engineer" }));
  assert.ok(spawn().includes(`\n\n${MAIN_SENTENCE}`), "the prompt carries the pinned sentence");
});

test("briefRole: orchestrator names orchestrator.md and not engineer.md; the default names engineer.md (the pair is not vacuous)", () => {
  const orchestrator = spawn({ briefRole: "orchestrator" });
  assert.match(orchestrator, /roles\/orchestrator\.md/);
  assert.doesNotMatch(orchestrator, /engineer\.md/);
  assert.match(spawn(), /roles\/engineer\.md/, "the negative control: without the option the prompt does name engineer.md");
  assert.doesNotMatch(spawn(), /orchestrator\.md/);
  assert.deepEqual([...SPAWN_BRIEF_ROLES], ["engineer", "orchestrator", "ceo"]);
  assert.ok(Object.isFrozen(SPAWN_BRIEF_ROLES));
});

test("a role outside the list, a path and the empty string each throw, naming the role and the list", () => {
  for (const role of ["product-manager", "reviewer", "", "../engineer"]) {
    assert.throws(() => spawn({ briefRole: role }), (error: Error) =>
      error.message.includes(JSON.stringify(role)) && error.message.includes("engineer, orchestrator, ceo"), `addressed: ${JSON.stringify(role)}`);
    assert.throws(() => briefRoleSentence(role), (error: Error) => error.message.includes(JSON.stringify(role)), `briefRoleSentence: ${JSON.stringify(role)}`);
  }
});

test("a listed role whose brief file is absent throws, naming the path; the present one does not", () => {
  const root = fixtureRoot(["engineer.md"]);
  try {
    const wanted = join(root, ".agent-org/roles/orchestrator.md");
    assert.throws(() => briefRoleSentence("orchestrator", root), (error: Error) => error.message.includes(wanted));
    assert.equal(briefRoleSentence("engineer", root), mainSentenceAt(root), "the positive control: the engineer's file is there, so it answers");
    writeFileSync(wanted, "# orchestrator\n");
    assert.match(briefRoleSentence("orchestrator", root), /\.agent-org\/roles\/orchestrator\.md/, "and once the file exists the same call answers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the standing-seat branch is byte-identical with and without the option", () => {
  const without = addressed(ORDER, "worker-6", { engineers: ["worker-6"] });
  assert.match(without, /roles\/engineer\.md/, "the positive control: a standing engineer is briefed");
  for (const briefRole of ["orchestrator", "engineer", "ceo"]) {
    assert.equal(addressed(ORDER, "worker-6", { engineers: ["worker-6"], briefRole }), without, briefRole);
  }
});

/** What the routing must still be, read from a copy of `wake.ts`'s text; the problems found, none when it holds. */
function routingProblems(source: string): string[] {
  const problems: string[] = [];
  if (!source.includes('export const SPAWN_CAUSES = Object.freeze(["ready-row-unclaimed"]);')) problems.push("SPAWN_CAUSES is not exactly [\"ready-row-unclaimed\"]");
  const start = source.indexOf("export function spawnableRole(");
  const body = start === -1 ? "" : source.slice(start, source.indexOf("\n}\n", start));
  if (!body.includes('if (order.session !== "engineers") {')) problems.push("spawnableRole no longer refuses an order not addressed to engineers");
  return problems;
}

test("no routing moved: SPAWN_CAUSES and spawnableRole's engineers test are untouched", () => {
  const source = moduleSource("wake.ts");
  assert.deepEqual(routingProblems(source), []);
  const widened = source.replace('Object.freeze(["ready-row-unclaimed"])', 'Object.freeze(["ready-row-unclaimed", "orchestrator-row"])');
  assert.notEqual(widened, source, "the negative control's fixture really differs");
  assert.deepEqual(routingProblems(widened), ["SPAWN_CAUSES is not exactly [\"ready-row-unclaimed\"]"], "a copy that adds a cause fails");
  const reopened = source.replace('if (order.session !== "engineers") {', 'if (order.session === "") {');
  assert.deepEqual(routingProblems(reopened), ["spawnableRole no longer refuses an order not addressed to engineers"]);
});
