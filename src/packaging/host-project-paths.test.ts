// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The one script this file RUNS, the board-report dispatcher, is started with a stub
// `gh` first on its PATH that only records its arguments, and every other read is of the repository's own files or of a temp directory
// this file builds and deletes.

/**
 * #2620 (child 3f of #69): HOST PATHS AND UNIT NAMES ARE THE PROJECT'S PARAMETERS.
 *
 * `agent-org` is becoming a project-agnostic tool. Before this row its sources and unit files named a11ign's host -- `/home/agent/...` --
 * in twelve files, and the routing wrapper, the board dispatcher and the unit-name prefix were a11ign's by construction. What a host
 * knows is now `.agent-org/host.json` (`host-config.mjs` reads it), what a project knows is its `.agent-org/project.json`, and the tool's
 * three units and its `gh` wrapper are TEMPLATES rendered from the two.
 *
 * WHAT THIS FILE OWES, in the row's words: no home-directory literal in the tool's own files; a11ign's `host.json` reproducing every path
 * the tool used to name; the 17 entries the host directory held classified exactly once (8 tool, 8 project, 1 host data) and an
 * eighteenth REFUSED; the three tool units rendered from templates to today's bytes; and a project with different paths changing what
 * the readers use. NO UNIT IS RENAMED AND NONE IS REINSTALLED BY THIS ROW: the rendered names are asserted equal to the installed ones,
 * and rows 4 and 5 (the shadow run and the extraction) are where an install happens.
 *
 * WHAT IT DOES NOT COVER, said so it cannot be read as covered. `wake.mjs`, `work-gate.mjs` and `lib/worktree-resolution.mjs` still name
 * `/home/agent` (two constants and some prose); they belong to rows 3b and 3c, whose Regions those files are, and the constants are
 * tied to `host.json` below so they cannot drift from it in the meantime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_UNITS_DIR, REPO_ROOT, SHIPPED_DIR, TOOL_ENTRIES, HOST_DATA_ENTRIES, hostUnitDrift, identityDrift,
  leadsListText, ownedIdentityFiles, shippedScriptText, shippedUnitText, shippedUnits, unclassifiedEntries }
  from "../host-units.mjs";
import { HostConfigRefusal, homeHostConfig, hostConfigPath, leadsWorkspacesText, parseHostConfig, parseUnitsDeclaration,
  readUnitsDeclaration, renderTemplate, renderedName, templateValues } from "../host-config.mjs";

const checkout = REPO_ROOT.replace(/\/$/, "");
const host = homeHostConfig();
const units = readUnitsDeclaration();
/** a11ign's host with no `tool`: what the TEMPLATES render for it, whether or not the cut (#2974) has set the key. The tool form is asserted in `host-tool-install.test.ts`. */
const plainHost = (() => {
  const plain: Record<string, unknown> = { ...host };
  delete plain.tool;
  return Object.freeze(plain);
})() as never;

/** A home-directory path, however it continues: what "the tool names a host" means in text. */
const HOME_LITERAL = /\/home\/[A-Za-z_][\w.-]*/;

/** The three files of the tool's own source this row edited, and every entry of the tool's host directory. */
const TOOL_SOURCES = ["packages/agent-org/src/host-units.mjs", "packages/agent-org/src/host-config.mjs",
  "packages/agent-org/src/board-snapshot-scope.mjs"];
const toolFiles = () => [...TOOL_SOURCES.map((path) => join(checkout, path)), ...TOOL_ENTRIES.map((name) => join(SHIPPED_DIR, name))];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// --- 1. no home literal in the tool's own files ------------------------------------------------------------------------------------

test("#2620: no home-directory literal remains in the tool's sources, its templates or its scripts", () => {
  const files = toolFiles();
  assert.equal(files.length, 3 + 12, "POSITIVE CONTROL: fifteen files are scanned (three sources, twelve host entries -- the two the shadow window added, #2867, and the two chairman-watch templates, #2901, included), so an emptiness below is not a scan of nothing");
  const offenders = files.filter((file) => HOME_LITERAL.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "each of these names a host path the tool must read from host.json instead");
});

test("#2620: the scan CAN see the literal -- the project's own units carry it, and the matcher matches a plain path", () => {
  assert.match("Environment=HOME=/home/agent", HOME_LITERAL);
  const carrying = readdirSync(PROJECT_UNITS_DIR).filter((name) => HOME_LITERAL.test(readFileSync(join(PROJECT_UNITS_DIR, name), "utf8")));
  assert.deepEqual(carrying.sort(), units.own.filter((name) => name.endsWith(".service")).sort(),
    "the project's four services still name their own host (a timer names none), which is where the literal belongs");
});

