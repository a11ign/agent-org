/**
 * #2873 (child 5d-2 of #69): THE TOOL TAKES ITS PROJECT FROM `host.json`, NOT FROM THREE DIRECTORIES ABOVE ITSELF.
 *
 * `HOME_CHECKOUT` was `packages/agent-org/src` up three, which holds only while the tool runs inside the product checkout. In the
 * standalone repository `src/` is at the root, up three is the home directory, and importing `project-vocabulary.mjs` died with
 * `ProjectDeclarationRefusal: .../.agent-org/project.json ... ENOENT` (#2846's real run). With `$AGENT_ORG_HOST` set it is now the
 * `checkout` of the host file's `primary` project (ADR 0040, decision 3).
 *
 * Every reading is a CHILD `node` process importing a COPY of `src` laid out as the standalone repository (`<scratch>/tool/src`),
 * because the module resolves `HOME_CHECKOUT` at import and a second import in this process would be the cache's answer:
 *   1. a host file whose primary holds a fixture `project.json` gives THE FIXTURE's labels and none of a11ign's;
 *   2. a host path that does not exist, a file that is not JSON, and a primary naming no project each REFUSE naming the path;
 *   3. `$AGENT_ORG_HOST` unset, in the product tree, still gives a11ign's own labels (nothing moved for the live units).
 * Positive controls: the SAME scratch tree with the variable unset REFUSES naming `AGENT_ORG_HOST` (#3039; it was an `ENOENT` on a file
 * nobody wrote -- the failure is reachable, not described), and a host file whose primary IS a11ign's checkout gives a11ign's labels from that tree (the green path is not a
 * fixture agreeing with itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_CHECKOUT, HOST_ENV, resolveHomeCheckout } from "../project-config.mjs";
import { HOST_CONFIG_ENV } from "../host-config.mjs";

// The PROJECT's checkout (its declaration is what the labels are read from), and the TOOL's own `src`, which are two trees (the tool is not
// inside the project here), so neither is found by counting directories up from this file.
const REPO = HOME_CHECKOUT;
const TOOL_SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CHILD_TIMEOUT_MS = 30_000;
const UP_THREE = 3;

/** What a child prints: the labels it resolved, which is the whole of "whose project did it read". */
const PRINT_LABELS = `
  const v = await import(process.argv[1] + "/project-vocabulary.mjs");
  console.log(JSON.stringify({ backlog: v.BACKLOG_LABEL, lane: v.LANE_PREFIX, session: v.SESSION_PREFIX, acceptance: v.ACCEPTANCE_FIELD }));
`;

/** Labels no project but this fixture would choose. */
const FIXTURE_LABELS = { backlog: "icebox", lane: "area:", session: "owner:", acceptance: "Proof" };

type Reading = { status: number | null; stdout: string; stderr: string };

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "standalone-candidate-"));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** `src` copied as the standalone repository lays it out, tests left behind: `<scratch>/tool/src`. */
function standaloneTree(): string {
  const src = join(scratch(), "tool", "src");
  cpSync(TOOL_SRC, src, { recursive: true, filter: (from) => !/\.test\.[mc]?[jt]s$/.test(from) });
  return src;
}

/** A host file naming one project `id` at `checkout`, as the real one's `primary` and `projects` do. */
function writeHost(dir: string, hostFields: Record<string, unknown>): string {
  const path = join(dir, "host.json");
  writeFileSync(path, JSON.stringify({ schema: 1, ...hostFields }));
  return path;
}

/** a11ign's own declaration with the vocabulary words a second project would choose. */
function fixtureProject(): string {
  const checkout = join(scratch(), "fixture-project");
  mkdirSync(join(checkout, ".agent-org"), { recursive: true });
  const declaration = JSON.parse(readFileSync(join(REPO, ".agent-org/project.json"), "utf8"));
  declaration.vocabulary.labels.backlog = FIXTURE_LABELS.backlog;
  declaration.vocabulary.prefixes.lane = FIXTURE_LABELS.lane;
  declaration.vocabulary.prefixes.session = FIXTURE_LABELS.session;
  declaration.vocabulary.templateFields.acceptance = FIXTURE_LABELS.acceptance;
  writeFileSync(join(checkout, ".agent-org/project.json"), JSON.stringify(declaration));
  return checkout;
}

/** Import `<src>/project-vocabulary.mjs` in a child with `$AGENT_ORG_HOST` as given (`undefined` removes it, whatever this process holds). */
function readIn(src: string, host: string | undefined): Reading {
  const env = { ...process.env };
  delete env[HOST_ENV];
  if (host !== undefined) env[HOST_ENV] = host;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", PRINT_LABELS, src], { env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function labelsOf(reading: Reading): unknown {
  assert.equal(reading.status, 0, `the child failed:\n${reading.stderr}`);
  return JSON.parse(reading.stdout);
}

const A11IGN_LABELS = (() => {
  const vocabulary = JSON.parse(readFileSync(join(REPO, ".agent-org/project.json"), "utf8")).vocabulary;
  return {
    backlog: vocabulary.labels.backlog,
    lane: vocabulary.prefixes.lane,
    session: vocabulary.prefixes.session,
    acceptance: vocabulary.templateFields.acceptance,
  };
})();

test("the fixture's words are not a11ign's, so 'the fixture's labels' cannot be a11ign's read back", () => {
  for (const key of Object.keys(FIXTURE_LABELS) as (keyof typeof FIXTURE_LABELS)[]) {
    assert.notEqual(FIXTURE_LABELS[key], A11IGN_LABELS[key], key);
  }
});

