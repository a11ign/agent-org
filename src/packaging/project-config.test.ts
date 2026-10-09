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
 * The non-test files of the tool's `src` that still carry the repository's name literally are a RATCHET against the base the change merges
 * into (#3232, `lib/pin-ratchet.mjs`): each is a surface a later row of #69 moves, so a file this change ADDS to them must be declared with
 * its reason, and a file that stops carrying it passes. Claims 1 and the constants test read a FIXTURE declaration, never the live one, which
 * gains a repository whenever the project does (a11ign#2990 landed between one pull request's green run and its queue run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  HOME_CHECKOUT,
  HOST_ENV,
  PROJECT_DECLARATION_PATH,
  ProjectDeclarationRefusal,
  SUPPORTED_SCHEMA,
  parseProjectDeclaration,
  readProjectDeclaration,
} from "../project-config.mjs";
import { judgePin, type Declaration } from "../lib/pin-ratchet.ts";
import { TOOL_ROOT } from "./copied-tool-fixture.ts";

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

/** A declaration shaped like a11ign's (two code repositories, one tracker with a board) and owned by this file, so no other repository's change can move it. */
const A11IGN_SHAPED = {
  schema: 1,
  tracker: [{ key: "", repo: A11IGN_LITERAL, board: { owner: "a11ign", number: 1 } }],
  code: [{ key: "", repo: A11IGN_LITERAL }, { key: "agent-org", repo: "a11ign/agent-org" }],
};

/** A project directory holding `declaration` and a host file naming it primary: the one way a process is told which project it serves. */
function withFixtureProject<T>(declaration: unknown, run: (project: { dir: string; hostPath: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "project-config-fixture-"));
  try {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(join(dir, PROJECT_DECLARATION_PATH), JSON.stringify(declaration));
    const hostPath = join(dir, ".agent-org/host.json");
    writeFileSync(hostPath, JSON.stringify({ primary: "fixture", projects: [{ id: "fixture", checkout: dir }] }));
    return run({ dir, hostPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a declaration shaped like a11ign's, read through the reader, gives exactly its values", () => {
  withFixtureProject(A11IGN_SHAPED, ({ dir }) => {
    const declaration = readProjectDeclaration(dir);
    assert.equal(declaration.schema, SUPPORTED_SCHEMA);
    assert.equal(declaration.repo, A11IGN_LITERAL);
    assert.equal(declaration.boardOwner, "a11ign");
    assert.equal(declaration.boardNumber, 1);
    assert.deepEqual(declaration.code, A11IGN_SHAPED.code);
    assert.deepEqual(declaration.tracker, A11IGN_SHAPED.tracker);
  });
});

test("the constants every importer reads are the declaration's values, read at import from the project the host file names", () => {
  withFixtureProject(SECOND_PROJECT, ({ hostPath }) => {
    // A child process, because the constants are read ONCE at import from the process's own project: a different project is a different process.
    const read = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const { REPO } = await import(${JSON.stringify(new URL("../project-identity.mjs", import.meta.url).href)});`
      + `const { PROJECT_OWNER, PROJECT_NUMBER } = await import(${JSON.stringify(new URL("../board-snapshot-scope.mjs", import.meta.url).href)});`
      + "console.log(JSON.stringify({ REPO, PROJECT_OWNER, PROJECT_NUMBER }));"],
    { encoding: "utf8", env: { ...process.env, [HOST_ENV]: hostPath } });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), { REPO: "acme-corp/widgets", PROJECT_OWNER: "acme-corp", PROJECT_NUMBER: 7 });
  });
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
 * Directories the walk does not enter: `node_modules`, and `fixtures/`, which holds recorded text the tests read (the gate also copies the
 * project's own lab fixtures in beside the tests, e.g. `pr-584-body.md`, which quotes a repository URL). Neither is the tool reading its repository's name.
 */
const NOT_THE_TOOL_DIRECTORIES = ["node_modules", "fixtures"];

/**
 * A tracker reference (`a11ign/a11ign#2902`) points at a row on the project's board; it is not a place the tool reads the repository's name from
 * (#2616's rule is about the latter), and the tool's own source cites rows this way in comments AND in message templates.
 */
const TRACKER_REFERENCE = /a11ign\/a11ign#\d+/g;

function namesTheRepository(text: string): boolean {
  return text.replace(TRACKER_REFERENCE, "").includes(A11IGN_LITERAL);
}

/**
 * The non-test files under `srcDir` that carry the repository's name literally, as paths relative to it. A directory walk rather than
 * `git ls-files`, so the test spawns nothing and counts a file added in this very change before it is tracked.
 */
function filesCarryingTheLiteral(srcDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_THE_TOOL_DIRECTORIES.includes(entry.name)) walk(path);
      } else if (!/\.test\./.test(entry.name) && namesTheRepository(readFileSync(path, "utf8"))) {
        found.push(relative(srcDir, path));
      }
    }
  };
  walk(srcDir);
  return found.sort();
}

/** Each is a surface a later row of #69 moves (3f: units; 3e: the verdict script). A file that joins them is declared HERE, beside its reason. */
const DECLARED_CARRIERS: Declaration[] = [
  { name: "host-units.mjs", reason: "the units' own templates name the repository; row 3f of #69 moves them" },
  { name: "org-watch.mjs", reason: "a later row of #69 moves it" },
  { name: "reviewer/pr-review-verdict.sh", reason: "the verdict script; row 3e of #69 moves it" },
];

test("a file that newly carries the literal is DECLARED with a reason, against the base this change merges into", () => {
  const carriers = filesCarryingTheLiteral(join(TOOL_ROOT, "src"));
  // Positive control: the scan finds what is known to be there, so an empty answer cannot pass for "none was added".
  assert.ok(carriers.length > 0, "the scan found nothing: it is reading the wrong tree");
  const { undeclared, judged } = judgePin({
    repo: TOOL_ROOT, paths: ["src"], scan: (root) => filesCarryingTheLiteral(join(root, "src")), current: carriers, declared: DECLARED_CARRIERS,
  });
  assert.deepEqual(undeclared, [], `a file carries the repository's name that no declaration covers (judged ${judged}): read it from the declaration instead (#2616), `
    + "or declare it in DECLARED_CARRIERS with the reason it must name the repository");
});