// --- 2. a11ign's host.json reproduces every current path ---------------------------------------------------------------------------

test("#2620: a11ign's host.json says every path the tool used to hard-code", () => {
  assert.deepEqual(templateValues(host, units), {
    home: "/home/agent", binDir: "/home/agent/.local/bin", checkout: "/home/agent/repos/a11y-witness",
    workersDir: "/home/agent/workers", leadsDir: "/home/agent/leads", prefix: "a11ign-",
  });
  assert.deepEqual(host.gh.leadsWorkspaces.map((w) => w.id), ["w6", "w2", "w5"], "the leads list is the file it replaced");
});

test("#2620: the constants `wake.mjs` still spells out (rows 3b and 3c) equal what host.json says", () => {
  const wake = readFileSync(join(checkout, "packages/agent-org/src/wake.mjs"), "utf8");
  const constant = (name: string) => new RegExp(`export const ${name} = "([^"]+)"`).exec(wake)?.[1];
  assert.equal(constant("WORKERS_GH_CONFIG_DIR"), `${host.gh.workers}/gh`);
  assert.equal(constant("HOST_REPOS"), dirname(templateValues(host, units).checkout));
});

// Sha-256 of the texts as they stood at commit 1b5176697, BEFORE the row: the bytes `host:check` compares the live host against. A
// rendering that differs by one byte reports every installed unit STALE, so this is the guard on "a11ign's values are unchanged".
const TODAYS_TEXT = {
  // #2781 MOVED THIS ONE, deliberately: the unit gained a comment saying the `-` on `primary:update` is covered by the gate reading the primary.
  // #2974 MOVED THIS ONE, deliberately: the cut-over moved its `primary:update` line from `/usr/bin/npm` to the pnpm shim and its header comment off the monorepo path (`units-run-pnpm.test.ts`).
  "a11ign-work-tick.service": "1c388b269625507de8067d4620f3bd5a92dd7f94ea06a21516b18061352aa7dd",
  "a11ign-work-tick.timer": "c47470e624dc884515212badc11c82890fa864b7181175a2ab3570fe182e72ec",
  // #2782 MOVED THIS ONE, deliberately: the prune unit now declares `GH_CONFIG_DIR` (it reads a row's claim before removing a tree). The
  // installed copy reads STALE until `host:install` runs, which is a host action and not this row's.
  // #2892 MOVED IT AGAIN, deliberately: `ExecStart` runs `%h/.local/bin/pnpm` instead of `/usr/bin/npm`. Same staleness, same remedy.
  "a11ign-worktree-prune.service": "c88a8bb1f9fb44cad7b312d6064fe334cb58c607d2bce59572887536ebc4809a",
  "a11ign-worktree-prune.timer": "ecae95090a7608f86b01df84f5b79eeeb76beec48a28310b90c7c7e1d2b766eb",
  "a11ign-board-report.service": "3e7791d9f24ae9aa3519898259f1ea68c1f8b4cd721f97b62916c9f81835b0c1",
  "a11ign-board-report.timer": "6edd74ab8a7d4117197dddd448e30a2ab63ab9972799dd90f5f500c067f033f1",
};
const TODAYS_GH_WRAPPER = "9eba78303036eef62879b34b2a4df0727fdb5655f3ff4f4305de2329dd19ba5c";
const TODAYS_LEADS_LIST = "e0843e1aa26def5bd9a447839ba242c57a011a5612715d21300f8846d5ce221a";

test("#2620: the three tool units, the wrapper and the leads list render to TODAY'S text for a11ign's values", () => {
  assert.equal(Object.keys(TODAYS_TEXT).length, 6, "POSITIVE CONTROL: six units (three services, three timers), not a subset");
  for (const [unit, digest] of Object.entries(TODAYS_TEXT)) {
    assert.equal(sha256(shippedUnitText(unit, { host: plainHost }) ?? ""), digest, `${unit} is not byte-identical to the unit the host runs`);
  }
  assert.equal(sha256(shippedScriptText("gh") ?? ""), TODAYS_GH_WRAPPER, "the wrapper installed at ~/.local/bin/gh");
  assert.equal(sha256(leadsListText()), TODAYS_LEADS_LIST, "the leads list installed at ~/leads/workspaces.txt");
});

