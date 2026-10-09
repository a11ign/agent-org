// no-token: gh
//
// Nothing here reaches the network or a real `gh`: every host, project and unit directory is a temp directory this file builds and deletes.

/**
 * #3039: PROJECT RESOLUTION NEVER GUESSES.
 *
 * `resolveHomeCheckout` answered an unset `AGENT_ORG_HOST` with `beside` -- the tool's `src` up three -- which in the standalone layout is
 * the home directory, and the program died one call later on `ENOENT: open '<home>/.agent-org/project.json'` (2026-10-02, 63 ticks): a
 * file nobody wrote, with the variable that was missing nowhere in the message. The set-but-unusable case already refused by name; this
 * is the unset case brought under the same rule, and the install-time half: `host:check` and `host:install` refuse a unit that would
 * start that way, reading it as the service manager would (its own `Environment=` lines, then its `<unit>.d/*.conf` drop-ins).
 *
 * The module resolves `HOME_CHECKOUT` at import, so a standalone tree with the variable unset cannot even be imported by a test. This file
 * therefore seeds the variable with a scratch host before its dynamic imports when (and only when) the ambient one has none, and drives
 * the functions with explicit arguments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "home-checkout-refusal-"));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** The smallest declaration the tool's modules read at import (their vocabulary): a project of nobody's, so nothing here is a11ign's. */
