// no-token: gh -- `spawnEnvironment` and the brief sentences only build values and the fixture roles directories are temp dirs; nothing here reaches `gh` or `herdr`
/**
 * a11ign/agent-org#850 (chairman a11ign#4957, cause 1): A SPAWNED ENGINEER'S PANE STARTS WITH `AGENT_ORG_HOST`, AND IS SENT ITS BRIEF BY AN
 * ABSOLUTE PATH.
 *
 * Twelve workers sat idle for up to ten hours: the variable is not in the pane (read through `/proc/<pid>/environ`), so `pr:open`,
 * `worker:state` and the tests refused in an agent-org worktree, and the brief was named RELATIVE to a worktree that holds no
 * `.agent-org/roles`. WHAT IS PINNED: the spawn environment holds the file the gate itself resolved, with the variable ABSENT from the
 * caller's environment as well as set, and an `override` wins; the engineer's and the orchestrator's brief sentence name a path that is
 * absolute and exists; a host declaration that is not a file refuses the spawn, naming it.
 *
 * THE MUTATION is read from the source text, as `spawn-role-brief.test.ts` reads its routing: the problems found in a copy of `wake.ts`
 * that drops the key (or the refusal) are named, so the same check run over the real text is not vacuous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { addressed } from "./wake/fyi-queue.ts";
import { spawnEnvironment, whyNoHost } from "./wake/pull-request-spawn-orders.ts";
import { hostConfigPath, HOST_CONFIG_ENV, HOST_DECLARATION_PATH } from "./host-config.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { engineerBriefSentence, briefRoleSentence } from "./spawn-role-brief.ts";
import { moduleSource } from "./lib/module-source.ts";

/** Run `body` with `AGENT_ORG_HOST` set to `value`, or ABSENT when `value` is `undefined`; the caller's own value is put back. */
function withHostVariable<T>(value: string | undefined, body: () => T): T {
  const had = Object.hasOwn(process.env, HOST_CONFIG_ENV);
  const before = process.env[HOST_CONFIG_ENV];
  if (value === undefined) delete process.env[HOST_CONFIG_ENV]; else process.env[HOST_CONFIG_ENV] = value;
  try {
    return body();
  } finally {
    if (had) process.env[HOST_CONFIG_ENV] = before; else delete process.env[HOST_CONFIG_ENV];
  }
}

/** The path a brief sentence names: the one backtick-quoted span after "read". */
const namedPath = (sentence: string) => /read `([^`]+)`/.exec(sentence)?.[1] ?? "";

/** A project root with a declaration and a roles directory holding exactly `files`. */
function fixtureRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "wake-spawn-host-env-"));
  mkdirSync(join(root, ".agent-org/roles"), { recursive: true });
  writeFileSync(join(root, ".agent-org/project.json"), JSON.stringify({ roles: { dir: ".agent-org/roles" } }));
  for (const file of files) writeFileSync(join(root, ".agent-org/roles", file), `# ${file}\n`);
  return root;
}

test("POSITIVE CONTROL: the spawn environment holds AGENT_ORG_HOST equal to hostConfigPath(), the variable set in the caller's environment", () => {
  const named = "/somewhere/host.json";
  const env = withHostVariable(named, () => ({ spawned: spawnEnvironment(), resolved: hostConfigPath() }));
  assert.equal(env.resolved, named, "the control's fixture: the resolution is the variable's value");
  assert.equal(env.spawned[HOST_CONFIG_ENV], named);
  assert.equal(env.spawned.GH_CONFIG_DIR, "/home/agent/workers/gh", "the account the gate already laid is still there");
});

test("the variable ABSENT from the caller's environment still gives the pane the file the gate resolved, never nothing", () => {
  const { spawned, resolved } = withHostVariable(undefined, () => ({ spawned: spawnEnvironment(), resolved: hostConfigPath() }));
  assert.equal(resolved, join(HOME_CHECKOUT, HOST_DECLARATION_PATH), "the fallback is the declaration in the checkout the tool runs from");
  assert.equal(spawned[HOST_CONFIG_ENV], resolved);
  assert.ok(isAbsolute(spawned[HOST_CONFIG_ENV] ?? ""), "an absolute path, so a pane in any worktree reads the one file");
});

test("an override of AGENT_ORG_HOST wins, and an override of another key leaves it in place", () => {
  const overridden = withHostVariable("/gate/host.json", () => spawnEnvironment({ [HOST_CONFIG_ENV]: "/caller/host.json" }));
  assert.equal(overridden[HOST_CONFIG_ENV], "/caller/host.json");
  const other = withHostVariable("/gate/host.json", () => spawnEnvironment({ GH_CONFIG_DIR: "/home/agent/leads/gh" }));
  assert.deepEqual(other, { GH_CONFIG_DIR: "/home/agent/leads/gh", [HOST_CONFIG_ENV]: "/gate/host.json" });
});

