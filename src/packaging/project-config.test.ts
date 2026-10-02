/**
 * #2616 (child 3a of #69): THE ONE READER OF A PROJECT'S DECLARATION, `.agent-org/project.json` (ADR 0040, decisions 1 and 2).
 *
 * Three claims, each with its control in this file:
 *   1. a11ign's own declaration, read through the reader, gives EXACTLY today's values, so nothing moved -- and it is
 *      non-empty and holds the empty key exactly once (the control for every "nothing was wrong" reading below);
 *   2. a SECOND project (another owner, repository and board number) gives ITS values through the same reader, which is what
 *      "project-agnostic" means and the only thing that shows the reader is not a11ign's constants in a trench coat;
 *   3. each rule is REFUSED naming the field, and never answered with a11ign's values. Every refusal is a one-change mutation
 *      of a VALID base, so it is shown to fail for the named field and not an unrelated one, and the unmutated base is shown to
 *      pass (the positive control: a base that was itself invalid would make every refusal below true for the wrong reason).
 *
 * The count of non-test files under `packages/agent-org/src` that still carry the repository's name literally is recorded
 * and asserted NOT to grow: each is a surface a later row of #69 moves, and a new one is a surface it must move too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  HOME_CHECKOUT,
  PROJECT_DECLARATION_PATH,
  ProjectDeclarationRefusal,
  SUPPORTED_SCHEMA,
  parseProjectDeclaration,
  readProjectDeclaration,
} from "../project-config.mjs";
import { REPO } from "../project-identity.mjs";
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.mjs";

const A11IGN_LITERAL = "a11ign/a11ign";

/** A VALID declaration that is not a11ign's in any field a project can set. */
const SECOND_PROJECT = {
  schema: 1,
  tracker: [{ key: "", repo: "acme-corp/widgets", board: { owner: "acme-corp", number: 7 } }],
  code: [{ key: "", repo: "acme-corp/widgets" }],
};

// A mutation reaches into fields the fixture's own type would have to pretend are optional and mistyped, which is the point of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** @param mutate the ONE change that makes the declaration invalid */
function mutated(mutate: (declaration: Loose) => void): string {
  const copy = JSON.parse(JSON.stringify(SECOND_PROJECT));
  mutate(copy);
  return JSON.stringify(copy);
}

/** Run `text` through the reader and return the refusal it must produce. */
function refusalOf(text: string): ProjectDeclarationRefusal {
  try {
    parseProjectDeclaration(text, "fixture/project.json");
  } catch (error) {
    assert.ok(error instanceof ProjectDeclarationRefusal, `expected a ProjectDeclarationRefusal, got ${String(error)}`);
    return error;
  }
  return assert.fail("the declaration was ACCEPTED where a refusal was required");
}

/** @param {string} text @param {string} field the field the refusal must name, and the message must repeat it */
function assertRefusedFor(text: string, field: string): void {
  const refusal = refusalOf(text);
  assert.equal(refusal.field, field, refusal.message);
  assert.ok(refusal.message.includes(`\`${field}\``), `the message must name the field: ${refusal.message}`);
}

test("a11ign's own declaration, read through the reader, gives exactly today's values", () => {
  const declaration = readProjectDeclaration(HOME_CHECKOUT);
  assert.equal(declaration.schema, SUPPORTED_SCHEMA);
  assert.equal(declaration.repo, A11IGN_LITERAL);
  assert.equal(declaration.boardOwner, "a11ign");
  assert.equal(declaration.boardNumber, 1);
  assert.deepEqual(declaration.code, [{ key: "", repo: A11IGN_LITERAL }, { key: "agent-org", repo: "a11ign/agent-org" }]); // #2969: the second is a repository the gate must read
  assert.deepEqual(declaration.tracker, [{ key: "", repo: A11IGN_LITERAL, board: { owner: "a11ign", number: 1 } }]);
});

test("the constants every importer reads are the declaration's values, and the same as before the seam", () => {
  const declaration = readProjectDeclaration(HOME_CHECKOUT);
  assert.equal(REPO, A11IGN_LITERAL);
  assert.equal(PROJECT_OWNER, "a11ign");
  assert.equal(PROJECT_NUMBER, 1);
  assert.equal(declaration.tracker.length, 1);
  assert.equal(declaration.code.length, 2, "the primary's repository and `agent-org` (#2969)");
});