test("#2620: NO UNIT IS RENAMED -- the installed names are the fourteen there were, and the shadow window's two (#2867)", () => {
  assert.deepEqual(shippedUnits(), [
    "a11ign-board-report.service", "a11ign-board-report.timer",
    "a11ign-corpus-release-nightly.service", "a11ign-corpus-release-nightly.timer",
    "a11ign-corpus-snapshot.service", "a11ign-corpus-snapshot.timer",
    "a11ign-fleet-watch.service", "a11ign-fleet-watch.timer",
    "a11ign-lab-watch.service", "a11ign-lab-watch.timer",
    "a11ign-shadow-window.service", "a11ign-shadow-window.timer",
    "a11ign-work-tick.service", "a11ign-work-tick.timer",
    "a11ign-worktree-prune.service", "a11ign-worktree-prune.timer",
  ]);
});

// --- 3. the partition of the seventeen ---------------------------------------------------------------------------------------------

test("#2620: the 17 entries are classified 8 tool, 8 project, 1 host data -- asserted against the files, plus the shadow window's two tool entries (#2867) and the chairman watcher's two (#2901)", () => {
  const inTool = readdirSync(SHIPPED_DIR).sort();
  const inProject = readdirSync(PROJECT_UNITS_DIR).sort();
  const hostData = Object.keys(HOST_DATA_ENTRIES);
  const shadowPair = inTool.filter((name) => name.startsWith("shadow-window."));
  assert.equal(shadowPair.length, 2, "POSITIVE CONTROL: #2867's pair is two of them, so the 8 below is the original eight and the pair");
  const chairmanPair = inTool.filter((name) => name.startsWith("chairman-watch."));
  assert.equal(chairmanPair.length, 2, "POSITIVE CONTROL: #2901's optional pair is two more, so the 8 below is still the original eight");
  assert.equal(inTool.length - shadowPair.length - chairmanPair.length, 8, "POSITIVE CONTROL: eight entries stay in the tool's host directory");
  assert.equal(inProject.length, 8, "POSITIVE CONTROL: eight moved to the project's `.agent-org/units/`");
  assert.equal(hostData.length, 1, "POSITIVE CONTROL: one is host data");
  assert.equal(inTool.length - shadowPair.length - chairmanPair.length + inProject.length + hostData.length, 17, "the host directory held seventeen entries");
  assert.deepEqual(inTool, [...TOOL_ENTRIES].sort(), "the tool's directory holds exactly what the tool records");
  assert.deepEqual(inProject, [...units.own].sort(), "the project's directory holds exactly what its declaration lists");
  for (const name of hostData) {
    assert.ok(!existsSync(join(SHIPPED_DIR, name)) && !existsSync(join(PROJECT_UNITS_DIR, name)), `${name} is host.json's now, not a file`);
    assert.ok(host.gh.leadsWorkspaces.length > 0, "and `host.json` carries the data");
  }
  assert.deepEqual(unclassifiedEntries(), [], "and nothing is classified nowhere");
});

/** A tool directory and a project directory holding exactly the classified entries, in a temp directory. */
function classifiedFixture() {
  const root = mkdtempSync(join(tmpdir(), "host-partition-2620-"));
  const tool = join(root, "host");
  const project = join(root, "units");
  mkdirSync(tool);
  mkdirSync(project);
  for (const name of TOOL_ENTRIES) writeFileSync(join(tool, name), "");
  for (const name of units.own) writeFileSync(join(project, name), "");
  return { root, tool, project, deps: { shippedDir: tool, projectUnitsDir: project, units, host: plainHost } };
}