test("the scratch tree really is the standalone layout: nothing within three levels of src declares a project", () => {
  const src = standaloneTree();
  let level = src;
  for (let up = 0; up <= UP_THREE; up += 1) {
    assert.equal(existsSync(join(level, ".agent-org")), false, `${level} holds .agent-org`);
    level = dirname(level);
  }
  assert.equal(resolve(src, "../../.."), dirname(dirname(dirname(src))));
});

test("POSITIVE CONTROL: the same tree with $AGENT_ORG_HOST unset REFUSES naming the variable, not an ENOENT on a file nobody wrote (#3039)", () => {
  const reading = readIn(standaloneTree(), undefined);
  assert.notEqual(reading.status, 0);
  assert.match(reading.stderr, /ProjectDeclarationRefusal/);
  assert.match(reading.stderr, /AGENT_ORG_HOST/);
  assert.doesNotMatch(reading.stderr, /ENOENT/);
});

test("a host file whose primary holds a fixture project gives THE FIXTURE's labels and none of a11ign's", () => {
  const checkout = fixtureProject();
  const host = writeHost(scratch(), { primary: "acme", projects: [{ id: "acme", checkout }] });
  const labels = labelsOf(readIn(standaloneTree(), host));
  assert.deepEqual(labels, FIXTURE_LABELS);
});

test("`primary` picks the project: a second declared project is not the one read", () => {
  const checkout = fixtureProject();
  const host = writeHost(scratch(), {
    primary: "acme",
    projects: [{ id: "other", checkout: REPO }, { id: "acme", checkout }],
  });
  assert.deepEqual(labelsOf(readIn(standaloneTree(), host)), FIXTURE_LABELS);
});

test("POSITIVE CONTROL: a host file whose primary is a11ign's checkout gives a11ign's labels from the standalone tree", () => {
  const host = writeHost(scratch(), { primary: "a11ign", projects: [{ id: "a11ign", checkout: REPO }] });
  assert.deepEqual(labelsOf(readIn(standaloneTree(), host)), A11IGN_LABELS);
});

/** The product tree's layout: `src` at `packages/agent-org/src` with the project's declaration three directories above it. */
function productTree(): string {
  const root = scratch();
  const src = join(root, "packages/agent-org/src");
  cpSync(TOOL_SRC, src, { recursive: true, filter: (from) => !/\.test\.[mc]?[jt]s$/.test(from) });
  mkdirSync(join(root, ".agent-org"), { recursive: true });
  cpSync(join(REPO, ".agent-org/project.json"), join(root, ".agent-org/project.json"));
  return src;
}

test("$AGENT_ORG_HOST unset, in the product tree, still gives a11ign's own labels", () => {
  assert.deepEqual(labelsOf(readIn(productTree(), undefined)), A11IGN_LABELS);
});

type Refusal = { name: string; make: () => string; reason: RegExp };
const REFUSALS: Refusal[] = [
  { name: "a path that does not exist", make: () => join(scratch(), "no-such-host.json"), reason: /cannot be read/ },
  {
    name: "a file that is not JSON",
    make: () => {
      const path = join(scratch(), "host.json");
      writeFileSync(path, "this is { not json");
      return path;
    },
    reason: /not valid JSON/,
  },
  {
    name: "a host file whose primary names no project",
    make: () => writeHost(scratch(), { primary: "ghost", projects: [{ id: "acme", checkout: REPO }] }),
    reason: /`ghost` is not one of `projects`/,
  },
  {
    name: "a host file with no primary",
    make: () => writeHost(scratch(), { projects: [{ id: "acme", checkout: REPO }] }),
    reason: /`primary` REFUSED: it is missing/,
  },
  {
    name: "a primary whose checkout is not absolute",
    make: () => writeHost(scratch(), { primary: "acme", projects: [{ id: "acme", checkout: "relative/path" }] }),
    reason: /must be an absolute path/,
  },
];

for (const refusal of REFUSALS) {
  test(`REFUSES ${refusal.name}, naming the path, and does not fall back to up-three`, () => {
    const hostPath = refusal.make();
    const reading = readIn(standaloneTree(), hostPath);
    assert.notEqual(reading.status, 0);
    assert.match(reading.stderr, /ProjectDeclarationRefusal/);
    assert.ok(reading.stderr.includes(hostPath), `the refusal does not name ${hostPath}:\n${reading.stderr}`);
    assert.match(reading.stderr, refusal.reason);
    // A fallback to up-three would have asked for the declaration three levels up, which is the unset form's refusal.
    assert.ok(!reading.stderr.includes(".agent-org/project.json"), `it fell back to up-three:\n${reading.stderr}`);
  });
}

test("an EMPTY $AGENT_ORG_HOST is unset, as `hostConfigPath` reads it", () => {
  const beside = fixtureProject();
  assert.equal(resolveHomeCheckout({ env: { [HOST_ENV]: "" }, beside }), beside);
  assert.equal(resolveHomeCheckout({ env: {}, beside }), beside);
});

test("the two modules that name the variable agree, and this process (variable unset) resolved the tree it is in", () => {
  assert.equal(HOST_ENV, HOST_CONFIG_ENV);
  // Unset, the process can only be in the product layout, where the tool is `packages/agent-org` of the project it resolved.
  if (process.env[HOST_ENV] === undefined) assert.equal(join(HOME_CHECKOUT, "packages/agent-org/src"), TOOL_SRC);
});