test("the brief sentence for the engineer and for the orchestrator names an absolute path that exists", () => {
  const root = fixtureRoot(["engineer.md", "orchestrator.md"]);
  try {
    for (const role of ["engineer", "orchestrator"]) {
      const named = namedPath(briefRoleSentence(role, root));
      assert.equal(named, join(root, ".agent-org/roles", `${role}.md`), role);
      assert.ok(isAbsolute(named) && existsSync(named), `${role}: ${named} is absolute and a file`);
    }
    // The engineer's sentence over a RELATIVE brief (what `wake.ts` held until #850) is resolved, so no caller can send a relative one.
    const relative = namedPath(engineerBriefSentence(".agent-org/roles/engineer.md"));
    assert.equal(relative, join(HOME_CHECKOUT, ".agent-org/roles/engineer.md"));
    assert.equal(namedPath(engineerBriefSentence("/elsewhere/engineer.md")), "/elsewhere/engineer.md", "an absolute one is left as given");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the prompt a spawned seat is sent carries that absolute path and no bare relative one (the negative control: the relative form is what it was)", () => {
  const prompt = addressed({ session: "engineers", prompt: "claim row 850 as `<you>`", cause: "ready-row-unclaimed" }, "worker-9",
    { spawned: { row: 850, branch: "agent/a-spawned-850", worktree: "/tmp/wt-850", launchDir: "/tmp/wt-850" } });
  const named = namedPath(prompt);
  assert.ok(isAbsolute(named) && named.endsWith("/.agent-org/roles/engineer.md"), `the prompt names ${named || "nothing"}`);
  assert.ok(existsSync(named), `${named} exists in the home project`);
  assert.doesNotMatch(prompt, /read `\.agent-org\//, "the sentence no longer begins a relative path");
});

test("a host declaration that is not a file (absent, empty or a directory) refuses the spawn, naming it; a file, and an environment that names none, do not", () => {
  const root = fixtureRoot([]);
  try {
    const present = join(root, "host.json");
    writeFileSync(present, "{}");
    assert.equal(whyNoHost({ [HOST_CONFIG_ENV]: present }), null, "POSITIVE CONTROL: a file that exists is no refusal");
    const absent = join(root, "gone.json");
    assert.match(whyNoHost({ [HOST_CONFIG_ENV]: absent }) ?? "", new RegExp(`${HOST_CONFIG_ENV} names "${absent}", which is not a file`));
    assert.match(whyNoHost({ [HOST_CONFIG_ENV]: "" }) ?? "", /which is not a file/, "an empty value names no file either");
    assert.match(whyNoHost({ [HOST_CONFIG_ENV]: root }) ?? "", new RegExp(`names "${root}", which is not a file`),
      "a DIRECTORY that exists is not a host declaration (the reviewer's reproduction was `/tmp`; `existsSync` says true for it)");
    assert.match(whyNoHost({ [HOST_CONFIG_ENV]: tmpdir() }) ?? "", /which is not a file/, "the reviewer's own reproduction, the temp directory");
    assert.equal(whyNoHost({}), null, "a caller's own environment that names none is its decision, as an override is");
    assert.equal(whyNoHost({ [HOST_CONFIG_ENV]: absent }, () => true), null, "the file test is the seam's: it is read, not assumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** What `wake.ts` must still do, read from a copy of its text; the problems found, none when it holds. */
function spawnProblems(source: string): string[] {
  const problems: string[] = [];
  const start = source.indexOf("export function spawnEnvironment(");
  const body = start === -1 ? "" : source.slice(start, source.indexOf("\n}\n", start));
  if (!/\[HOST_CONFIG_ENV\]: hostConfigPath\(\)/.test(body)) problems.push("spawnEnvironment no longer lays AGENT_ORG_HOST from hostConfigPath()");
  if (body.indexOf("...override") === -1 || body.indexOf("...override") < body.indexOf("hostConfigPath()")) problems.push("an override no longer wins over the host");
  const worker = source.slice(source.indexOf("function spawnWorker("));
  const refused = worker.indexOf("whyNoHost(env");
  if (refused === -1 || refused > worker.indexOf("claimer?.claim(")) problems.push("spawnWorker no longer refuses an unreadable host before the claim");
  return problems;
}

test("MUTATION: a wake.ts that drops the key, lets the host win over an override, or refuses after the claim is named by its own problem", () => {
  const source = moduleSource("wake.ts");
  assert.deepEqual(spawnProblems(source), [], "the real text holds");
  const dropped = source.replace("[HOST_CONFIG_ENV]: hostConfigPath(), ", "");
  assert.notEqual(dropped, source, "the key-dropping fixture really differs");
  assert.deepEqual(spawnProblems(dropped), ["spawnEnvironment no longer lays AGENT_ORG_HOST from hostConfigPath()"]);
  const flipped = source.replace("{ GH_CONFIG_DIR: WORKERS_GH_CONFIG_DIR, [HOST_CONFIG_ENV]: hostConfigPath(), ...override }",
    "{ GH_CONFIG_DIR: WORKERS_GH_CONFIG_DIR, ...override, [HOST_CONFIG_ENV]: hostConfigPath() }");
  assert.notEqual(flipped, source, "the override-flipping fixture really differs");
  assert.deepEqual(spawnProblems(flipped), ["an override no longer wins over the host"]);
  const late = source.replace("const unhosted = whyNoHost(env, isFile);", "const unhosted = null as string | null;");
  assert.notEqual(late, source, "the refusal-dropping fixture really differs");
  assert.deepEqual(spawnProblems(late), ["spawnWorker no longer refuses an unreadable host before the claim"]);
});
