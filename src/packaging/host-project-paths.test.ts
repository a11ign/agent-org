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
 * knows is now `.agent-org/host.json` (`host-config.ts` reads it), what a project knows is its `.agent-org/project.json`, and the tool's
 * three units and its `gh` wrapper are TEMPLATES rendered from the two.
 *
 * WHAT THIS FILE OWES, in the row's words: no home-directory literal in the tool's own files; a host's `host.json` reproducing every path
 * the tool used to name; the entries the host directory held classified exactly once (tool, project, host data) and an
 * unclassified one REFUSED; the three tool units rendered from templates to today's bytes; and a project with different paths changing what
 * the readers use. (#3233) THE PARTS THAT READ A11IGN'S LIVE TREE MOVED TO A11IGN -- its `host.json` saying those paths, its `.agent-org/units/` being the eight
 * `units.own` lists and naming what it names, `wake.ts`'s two constants equalling its `host.json` -- and what is left runs over a recorded host and project.
 * NO UNIT IS RENAMED AND NONE IS REINSTALLED BY THIS ROW: the rendered names are asserted equal to the installed ones,
 * and rows 4 and 5 (the shadow run and the extraction) are where an install happens.
 *
 * WHAT IT DOES NOT COVER, said so it cannot be read as covered. `wake.ts`, `work-gate.ts` and `lib/worktree-resolution.ts` still name
 * `/home/agent` (two constants and some prose); they belong to rows 3b and 3c, whose Regions those files are. That the constants equal a11ign's
 * `host.json` was asserted here until #3233, and is a11ign's to assert.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// --- (#3233) THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, AND A11IGN'S VALUES ARE A RECORDED HOST ---
//
// Two things in a11ign's tree fed this file: the project the tool serves (`HOME_CHECKOUT`, resolved at import, which the defaults of `host-units.ts` and
// `host-config.ts` read -- `package.json`, `.agent-org/units/`, `host.json`) and a11ign's own `host.json`, whose values the units are rendered from and whose
// bytes were pinned. A verdict that moved when a11ign edited either was not about this tool (agent-org #77 and #79). So the host file is set FIRST and the tool
// imported AFTER it, dynamically, over `fixtures/host-project-paths/project` copied to a temp directory; and a11ign's host values are `a11ign-host.json`, a
// recording passed to every call that renders from them. That a11ign's LIVE `host.json` says what the recording says is a11ign's invariant, and moved there.
const SCRATCH = mkdtempSync(join(tmpdir(), "host-project-paths-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const FIXTURES = fileURLToPath(new URL("./fixtures/host-project-paths/", import.meta.url));
const PROJECT = join(SCRATCH, "project");
cpSync(join(FIXTURES, "project"), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SHIPPED_DIR, TOOL_ENTRIES, HOST_DATA_ENTRIES, hostUnitDrift, identityDrift, leadsListText, ownedIdentityFiles, shippedScriptText, shippedUnitText, shippedUnits,
  unclassifiedEntries } = await import("../host-units.ts");
const { HostConfigRefusal, hostConfigPath, leadsWorkspacesText, parseHostConfig, parseUnitsDeclaration, readUnitsDeclaration, renderTemplate, renderedName, templateValues } =
  await import("../host-config.ts");

/** a11ign's host values, RECORDED: what the templates are rendered from, with no `tool` (the cut, #2974): the tool form is asserted in `host-tool-install.test.ts`. */
const A11IGN_TEXT = readFileSync(join(FIXTURES, "a11ign-host.json"), "utf8");
const host = parseHostConfig(A11IGN_TEXT, "fixtures/host-project-paths/a11ign-host.json");
const units = readUnitsDeclaration(PROJECT);
const plainHost = host as never;
/** The directory the tool's own sources sit in, read from this file's location and never from a project's layout. */
const TOOL_SRC = fileURLToPath(new URL("../", import.meta.url));

/** A home-directory path, however it continues: what "the tool names a host" means in text. */
const HOME_LITERAL = /\/home\/[A-Za-z_][\w.-]*/;

/** The three files of the tool's own source this row edited, and every entry of the tool's host directory. */
const TOOL_SOURCES = ["host-units.ts", "host-config.ts", "board-snapshot-scope.ts"];
const toolFiles = () => [...TOOL_SOURCES.map((name) => join(TOOL_SRC, name)), ...TOOL_ENTRIES.map((name) => join(SHIPPED_DIR, name))];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// --- 1. no home literal in the tool's own files ------------------------------------------------------------------------------------

test("#2620: no home-directory literal remains in the tool's sources, its templates or its scripts", () => {
  const files = toolFiles();
  assert.equal(files.length, 3 + 28, "POSITIVE CONTROL: thirty-one files are scanned (three sources, twenty-eight host entries -- the trace store's clock pair, a11ign/agent-org#498, the two the shadow window added, #2867, the two chairman-watch templates, #2901, the listener's, #2907, the agent-org launcher, #3532, the weekly report's pair and script, a11ign/a11ign#3627, the trace pages' pair, a11ign/a11ign#3515, the /tmp janitor's pair and tmpfiles rule, a11ign/a11ign#3849, the OTel receiver's service, a11ign/a11ign#4071, and the kernel reboot's pair, a11ign/a11ign#4053, included), so an emptiness below is not a scan of nothing, the `claude` seat wrapper, a11ign#4823");
  const offenders = files.filter((file) => HOME_LITERAL.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "each of these names a host path the tool must read from host.json instead");
});

test("#2620: the scan CAN see the literal -- the matcher matches a plain path, and a unit that names its host is found by it", () => {
  // (#3233) The project's own four services naming `/home/agent` was a reading of a11ign's `.agent-org/units/`; it is a11ign's invariant now. The control the
  // scan needs is the matcher itself, on text that carries the literal and on text that does not.
  assert.match("Environment=HOME=/home/agent", HOME_LITERAL);
  assert.match("Environment=GH_CONFIG_DIR=/home/other-user/workers/gh", HOME_LITERAL);
  assert.doesNotMatch("Environment=HOME=%h\nWorkingDirectory=@@checkout@@", HOME_LITERAL, "a template that names no host is not flagged");
});

// --- 2. a host's values are what the templates render from, and the rendered text is today's ----------------------------------------

test("#2620: a host.json's values are what `templateValues` hands the templates, and the recorded a11ign host reproduces every path the tool used to hard-code", () => {
  assert.deepEqual(templateValues(host, units), {
    home: "/home/agent", binDir: "/home/agent/.local/bin", checkout: "/home/agent/repos/a11y-witness",
    workersDir: "/home/agent/workers", leadsDir: "/home/agent/leads", prefix: "a11ign-",
  });
  assert.deepEqual(host.gh.leadsWorkspaces.map((w) => w.id), ["w6", "w2", "w5"], "the leads list is the file it replaced");
});

// Sha-256 of the texts as they stood at commit 1b5176697, BEFORE the row: the bytes `host:check` compares the live host against. A
// rendering that differs by one byte reports every installed unit STALE, so this is the guard on "a11ign's values are unchanged" -- FOR THE RECORDED VALUES.
const TODAYS_TEXT = {
  // #2781 MOVED THIS ONE, deliberately: the unit gained a comment saying the `-` on `primary:update` is covered by the gate reading the primary.
  // #2974 MOVED THIS ONE, deliberately: the cut-over moved its `primary:update` line from `/usr/bin/npm` to the pnpm shim and its header comment off the monorepo path (`units-run-pnpm.test.ts`).
  // #3038 MOVED THIS ONE, deliberately: `ExecStart` runs under the crash-exit preload and the header says why `SuccessExitStatus` lists 1.
  // #4389 MOVED THIS ONE, deliberately: `ExecStart` runs `%h/.local/bin/node` on the `.ts` with no `--import tsx`; the host Node strips the types itself.
  "a11ign-work-tick.service": "6f128077955f11e824ec1956fc377ed1944f85590a70e387672c7756c56c68b9",
  "a11ign-work-tick.timer": "7daa5c14c8c1db69424b7f5dfac22c8168858f2fd9f8eaaa95530a07b3e0b931",
  // #2782 MOVED THIS ONE, deliberately: the prune unit now declares `GH_CONFIG_DIR` (it reads a row's claim before removing a tree). The
  // installed copy reads STALE until `host:install` runs, which is a host action and not this row's.
  // #2892 MOVED IT AGAIN, deliberately: `ExecStart` runs `%h/.local/bin/pnpm` instead of `/usr/bin/npm`. Same staleness, same remedy.
  // #3850 MOVED IT AGAIN, deliberately: the unit runs under `Nice=19` and `IOSchedulingClass=idle`. Same staleness, same remedy.
  "a11ign-worktree-prune.service": "d7547daa8e26f8e16979769f20abdbd22e1626d0e50030d2d4aee63326d5a879",
  "a11ign-worktree-prune.timer": "82d72dd99d18eddb5285245bc4f5b9b750b1e88536be7759cdc524d9b1cbe467",
  "a11ign-board-report.service": "3e7791d9f24ae9aa3519898259f1ea68c1f8b4cd721f97b62916c9f81835b0c1",
  "a11ign-board-report.timer": "6edd74ab8a7d4117197dddd448e30a2ab63ab9972799dd90f5f500c067f033f1",
};
// #3466 MOVED THIS ONE, deliberately: the wrapper records every call in `gh-calls.tsv` and no longer `exec`s gh-real. The installed copy reads
// DIVERGED until `host:install` runs, which is a host action and not this row's.
// a11ign/a11ign#3589 MOVED IT AGAIN, deliberately: each ledger line gains a ninth field, the session id (`CLAUDE_CODE_SESSION_ID`, else `CODEX_THREAD_ID`). Same staleness, same remedy.
// #3642 MOVED IT AGAIN, deliberately: a call with no workspace id and no GH_CONFIG_DIR refuses instead of acting as the human account. Same staleness, same remedy.
// a11ign/a11ign#4148 MOVED IT AGAIN, deliberately: the wrapper answers an identical repeated READ from a cache (20 s, 30 at most), serves the tick's own processes from the generation `tick-snapshot.ts` keeps, and counts what the ledger trim drops into `<ledger>.hourly`. Same staleness, same remedy.
// a11ign/a11ign#4397 MOVED IT AGAIN, deliberately: `gh pr create` is refused unless `A11Y_PR_OPEN` is set (only `pr:open` sets it). Same staleness, same remedy.
// a11ign/a11ign#4148 part 6 MOVED IT AGAIN, deliberately: `auth git-credential` and an `api` call naming GET no longer drop the read cache, and a write drops only its own repository's entries. Same staleness, same remedy.
// agent-org#486 MOVED IT AGAIN, deliberately: `issue comment`, `pr comment` and `pr review` get a trailing `<!-- decided-by: <role> run: <id> -->` line. Same staleness, same remedy.
const TODAYS_GH_WRAPPER = "a5c6b093f1aef6aa302b3e425ce37f4426c519b396d7f57947ce73164096f37a";
// #2896 MOVED THIS ONE, deliberately: the recorded host's header says `pnpm run host:install` / `pnpm run host:check` where it said `npm run`.
const TODAYS_LEADS_LIST = "dbca070c4bb7934ff1e9cdc9505f9edee638d98fcff10963b18d5d3a743770a2";

test("#2620: the three tool units, the wrapper and the leads list render to TODAY'S text for the recorded a11ign values", () => {
  assert.equal(Object.keys(TODAYS_TEXT).length, 6, "POSITIVE CONTROL: six units (three services, three timers), not a subset");
  const rendering = { host: plainHost, units, projectUnitsDir: null };
  for (const [unit, digest] of Object.entries(TODAYS_TEXT)) {
    assert.equal(sha256(shippedUnitText(unit, rendering) ?? ""), digest, `${unit} is not byte-identical to the unit the host runs`);
  }
  assert.equal(sha256(shippedScriptText("gh", rendering) ?? ""), TODAYS_GH_WRAPPER, "the wrapper installed at ~/.local/bin/gh");
  assert.equal(sha256(leadsListText(rendering)), TODAYS_LEADS_LIST, "the leads list installed at ~/leads/workspaces.txt");
});

test("#2620: NO UNIT IS RENAMED -- the tool's units carry the names they had, and the shadow window's two (#2867)", () => {
  // `declaredKeys` handed, so the optional chairman-messaging trio (#2901) is not this population whether or not a project asks for it (#3142), and `projectUnitsDir:
  // null`, so only the TOOL'S templates are named: what a11ign's own eight units are called (`.agent-org/units/`) is a11ign's to pin (#3233).
  assert.deepEqual(shippedUnits(SHIPPED_DIR, { projectUnitsDir: null, prefix: "a11ign-", declaredKeys: new Set(["causes", "units"]) }), [
    "a11ign-board-report.service", "a11ign-board-report.timer",
    "a11ign-kernel-reboot.service", "a11ign-kernel-reboot.timer",
    "a11ign-otel-receiver.service",
    "a11ign-shadow-window.service", "a11ign-shadow-window.timer",
    "a11ign-tmp-prune.service", "a11ign-tmp-prune.timer",
    "a11ign-trace-ingest.service", "a11ign-trace-ingest.timer",
    "a11ign-trace-publish.service", "a11ign-trace-publish.timer",
    "a11ign-trace-weekly.service", "a11ign-trace-weekly.timer",
    "a11ign-work-tick.service", "a11ign-work-tick.timer",
    "a11ign-worktree-prune.service", "a11ign-worktree-prune.timer",
  ]);
});

// --- 3. the tool's own entries are classified ---------------------------------------------------------------------------------------

test("#2620: the tool's 28 entries are classified -- the original 8, the trace store's clock pair (a11ign/agent-org#498), the shadow window's two (#2867), the chairman watcher's two (#2901), the listener's one (#2907), the agent-org launcher (#3532) the weekly report's three (a11ign/a11ign#3627) the trace pages' two (a11ign/a11ign#3515) the /tmp janitor's three (a11ign/a11ign#3849) the OTel receiver's one (a11ign/a11ign#4071) the kernel reboot's two (a11ign/a11ign#4053) and the `claude` seat wrapper (a11ign#4823) -- and the host-data entry is host.json's, not a file", () => {
  // (#3233) The row also counted eight entries in the PROJECT's `.agent-org/units/` and asserted them equal to a11ign's `units.own`: that is a11ign's tree, and moved there.
  const inTool = readdirSync(SHIPPED_DIR).sort();
  const hostData = Object.keys(HOST_DATA_ENTRIES);
  const shadowPair = inTool.filter((name) => name.startsWith("shadow-window."));
  assert.equal(shadowPair.length, 2, "POSITIVE CONTROL: #2867's pair is two of them, so the 8 below is the original eight and the pair");
  const chairmanPair = inTool.filter((name) => name.startsWith("chairman-watch."));
  assert.equal(chairmanPair.length, 2, "POSITIVE CONTROL: #2901's optional pair is two more, so the 8 below is still the original eight");
  const chairmanListener = inTool.filter((name) => name === "chairman-listen.service.in");
  assert.equal(chairmanListener.length, 1, "POSITIVE CONTROL: #2907's listener service is one more, with no timer, so the 8 below is still the original eight");
  const agentOrgLauncher = inTool.filter((name) => name === "agent-org");
  assert.equal(agentOrgLauncher.length, 1, "POSITIVE CONTROL: #3532's launcher is one more, copied to binDir, so the 8 below is still the original eight");
  const traceWeekly = inTool.filter((name) => name.startsWith("trace-weekly"));
  assert.equal(traceWeekly.length, 3, "POSITIVE CONTROL: a11ign/a11ign#3627's pair and its script are three more, so the 8 below is still the original eight");
  const traceIngest = inTool.filter((name) => name.startsWith("trace-ingest"));
  assert.equal(traceIngest.length, 2, "POSITIVE CONTROL: a11ign/agent-org#498's pair is two more, so the 8 below is still the original eight");
  const tracePublish = inTool.filter((name) => name.startsWith("trace-publish"));
  assert.equal(tracePublish.length, 2, "POSITIVE CONTROL: a11ign/a11ign#3515's pair is two more, so the 8 below is still the original eight");
  const tmpJanitor = inTool.filter((name) => name.startsWith("tmp-prune.") || name === "a11ign-tmp.tmpfiles.conf.in");
  assert.equal(tmpJanitor.length, 3, "POSITIVE CONTROL: a11ign/a11ign#3849's pair and its tmpfiles rule are three more, so the 8 below is still the original eight");
  const otelReceiver = inTool.filter((name) => name === "otel-receiver.service.in");
  assert.equal(otelReceiver.length, 1, "POSITIVE CONTROL: a11ign/a11ign#4071's service is one more, with no timer, so the 8 below is still the original eight");
  const kernelReboot = inTool.filter((name) => name.startsWith("kernel-reboot."));
  assert.equal(kernelReboot.length, 2, "POSITIVE CONTROL: a11ign/a11ign#4053's pair is two more, so the 8 below is still the original eight");
  const seatWrapper = inTool.filter((name) => name === "claude");
  assert.equal(seatWrapper.length, 1, "POSITIVE CONTROL: a11ign#4823's wrapper is one more, copied to the first PATH directory and not binDir, so the 8 below is still the original eight");
  assert.equal(inTool.length - shadowPair.length - chairmanPair.length - chairmanListener.length - agentOrgLauncher.length - traceWeekly.length - traceIngest.length - tracePublish.length - tmpJanitor.length - otelReceiver.length - kernelReboot.length - seatWrapper.length, 8, "POSITIVE CONTROL: eight entries stay in the tool's host directory");
  assert.equal(hostData.length, 1, "POSITIVE CONTROL: one is host data");
  assert.deepEqual(inTool, [...TOOL_ENTRIES].sort(), "the tool's directory holds exactly what the tool records");
  for (const name of hostData) assert.ok(!existsSync(join(SHIPPED_DIR, name)), `${name} is host.json's now, not a file`);
  assert.deepEqual(unclassifiedEntries({ shippedDir: SHIPPED_DIR, projectUnitsDir: null, units, host: plainHost }), [], "and nothing in it is classified nowhere");
});

/** A tool directory and a project directory holding exactly the classified entries (the tool's, and the fixture project's declared `units.own`), in a temp directory. */
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

test("#2620: an entry classified nowhere is REFUSED, in either directory, and the classified fixture reads clean", () => {
  const { root, tool, project, deps } = classifiedFixture();
  try {
    assert.deepEqual(unclassifiedEntries(deps), [], "MATCHED PAIR: exactly the classified entries read clean, so the refusal below is not a check that always fires");
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

test("#2620: `host:check` carries the refusal -- an unclassified entry is a FINDING, and the clean fixture has none", () => {
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
  assert.deepEqual(shippedUnits(SHIPPED_DIR, { projectUnitsDir: null, prefix: "acme-", declaredKeys: new Set() }).filter((u) => u.endsWith(".service")),
    ["acme-board-report.service", "acme-kernel-reboot.service", "acme-otel-receiver.service", "acme-shadow-window.service", "acme-tmp-prune.service", "acme-trace-ingest.service", "acme-trace-publish.service", "acme-trace-weekly.service", "acme-work-tick.service", "acme-worktree-prune.service"], "the prefix names the tool's units");
  for (const text of [work, shippedScriptText("gh", ACME) ?? ""]) assert.doesNotMatch(text, /\/home\/agent/, "and none of a11ign's host survives");
  assert.match(shippedScriptText("gh", ACME) ?? "", /A11Y_GH_REAL:-\/srv\/ci\/bin\/gh-real/);
  const files = ownedIdentityFiles(ACME);
  assert.deepEqual(files.map((f) => f.target), ["/srv/ci/bin/gh", "/srv/ci/.opencode/bin/claude", "/srv/ci/leads/workspaces.txt", "/srv/ci/workers/README.md"]);
  assert.equal(files[2].expected, "# acme's leads\n# x1 lead\nx1\n");
  assert.equal(leadsWorkspacesText(ACME_HOST), files[2].expected);
});

test("#2620: which spelling of the home is 'the person's' comes from host.json, not from a literal", () => {
  const root = mkdtempSync(join(tmpdir(), "host-human-2620-"));
  try {
    writeFileSync(join(root, "acme-job.service"), "[Service]\nExecStart=/usr/bin/true\nEnvironment=GH_CONFIG_DIR=/srv/ci/.config/gh\n");
    const shipped = { shippedDir: root, projectUnitsDir: null };
    const human = (deps: object) => identityDrift({ ...shipped, ...deps }).filter((f: { problem: string }) => f.problem === "DECLARES THE HUMAN ACCOUNT");
    assert.equal(human({ host: ACME_HOST, units: ACME_UNITS }).length, 1, "/srv/ci/.config/gh IS the person's on a host whose home is /srv/ci");
    assert.deepEqual(human({ host: plainHost, units: ACME_UNITS }), [], "CONTROL: on the recorded a11ign host (home /home/agent) the same line is somebody else's directory, so nothing is flagged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- 5. host-config's own refusals -----------------------------------------------------------------------------------------------------

const VALID_HOST = JSON.parse(A11IGN_TEXT);
const refusalOf = (change: (h: Record<string, unknown>) => void) => {
  const copy = structuredClone(VALID_HOST);
  change(copy);
  try {
    parseHostConfig(JSON.stringify(copy), "fixture");
  } catch (error) {
    assert.ok(error instanceof HostConfigRefusal, String(error));
    return (error as any).field;
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
  // (#3233) The first assertion here ran the dispatcher in a11ign's checkout and expected `board-report.yml` on `a11ign/a11ign`: a11ign's declaration, not the tool's.
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