test("POSITIVE CONTROL: a11ign's declaration is non-empty and holds the empty key exactly once in each list", () => {
  const declaration = readProjectDeclaration(HOME_CHECKOUT);
  for (const list of [declaration.tracker, declaration.code]) {
    assert.ok(list.length > 0, "an empty list would make every per-entry assertion below vacuously true");
    assert.equal(list.filter((entry) => entry.key === "").length, 1);
  }
  // The file on disk is what was read, not a constant: it carries the declaration's schema line.
  assert.ok(readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8").includes('"schema"'));
});

test("a SECOND project resolves through the same reader to ITS values, and none of a11ign's", () => {
  const dir = mkdtempSync(join(tmpdir(), "project-config-"));
  try {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(join(dir, PROJECT_DECLARATION_PATH), JSON.stringify(SECOND_PROJECT));
    const declaration = readProjectDeclaration(dir);
    assert.equal(declaration.repo, "acme-corp/widgets");
    assert.equal(declaration.boardOwner, "acme-corp");
    assert.equal(declaration.boardNumber, 7);
    assert.deepEqual(declaration.code, SECOND_PROJECT.code);
    assert.deepEqual(declaration.tracker, SECOND_PROJECT.tracker);
    assert.ok(!JSON.stringify(declaration).includes("a11ign"), "the second project's answer must carry nothing of a11ign's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POSITIVE CONTROL: the unmutated base of every refusal below is ACCEPTED", () => {
  const declaration = parseProjectDeclaration(JSON.stringify(SECOND_PROJECT), "fixture/project.json");
  assert.equal(declaration.repo, "acme-corp/widgets");
});

test("a missing declaration is REFUSED naming the file, never answered with a11ign's values", () => {
  const dir = mkdtempSync(join(tmpdir(), "project-config-none-"));
  try {
    assert.throws(
      () => readProjectDeclaration(dir),
      (error: unknown) => {
        assert.ok(error instanceof ProjectDeclarationRefusal);
        assert.equal(error.field, "(file)");
        assert.ok(error.message.includes(join(dir, PROJECT_DECLARATION_PATH)), error.message);
        assert.ok(!error.message.includes(A11IGN_LITERAL), error.message);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declaration that is not JSON, or not an object, is REFUSED", () => {
  assertRefusedFor("{ not json", "(file)");
  assertRefusedFor("[]", "(file)");
});

test("a MISSING field is refused naming that field", () => {
  assertRefusedFor(mutated((d) => delete d.schema), "schema");
  assertRefusedFor(mutated((d) => delete d.tracker), "tracker");
  assertRefusedFor(mutated((d) => delete d.code), "code");
  assertRefusedFor(mutated((d) => delete d.code[0].repo), "code[0].repo");
  assertRefusedFor(mutated((d) => delete d.code[0].key), "code[0].key");
  assertRefusedFor(mutated((d) => delete d.tracker[0].board), "tracker[0].board");
  assertRefusedFor(mutated((d) => delete d.tracker[0].board.owner), "tracker[0].board.owner");
  assertRefusedFor(mutated((d) => delete d.tracker[0].board.number), "tracker[0].board.number");
});

test("a MISTYPED field is refused naming that field", () => {
  assertRefusedFor(mutated((d) => (d.tracker = "acme-corp/widgets")), "tracker");
  assertRefusedFor(mutated((d) => (d.code = [])), "code");
  assertRefusedFor(mutated((d) => (d.code[0] = "acme-corp/widgets")), "code[0]");
  assertRefusedFor(mutated((d) => (d.code[0].repo = 7)), "code[0].repo");
  assertRefusedFor(mutated((d) => (d.code[0].repo = "no-slash")), "code[0].repo");
  assertRefusedFor(mutated((d) => (d.tracker[0].board = "1")), "tracker[0].board");
  assertRefusedFor(mutated((d) => (d.tracker[0].board.owner = "")), "tracker[0].board.owner");
  assertRefusedFor(mutated((d) => (d.tracker[0].board.number = "7")), "tracker[0].board.number");
  assertRefusedFor(mutated((d) => (d.tracker[0].board.number = 0)), "tracker[0].board.number");
  assertRefusedFor(mutated((d) => (d.tracker[0].board.number = 1.5)), "tracker[0].board.number");
});

test("an unknown schema is REFUSED naming `schema`, including a string that looks like the supported one", () => {
  assertRefusedFor(mutated((d) => (d.schema = 2)), "schema");
  assertRefusedFor(mutated((d) => (d.schema = "1")), "schema");
});

test("two entries with the same key are REFUSED naming the second, in either list", () => {
  const twice = (list: string) => (d: Loose) => d[list].push({ ...d[list][0], key: "x" }, { ...d[list][0], key: "x" });
  assertRefusedFor(mutated(twice("code")), "code[2].key");
  assertRefusedFor(mutated(twice("tracker")), "tracker[2].key");
});

test("a key ending in -<digits> is REFUSED naming the key, and a digit elsewhere in it is not", () => {
  const withKey = (key: string) => mutated((d) => (d.code[0].key = key));
  assertRefusedFor(withKey("agent-org-7"), "code[0].key");
  assertRefusedFor(withKey("-12"), "code[0].key");
  assertRefusedFor(mutated((d) => (d.tracker[0].key = "layer-3")), "tracker[0].key");
  // The control that keeps the rule from over-firing: digits inside a key, or a key that IS digits, parse uniquely.
  assert.equal(parseProjectDeclaration(withKey("agent-org2"), "fixture").code[0].key, "agent-org2");
  assert.equal(parseProjectDeclaration(withKey("v2-worker"), "fixture").code[0].key, "v2-worker");
  assertRefusedFor(withKey("Agent_Org"), "code[0].key");
});

test("the EMPTY key declared twice is REFUSED, and says it is the empty key", () => {
  const text = mutated((d) => d.code.push({ key: "", repo: "acme-corp/other" }));
  assertRefusedFor(text, "code[1].key");
  assert.match(refusalOf(text).message, /EMPTY key is declared twice/);
  // ...while one empty key beside a keyed entry is the ordinary two-repository declaration.
  const ordinary = parseProjectDeclaration(mutated((d) => d.code.push({ key: "layer", repo: "acme-corp/layer" })), "fixture");
  assert.deepEqual(ordinary.code.map((entry) => entry.key), ["", "layer"]);
  assert.equal(ordinary.repo, "acme-corp/widgets", "the FIRST code repository is the project's own");
});

test("a refusal for one field is not a refusal for another (each mutation fires exactly its own rule)", () => {
  const fields = [
    mutated((d) => delete d.schema),
    mutated((d) => (d.code[0].repo = "no-slash")),
    mutated((d) => (d.tracker[0].board.number = 0)),
    mutated((d) => (d.code[0].key = "k-1")),
  ].map((text) => refusalOf(text).field);
  assert.deepEqual(fields, ["schema", "code[0].repo", "tracker[0].board.number", "code[0].key"]);
  assert.equal(new Set(fields).size, fields.length);
});

/**
 * The non-test files under `packages/agent-org/src` that carry the repository's name literally. A directory walk rather than
 * `git ls-files`, so the test spawns nothing and counts a file added in this very change before it is tracked.
 */
function filesCarryingTheLiteral(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (!/\.test\./.test(entry.name) && readFileSync(path, "utf8").includes(A11IGN_LITERAL)) {
        found.push(relative(HOME_CHECKOUT, path));
      }
    }
  };
  walk(join(HOME_CHECKOUT, "packages/agent-org/src"));
  return found.sort();
}

/** Measured 2026-09-26 at `d4da35a52` plus this change: 3. Each is a surface a later row of #69 moves (3f: units; 3e: the verdict script). */
const RECORDED_CARRIERS = [
  "packages/agent-org/src/host-units.mjs",
  "packages/agent-org/src/org-watch.mjs",
  "packages/agent-org/src/reviewer/pr-review-verdict.sh",
];

test("the count of non-test files in packages/agent-org/src carrying the literal is recorded and does NOT grow", () => {
  const carriers = filesCarryingTheLiteral();
  // Positive control: the scan finds what is known to be there, so an empty answer cannot pass for "none grew".
  assert.ok(carriers.length > 0, "the scan found nothing: it is reading the wrong tree");
  assert.deepEqual(
    carriers.filter((file) => !RECORDED_CARRIERS.includes(file)),
    [],
    "a NEW file carries the repository's name: read it from the declaration instead (#2616)",
  );
  assert.ok(carriers.length <= RECORDED_CARRIERS.length, `${carriers.length} > ${RECORDED_CARRIERS.length}`);
  assert.deepEqual(carriers, RECORDED_CARRIERS, "one moved: shrink RECORDED_CARRIERS with it, so the ceiling follows the count down");
});