test("#2620: an EIGHTEENTH entry classified nowhere is REFUSED, in either directory, and the classified fixture reads clean", () => {
  const { root, tool, project, deps } = classifiedFixture();
  try {
    assert.deepEqual(unclassifiedEntries(deps), [], "MATCHED PAIR: exactly the seventeen classified read clean, so the refusal below is not a check that always fires");
    writeFileSync(join(tool, "stray.service"), "");
    assert.deepEqual(unclassifiedEntries(deps).map((f) => f.unit), ["stray.service"]);
    rmSync(join(tool, "stray.service"));
    writeFileSync(join(project, "a11ign-new-thing.timer"), "");
    const foreign = unclassifiedEntries(deps);
    assert.deepEqual(foreign.map((f) => f.unit), ["a11ign-new-thing.timer"], "a unit in the project's directory its declaration does not list");
    assert.match(foreign[0].detail, /units\.own/, "and the refusal says where to list it");
    rmSync(join(project, "a11ign-new-thing.timer"));
    writeFileSync(join(tool, "gh-leads-workspaces.txt"), "w6\n");
    assert.match(unclassifiedEntries(deps)[0].detail, /host\.json/, "the host-data entry, put back as a file, is refused and told where it went");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2620: `host:check` carries the refusal -- the eighteenth entry is a FINDING, and the clean fixture has none", () => {
  const { root, tool, deps } = classifiedFixture();
  try {
    const asked = { ...deps, systemctl: (() => "LANG=C\n") as never, installedDir: join(root, "installed"), git: (() => "") as never };
    const unclassified = () => hostUnitDrift(asked).filter((f: { problem: string }) => f.problem === "UNCLASSIFIED ENTRY");
    assert.deepEqual(unclassified(), []);
    writeFileSync(join(tool, "stray.service"), "");
    assert.deepEqual(unclassified().map((f: { unit: string }) => f.unit), ["stray.service"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- 4. a project with different paths changes what the readers use -----------------------------------------------------------------

const ACME_HOST = parseHostConfig(JSON.stringify({
  schema: 1, home: "/srv/ci", binDir: "/srv/ci/bin", primary: "acme",
  projects: [{ id: "acme", checkout: "/srv/ci/repos/widgets" }],
  gh: { workers: "/srv/ci/workers", leads: "/srv/ci/leads", leadsHeader: ["acme's leads"], leadsWorkspaces: [{ id: "x1", role: "lead" }] },
}));
const ACME_UNITS = parseUnitsDeclaration(JSON.stringify({ units: { prefix: "acme-", boardReportWorkflow: "daily.yml", own: [] } }));
const ACME = { host: ACME_HOST, units: ACME_UNITS, projectUnitsDir: null };

test("#2620: a fixture project's paths and prefix change the units, the wrapper and the leads list", () => {
  const work = shippedUnitText("acme-work-tick.service", ACME) ?? "";
  assert.match(work, /^WorkingDirectory=\/srv\/ci\/repos\/widgets$/m);
  assert.match(work, /^Environment=GH_CONFIG_DIR=\/srv\/ci\/workers\/gh$/m);
  assert.match(work, /^Environment=PATH=\/srv\/ci\/bin:/m);
  assert.match(work, /^Environment=HOME=\/srv\/ci$/m);
  assert.match(shippedUnitText("acme-work-tick.timer", ACME) ?? "", /^Requires=acme-work-tick\.service$/m);
  assert.deepEqual(shippedUnits(SHIPPED_DIR, { projectUnitsDir: null, prefix: "acme-" }).filter((u) => u.endsWith(".service")),
    ["acme-board-report.service", "acme-shadow-window.service", "acme-work-tick.service", "acme-worktree-prune.service"], "the prefix names the tool's units");
  for (const text of [work, shippedScriptText("gh", ACME) ?? ""]) assert.doesNotMatch(text, /\/home\/agent/, "and none of a11ign's host survives");
  assert.match(shippedScriptText("gh", ACME) ?? "", /A11Y_GH_REAL:-\/srv\/ci\/bin\/gh-real/);
  const files = ownedIdentityFiles(ACME);
  assert.deepEqual(files.map((f) => f.target), ["/srv/ci/bin/gh", "/srv/ci/leads/workspaces.txt", "/srv/ci/workers/README.md"]);
  assert.equal(files[1].expected, "# acme's leads\n# x1 lead\nx1\n");
  assert.equal(leadsWorkspacesText(ACME_HOST), files[1].expected);
});

test("#2620: which spelling of the home is 'the person's' comes from host.json, not from a literal", () => {
  const root = mkdtempSync(join(tmpdir(), "host-human-2620-"));
  try {
    writeFileSync(join(root, "acme-job.service"), "[Service]\nExecStart=/usr/bin/true\nEnvironment=GH_CONFIG_DIR=/srv/ci/.config/gh\n");
    const shipped = { shippedDir: root, projectUnitsDir: null };
    const human = (deps: object) => identityDrift({ ...shipped, ...deps }).filter((f: { problem: string }) => f.problem === "DECLARES THE HUMAN ACCOUNT");
    assert.equal(human({ host: ACME_HOST, units: ACME_UNITS }).length, 1, "/srv/ci/.config/gh IS the person's on a host whose home is /srv/ci");
    assert.deepEqual(human({ units: ACME_UNITS }), [], "CONTROL: on a11ign's host the same line is somebody else's directory, so nothing is flagged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- 5. host-config's own refusals -----------------------------------------------------------------------------------------------------

const VALID_HOST = JSON.parse(readFileSync(join(checkout, ".agent-org/host.json"), "utf8"));
const refusalOf = (change: (h: Record<string, unknown>) => void) => {
  const copy = structuredClone(VALID_HOST);
  change(copy);
  try {
    parseHostConfig(JSON.stringify(copy), "fixture");
  } catch (error) {
    assert.ok(error instanceof HostConfigRefusal, String(error));
    return error.field;
  }
  return null;
};

test("#2620: host.json REFUSES, naming the field, and never defaults", () => {
  assert.equal(refusalOf(() => undefined), null, "MATCHED PAIR: the shipped declaration parses, so the refusals below are not blanket");
  assert.equal(refusalOf((h) => { delete h.home; }), "home");
  assert.equal(refusalOf((h) => { h.binDir = "relative/bin"; }), "binDir");
  assert.equal(refusalOf((h) => { (h.gh as Record<string, unknown>).workers = "/x/"; }), "gh.workers", "a trailing slash is two spellings of one path");
  assert.equal(refusalOf((h) => { h.schema = 2; }), "schema");
  assert.equal(refusalOf((h) => { h.primary = "nobody"; }), "primary");
  assert.equal(refusalOf((h) => { h.projects = []; }), "projects");
  assert.throws(() => parseUnitsDeclaration("{}", "fixture"), /`units`/);
  assert.throws(() => parseUnitsDeclaration(JSON.stringify({ units: { prefix: "a11ign-", boardReportWorkflow: "b.yml" } }), "fixture"), /units\.own/);
  assert.throws(() => renderTemplate("@@nowhere@@", templateValues(host, units)), /placeholder no value fills/);
});

test("#2620: the declaration is found through $AGENT_ORG_HOST, else beside the project's own", () => {
  assert.equal(hostConfigPath({ env: { AGENT_ORG_HOST: "/etc/agent-org/host.json" }, root: "/r" }), "/etc/agent-org/host.json");
  assert.equal(hostConfigPath({ env: {}, root: "/r" }), "/r/.agent-org/host.json");
  assert.equal(renderedName("work-tick.service.in", "acme-"), "acme-work-tick.service");
});

// --- 6. the board dispatcher reads the project, not a11ign ---------------------------------------------------------------------

const DISPATCH = join(SHIPPED_DIR, "board-report-dispatch.sh");

/** Run the dispatcher in `cwd` with a stub `gh` that records its arguments, one call per line. */
function dispatch(cwd: string) {
  const bin = mkdtempSync(join(tmpdir(), "dispatch-bin-2620-"));
  const log = join(bin, "calls");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in run) echo 4242;; esac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const done = spawnSync("bash", [DISPATCH], { cwd, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  rmSync(bin, { recursive: true, force: true });
  return { status: done.status, calls, stderr: done.stderr };
}

test("#2620: the dispatcher dispatches the workflow the project declares, on the repository it declares", () => {
  const home = dispatch(checkout);
  assert.equal(home.status, 0, home.stderr);
  assert.equal(home.calls[0], "workflow run board-report.yml --repo a11ign/a11ign", "a11ign's own values are unchanged");
  const root = mkdtempSync(join(tmpdir(), "dispatch-project-2620-"));
  try {
    mkdirSync(join(root, ".agent-org"));
    writeFileSync(join(root, ".agent-org/project.json"), JSON.stringify({ tracker: [{ repo: "acme/widgets" }], units: { boardReportWorkflow: "daily.yml" } }));
    const other = dispatch(root);
    assert.equal(other.status, 0, other.stderr);
    assert.equal(other.calls[0], "workflow run daily.yml --repo acme/widgets", "a fixture project changes both");
    writeFileSync(join(root, ".agent-org/project.json"), JSON.stringify({ tracker: [{ repo: "acme/widgets" }], units: {} }));
    const refused = dispatch(root);
    assert.notEqual(refused.status, 0, "a declaration that names no workflow FAILS the dispatch");
    assert.deepEqual(refused.calls, [], "and reaches `gh` never: a default would dispatch the wrong project's board");
    assert.match(refused.stderr, /does not declare workflow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