const DECLARATION = {
  schema: 1,
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/** A checkout holding a declaration: `resolveHomeCheckout` asks of `beside` only that the file is there, and the seeded import reads it. */
function checkoutWithDeclaration(): string {
  const checkout = scratch();
  mkdirSync(join(checkout, ".agent-org"));
  writeFileSync(join(checkout, ".agent-org/project.json"), JSON.stringify(DECLARATION));
  return checkout;
}

const HOST_VARIABLE = "AGENT_ORG_HOST";
if (process.env[HOST_VARIABLE] === undefined) {
  const dir = scratch();
  const checkout = checkoutWithDeclaration();
  const hostFile = join(dir, "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout }] }));
  process.env[HOST_VARIABLE] = hostFile;
}
const { ProjectDeclarationRefusal, resolveHomeCheckout } = await import("../project-config.ts");
const { hostUnitDrift, hostUnitsInstall, hostVariableAsRun, unitsWithoutHostVariable } = await import("../host-units.ts");
const { parseHostConfig } = await import("../host-config.ts");

test("the variable's name here is the one the tool reads", async () => {
  const { HOST_ENV } = await import("../project-config.ts");
  assert.equal(HOST_ENV, HOST_VARIABLE);
});

for (const [what, env] of [["unset", {}], ["empty", { [HOST_VARIABLE]: "" }]] as const) {
  test(`${what} ${HOST_VARIABLE} with no declaration beside the tool REFUSES by name, the path it would have guessed, and the remedy`, () => {
    const beside = scratch();
    // The working directory is pinned to one in no repository (#3532): a standalone tool answers the repository it is run in when that holds a declaration, and the suite runs from the project's root.
    assert.throws(() => resolveHomeCheckout({ env, beside, cwd: scratch() }), (error: unknown) => {
      assert.ok(error instanceof ProjectDeclarationRefusal);
      assert.equal((error as any).field, HOST_VARIABLE);
      assert.match(error.message, new RegExp(HOST_VARIABLE));
      assert.ok(error.message.includes(beside), `the guessed path is not named:\n${error.message}`);
      assert.match(error.message, /host:install/);
      assert.match(error.message, /Environment=AGENT_ORG_HOST=/);
      assert.doesNotMatch(error.message, /ENOENT/);
      return true;
    });
  });

  test(`POSITIVE CONTROL: ${what} ${HOST_VARIABLE} with the declaration beside the tool answers beside, as the monorepo layout always did`, () => {
    const beside = checkoutWithDeclaration();
    assert.equal(resolveHomeCheckout({ env, beside }), beside);
  });
}

test("POSITIVE CONTROL: a set variable still answers the host file's primary checkout, whatever is beside the tool", () => {
  const checkout = checkoutWithDeclaration();
  const hostFile = join(scratch(), "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout }] }));
  assert.equal(resolveHomeCheckout({ env: { [HOST_VARIABLE]: hostFile }, beside: scratch() }), checkout);
});

const TOOL = "/srv/acme/tool";
const UNIT = "acme-tick.service";
const withoutVariable = `[Service]\nWorkingDirectory=${TOOL}\nExecStart=/usr/bin/node src/work-tick.ts\n`;
const withVariable = withoutVariable.replace("[Service]\n", `[Service]\nEnvironment=${HOST_VARIABLE}=/srv/acme/repos/widgets/.agent-org/host.json\n`);

const host = parseHostConfig(JSON.stringify({
  schema: 1, home: "/srv/acme", binDir: "/srv/acme/bin", primary: "widgets", tool: TOOL,
  projects: [{ id: "widgets", checkout: "/srv/acme/repos/widgets" }],
  gh: { workers: "/srv/acme/workers", leads: "/srv/acme/leads", leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
}), "acme host.json");
const units = { prefix: "acme-", boardReportWorkflow: "board.yml", own: [UNIT] };

/** A host directory: `installed` holds the unit as installed and each `dropIns` file in `<unit>.d/`; `shipped` is what the project ships. */
function hostDir({ installed, shipped = withVariable, dropIns = {} }: { installed?: string; shipped?: string; dropIns?: Record<string, string> }) {
  const root = scratch();
  const installedDir = join(root, "installed");
  const shippedDir = join(root, "shipped");
  const projectUnitsDir = join(root, "units");
  for (const dir of [installedDir, shippedDir, projectUnitsDir]) mkdirSync(dir);
  writeFileSync(join(projectUnitsDir, UNIT), shipped);
  if (installed !== undefined) writeFileSync(join(installedDir, UNIT), installed);
  if (Object.keys(dropIns).length > 0) mkdirSync(join(installedDir, `${UNIT}.d`));
  for (const [name, text] of Object.entries(dropIns)) writeFileSync(join(installedDir, `${UNIT}.d`, name), text);
  return { installedDir, shippedDir, projectUnitsDir, host, units };
}

test("host:check: an installed tool-form unit with the variable nowhere is reported, quoting the unit's name and the variable and no path first", () => {
  const found = unitsWithoutHostVariable(hostDir({ installed: withoutVariable }));
  assert.equal(found.length, 1);
  assert.equal(found[0].unit, UNIT);
  assert.match(found[0].problem, new RegExp(HOST_VARIABLE));
  assert.ok(found[0].detail.includes(UNIT) && found[0].detail.includes(HOST_VARIABLE));
  assert.ok(!found[0].problem.startsWith("/"), found[0].problem);
});

test("host:check is part of hostUnitDrift, so `host:check` prints it", () => {
  const deps = { ...hostDir({ installed: withoutVariable }), systemctl: () => "" };
  const mine = hostUnitDrift(deps).filter((finding) => finding.unit === UNIT && finding.problem.includes(HOST_VARIABLE));
  assert.equal(mine.length, 1);
});

test("POSITIVE CONTROLS: the variable in the unit file, in a drop-in only (the chairman's hand fix), or in a quoted multi-assignment line is accepted", () => {
  assert.deepEqual(unitsWithoutHostVariable(hostDir({ installed: withVariable })), []);
  assert.deepEqual(unitsWithoutHostVariable(hostDir({ installed: withoutVariable,
    dropIns: { "agent-org-host.conf": `[Service]\nEnvironment=${HOST_VARIABLE}=/h/host.json\n` } })), []);
  const quoted = withoutVariable.replace("[Service]\n", `[Service]\nEnvironment=GH_REPO=a/b "${HOST_VARIABLE}=/h/host.json"\n`);
  assert.deepEqual(unitsWithoutHostVariable(hostDir({ installed: quoted })), []);
});

test("POSITIVE CONTROL: a unit whose working directory is not the tool's (the monorepo form) is not this check's", () => {
  const monorepoForm = withoutVariable.replace(TOOL, "/srv/acme/repos/widgets");
  assert.deepEqual(unitsWithoutHostVariable(hostDir({ installed: monorepoForm })), []);
});

test("the unit is read AS IT RUNS: an empty value, or a later bare `Environment=`, leaves the variable unset", () => {
  assert.equal(hostVariableAsRun([`Environment=${HOST_VARIABLE}=\n`]), null);
  assert.equal(hostVariableAsRun([`Environment=${HOST_VARIABLE}=/h/host.json\n`, "Environment=\n"]), null);
  assert.equal(hostVariableAsRun([`Environment=${HOST_VARIABLE}=/a\n`, `Environment=${HOST_VARIABLE}=/b\n`]), "/b");
  assert.equal(hostVariableAsRun([`Environment=OTHER_${HOST_VARIABLE}=/a\n`]), null);
  assert.equal(unitsWithoutHostVariable(hostDir({ installed: withVariable, dropIns: { "reset.conf": "[Service]\nEnvironment=\n" } })).length, 1);
});

/** `hostUnitsInstall` with every effect recorded, so "REFUSES, writing nothing" is a count and not a claim. */
function install(dir: ReturnType<typeof hostDir>) {
  const effects: string[] = [];
  const run = () => hostUnitsInstall({ ...dir, systemctl: (args: string[]) => { effects.push(`systemctl ${args.join(" ")}`); return ""; },
    write: (path: unknown) => { effects.push(`write ${String(path)}`); }, mkdir: (path: unknown) => { effects.push(`mkdir ${String(path)}`); },
    rm: (path: unknown) => { effects.push(`rm ${String(path)}`); }, out: () => {} } as never);
  return { effects, run };
}

test("host:install REFUSES a unit that would start without the variable, and writes nothing", () => {
  const dir = hostDir({ shipped: withoutVariable });
  const { effects, run } = install(dir);
  assert.throws(run, (error: unknown) => error instanceof Error && error.message.includes(UNIT) && error.message.includes(HOST_VARIABLE));
  assert.deepEqual(effects, []);
  assert.equal(existsSync(join(dir.installedDir, UNIT)), false);
});

test("POSITIVE CONTROLS: the same unit with the variable in the unit file, or in a drop-in only, is installed", () => {
  for (const dir of [hostDir({ shipped: withVariable }),
    hostDir({ shipped: withoutVariable, dropIns: { "agent-org-host.conf": `[Service]\nEnvironment=${HOST_VARIABLE}=/h/host.json\n` } })]) {
    const { effects, run } = install(dir);
    assert.deepEqual(run(), [UNIT]);
    assert.ok(effects.includes(`write ${join(dir.installedDir, UNIT)}`), effects.join("\n"));
  }
});

test("the leak scan's patterns import in a tree that holds no project and no project-config: `gate` scans BEFORE any project exists", () => {
  const dir = scratch();
  copyFileSync(fileURLToPath(new URL("../lib/generic-leak-patterns.ts", import.meta.url)), join(dir, "generic-leak-patterns.ts"));
  const env = { ...process.env };
  delete env[HOST_VARIABLE];
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { GENERIC_LEAK_PATTERNS } = await import(${JSON.stringify(join(dir, "generic-leak-patterns.ts"))}); console.log(GENERIC_LEAK_PATTERNS.length);`],
    { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "2");
});

test("`leak-patterns.ts` still answers the same two patterns, so no importer of it changed", async () => {
  const { GENERIC_LEAK_PATTERNS } = await import("../lib/leak-patterns.ts");
  const { GENERIC_LEAK_PATTERNS: own } = await import("../lib/generic-leak-patterns.ts");
  assert.equal(GENERIC_LEAK_PATTERNS, own);
});
