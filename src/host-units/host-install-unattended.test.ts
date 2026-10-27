// no-token: gh -- nothing here reaches a real `gh`, `systemctl` or the host's own directories: every shipped directory, installed directory, bin directory and home is a temp directory this file
// builds, and `systemctl` is a function that remembers what it was told.
/**
 * A11-354: THE ORG INSTALLS WHAT A RELEASE SHIPS TO THE HOST ITSELF.
 *
 * On 2026-10-27 A11-348's `tmp-prune` unit shipped and the host kept running the copy of 2026-10-17, because `host:install` is refused in a ticket run and nothing else ran it; `host:check`
 * listed the launcher, the workers README and the reviewers' door as DIVERGED or DRIFTED the same day. `update` now runs the install after every update (`install/update.test.ts`), and this file
 * is the install it runs:
 *
 *  1. A release that ships a CHANGED unit: after the unattended install the installed unit is the release's, the copy it replaced is kept beside it as `.bak-<stamp>`, the changed lines are said,
 *     and the changed timer is restarted. A second pass over the same host writes nothing and runs no `systemctl`.
 *  2. What a person decides stays a finding: a unit installed and `disabled` is not enabled, an orphan is not removed, and a unit that was not installed before IS started.
 *  3. A launcher or workers README edited by hand is kept beside the new copy, the diff is said, a copy of the same text is not kept twice, and a file already current is not written.
 *  4. A host that runs the installed tool reports no `host-install-pending` for host.json's stale `tool` checkout, and never reads that checkout; one that runs the checkout still does.
 *  5. A step that fails is said and does not keep the next from running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../packaging/host-units-project.ts"; // FIRST of the tool imports: it makes a fixture project the tool's before `host-units.ts` resolves one (#3233)
import { SHIPPED_DIR, shippedScriptText, shippedUnitText } from "./shipped-unit-texts-and-declarations.ts";
import { hostInstallPending, hostInstallUnattended, hostUnitsInstall, hostUnitsUpkeep, missingUnitPrograms } from "../host-units.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { hostIdentityInstall } from "./gh-wrapper-and-notes.ts";
import { parseHostConfig } from "../host-config.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { updateFixture } from "../install/update-fixture.ts";
import { update } from "../install/update.ts";
import { currentVersionName } from "../install/tool-install.ts";

const UNITS = { prefix: "a11ign-", boardReportWorkflow: "board-report.yml", own: [] as string[] };
const SERVICE = "a11ign-tmp-prune.service";
const TIMER = "a11ign-tmp-prune.timer";
const TEMPLATES = ["tmp-prune.service.in", "tmp-prune.timer.in"];

const hostJson = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
const hostWith = (extra: Record<string, unknown> = {}) => parseHostConfig(JSON.stringify({ ...hostJson(), ...extra }), "host-install-unattended test host.json");

/** A shipped directory holding the tmp-prune pair's templates, an installed directory, and a `systemctl` that remembers what it was told. */
function hostFixture() {
  const root = realpathSync(tmpDir("host-install-354-"));
  const [shippedDir, installedDir] = [join(root, "host"), join(root, ".config/systemd/user")];
  mkdirSync(shippedDir, { recursive: true });
  mkdirSync(installedDir, { recursive: true });
  for (const template of TEMPLATES) copyFileSync(join(SHIPPED_DIR, template), join(shippedDir, template));
  const host = hostWith();
  const calls: string[][] = [];
  const said: string[] = [];
  const deps = { shippedDir, installedDir, host, units: UNITS, projectUnitsDir: null, declaredKeys: new Set<string>(), git: () => "",
    systemctl: (args: string[]) => { calls.push(args); return ""; }, out: (line: string) => { said.push(line); } };
  const install = (over: Record<string, unknown> = {}) => hostUnitsInstall({ ...deps, ...over } as never);
  const upkeep = (over: Record<string, unknown> = {}) => hostUnitsUpkeep({ ...deps, ...over } as never);
  const release = (unit: string) => shippedUnitText(unit, { shippedDir, host, units: UNITS, projectUnitsDir: null }) ?? "";
  const installedNames = () => readdirSync(installedDir).sort();
  return { root, installedDir, calls, said, install, upkeep, release, installedNames };
}

test("A11-354: a release that ships a changed unit is installed unattended: the unit matches the release, the old copy is kept, the change is said, and the timer is restarted", () => {
  const f = hostFixture();
  const stale = f.release(SERVICE).replace(/^Description=.*$/m, "Description=a11ign: the 2026-10-17 copy of the janitor");
  assert.notEqual(stale, f.release(SERVICE), "POSITIVE CONTROL: the host's copy differs from the release's");
  writeFileSync(join(f.installedDir, SERVICE), stale);
  writeFileSync(join(f.installedDir, TIMER), f.release(TIMER));

  f.upkeep();

  assert.equal(readFileSync(join(f.installedDir, SERVICE), "utf8"), f.release(SERVICE), "the installed unit is the release's");
  const kept = f.installedNames().filter((name) => name.startsWith(`${SERVICE}.bak-`));
  assert.equal(kept.length, 1, "the copy it replaced is kept beside the new one");
  assert.equal(readFileSync(join(f.installedDir, kept[0]), "utf8"), stale, "and it is the copy that was there");
  assert.deepEqual(f.installedNames().filter((name) => name.startsWith(`${TIMER}.bak-`)), [], "the timer was current: nothing of it is kept");
  assert.ok(f.said.some((line) => line.includes("- Description=a11ign: the 2026-10-17 copy of the janitor")), "the line that went is logged");
  assert.ok(f.said.some((line) => /\+ Description=a11ign: remove old test fixtures and day-old entries/.test(line)), "and the line that came");
  assert.deepEqual(f.calls, [["daemon-reload"]], "the manager reads the unit, and nothing is enabled or started: the service has no timer-side change to restart");
});

test("A11-354: a changed timer is restarted, an installed timer is never enabled, and a pass over a host that is current writes nothing and runs no systemctl", () => {
  const f = hostFixture();
  writeFileSync(join(f.installedDir, SERVICE), f.release(SERVICE));
  writeFileSync(join(f.installedDir, TIMER), f.release(TIMER).replace("OnUnitInactiveSec=1min", "OnUnitInactiveSec=10min"));

  f.upkeep();
  assert.equal(readFileSync(join(f.installedDir, TIMER), "utf8"), f.release(TIMER));
  assert.deepEqual(f.calls, [["daemon-reload"], ["try-restart", TIMER]], "the timer that ran the old schedule runs the new one; `disabled` is somebody's decision and `enable` is not run");

  f.calls.length = 0;
  f.said.length = 0;
  const before = f.installedNames();
  f.upkeep();
  assert.deepEqual([f.calls, f.said, f.installedNames()], [[], [], before], "a second pass finds nothing to do: no systemctl, no line, no file");
});

test("A11-354: a unit that was not installed before is enabled and started, and a unit nothing ships any more is left for the person", () => {
  const f = hostFixture();
  writeFileSync(join(f.installedDir, "a11ign-retired.timer"), "[Timer]\n");

  f.upkeep();

  assert.deepEqual([f.release(SERVICE), f.release(TIMER)], [SERVICE, TIMER].map((unit) => readFileSync(join(f.installedDir, unit), "utf8")), "both units of the release are installed");
  assert.deepEqual(f.calls.filter((call) => call[0] === "enable"), [["enable", "--now", TIMER]], "the new timer is the one enabled");
  assert.ok(existsSync(join(f.installedDir, "a11ign-retired.timer")), "the orphan is still there");
  assert.deepEqual(f.calls.filter((call) => call[0] === "disable"), [], "and was not disabled");
});

test("A11-354: a person's `host:install` keeps a replaced unit beside the new copy too, and still removes an orphan", () => {
  const f = hostFixture();
  writeFileSync(join(f.installedDir, SERVICE), "[Service]\nExecStart=/bin/false\n");
  writeFileSync(join(f.installedDir, "a11ign-retired.timer"), "[Timer]\n");
  f.install({ git: () => "a11ign-retired.timer" });
  assert.equal(readFileSync(join(f.installedDir, SERVICE), "utf8"), f.release(SERVICE));
  assert.equal(f.installedNames().filter((name) => name.startsWith(`${SERVICE}.bak-`)).length, 1);
});

// --- the identity files: the launcher and the workers README ------------------------------------------------------------------------------

/** A host with a scratch home and a bin directory holding the launcher a person edited by hand, and a workers directory holding the README they edited. */
function identityFixture() {
  const root = realpathSync(tmpDir("identity-354-"));
  const [binDir, workersDir, leadsDir] = [join(root, "bin"), join(root, "workers"), join(root, "leads")];
  for (const dir of [binDir, workersDir, leadsDir]) mkdirSync(dir, { recursive: true });
  const host = { ...hostWith(), home: join(root, "home"), binDir, tool: join(root, "checkout") };
  const said: string[] = [];
  const where = { host, env: {}, scriptDir: binDir, workersDir, leadsDir, out: (line: string) => { said.push(line); } };
  const launcher = join(binDir, "agent-org");
  const readme = join(workersDir, "README.md");
  const install = (over: Record<string, unknown> = {}) => hostIdentityInstall({ ...where, ...over } as never);
  const kept = (target: string) => readdirSync(join(target, "..")).filter((name) => name.startsWith(`${target.split("/").at(-1)}.bak-`));
  return { launcher, readme, said, install, kept, where };
}

test("A11-354: a launcher and a workers README edited by hand are replaced by the release's, kept beside the new copy, and the diff is said", () => {
  const f = identityFixture();
  const edited = "#!/bin/sh\n# edited by hand on the host\nexec node \"/home/agent/repos/agent-org/src/bin.ts\" \"$@\"\n";
  writeFileSync(f.launcher, edited);
  writeFileSync(f.readme, "# workers\nthe 2026-10-17 README\n");

  const written = f.install({ onlyChanged: true });

  assert.ok(written.includes(f.launcher) && written.includes(f.readme), "both are rewritten");
  assert.equal(readFileSync(f.launcher, "utf8"), shippedScriptText("agent-org", { host: { ...hostWith(), tool: f.where.host.tool, home: f.where.host.home, binDir: f.where.host.binDir } as never, env: {} }), "the launcher is the release's");
  assert.deepEqual(f.kept(f.launcher).map((name) => readFileSync(join(f.launcher, "..", name), "utf8")), [edited], "the hand-edited launcher is kept beside it");
  assert.deepEqual(f.kept(f.readme).map((name) => readFileSync(join(f.readme, "..", name), "utf8")), ["# workers\nthe 2026-10-17 README\n"], "and so is the README");
  assert.ok(f.said.some((line) => line.includes(f.launcher) && line.includes("- # edited by hand on the host")), "the line the host copy had is logged");
  assert.ok(f.said.some((line) => line.includes(f.readme) && line.includes("- the 2026-10-17 README")), "for the README too");
});

test("A11-354: a copy of the same text is not kept twice, and a file that is already current is not written", () => {
  const f = identityFixture();
  const edited = "#!/bin/sh\n# edited by hand\n";
  writeFileSync(f.launcher, edited);
  f.install({ onlyChanged: true });
  writeFileSync(f.launcher, edited);
  f.install({ onlyChanged: true });
  assert.equal(f.kept(f.launcher).length, 1, "the same edit twice leaves one copy");

  f.said.length = 0;
  assert.deepEqual(f.install({ onlyChanged: true }), [], "with every file current an unattended pass writes none");
  assert.deepEqual(f.said, [], "and says nothing");
  assert.ok(f.install().includes(f.launcher), "NEGATIVE CONTROL: a person's install without `onlyChanged` still rewrites a current file");
});

// --- host-install-pending ---------------------------------------------------------------------------------------------------------------------

/** A host whose `tool` is a checkout that is not there, with or without the installed tool's `current` link under its home. */
function pendingFixture(installedTool: boolean) {
  const home = realpathSync(tmpDir("pending-354-"));
  if (installedTool) {
    mkdirSync(join(home, ".agent-org/tool/current/src"), { recursive: true });
    writeFileSync(join(home, ".agent-org/tool/current/src/bin.ts"), "");
  }
  const asked: string[][] = [];
  const run = (args: string[]) => { asked.push(args); return ""; };
  const findings = hostInstallPending({ host: { ...hostWith(), home, tool: "/stale/checkout" } as never, env: {}, units: UNITS, installedDir: join(home, "units"), run, readDir: (() => []) as never,
    read: (() => { throw new Error("nothing to read"); }) as never });
  return { findings, asked };
}

test("A11-354: a host that runs the installed tool never asks the stale tool checkout whether an install is pending", () => {
  const withTool = pendingFixture(true);
  assert.deepEqual([withTool.findings, withTool.asked], [[], []], "no finding, and git is not asked about /stale/checkout");
  assert.ok(pendingFixture(false).asked.length > 0, "NEGATIVE CONTROL: a host that runs the checkout still asks it, so the silence above is the installed tool's doing");
});

// --- the steps are independent -----------------------------------------------------------------------------------------------------------------

test("A11-354: a step that fails is said and does not keep the next from running", () => {
  const ran: string[] = [];
  const said: string[] = [];
  const failed = hostInstallUnattended({
    steps: [{ name: "the gh wrapper", run: () => { throw new Error("the wrapper names no App"); } }, { name: "the units", run: () => { ran.push("units"); } }],
    err: (line) => { said.push(line); },
  });
  assert.deepEqual(ran, ["units"], "the step after the failure ran");
  assert.deepEqual(failed, ["COULD NOT INSTALL the gh wrapper: the wrapper names no App"]);
  assert.deepEqual(said, failed, "and the failure is said");
});

// --- the update runs it, from the release that is current --------------------------------------------------------------------------------------

/** A release's `host/` directory: the tmp-prune pair, the service with `description` as its Description. */
function shipsUnits(description: string): Record<string, string> {
  const [service, timer] = TEMPLATES.map((template) => readFileSync(join(SHIPPED_DIR, template), "utf8"));
  return { "host/tmp-prune.service.in": service.replace(/^Description=.*$/m, `Description=${description}`), "host/tmp-prune.timer.in": timer };
}

test("A11-354: after an update to a release that ships a changed user unit, the installed unit matches the release, and the old copy is kept", () => {
  const f = updateFixture({ states: {} });
  const installedDir = join(f.home, ".config/systemd/user");
  const host = hostWith();
  const manager: string[][] = [];
  /** What `update` runs after it: the unattended install, reading the units from the release `current` names at the moment it runs. */
  const hostInstall = () => {
    const out: string[] = [];
    const shippedDir = join(f.tool, "current", "host");
    hostUnitsUpkeep({ shippedDir, installedDir, host, units: UNITS, projectUnitsDir: null, declaredKeys: new Set<string>(), git: () => "",
      systemctl: (args: string[]) => { manager.push(args); return ""; }, out: (line: string) => { out.push(line); } } as never);
    return { said: out.join("").split("\n").filter((line) => line !== ""), failed: [] };
  };
  const rendered = (unit: string) => shippedUnitText(unit, { shippedDir: join(f.tool, "current", "host"), host, units: UNITS, projectUnitsDir: null }) ?? "";
  const onDisk = (unit: string) => readFileSync(join(installedDir, unit), "utf8");

  f.release("0.1.0", "a fix", { files: shipsUnits("a11ign: the janitor of 0.1.0") });
  update({ version: "v0.1.0", channel: "release" }, f.deps({ hostInstall }));
  const first = rendered(SERVICE);
  assert.equal(onDisk(SERVICE), first, "the first release's unit is installed");
  assert.deepEqual(manager.filter((call) => call[0] === "enable"), [["enable", "--now", TIMER]], "and its timer, which was not installed before, is started");

  f.runFromVersion("v0.1.0");
  f.release("0.2.0", "the janitor changes", { files: shipsUnits("a11ign: the janitor of 0.2.0") });
  f.said.length = 0;
  manager.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ hostInstall })), true);

  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.notEqual(rendered(SERVICE), first, "POSITIVE CONTROL: the release ships a unit that is not the one on the host");
  assert.equal(onDisk(SERVICE), rendered(SERVICE), "after the update the installed unit matches the release");
  assert.equal(readdirSync(installedDir).filter((name) => name.startsWith(`${SERVICE}.bak-`)).map((name) => readFileSync(join(installedDir, name), "utf8")).join(), first, "the unit it replaced is kept beside it");
  assert.ok(f.said.includes(`agent-org update: installed ${SERVICE}`), f.said.join("\n"));
  assert.deepEqual(manager, [["daemon-reload"]], "the manager reads the new unit; the timer was current, so it is not restarted, and nothing is enabled");

  f.said.length = 0;
  manager.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ hostInstall })), false, "nothing is newer");
  assert.deepEqual(manager, [], "and the install that follows it writes nothing and runs no systemctl");
  assert.deepEqual(f.said.filter((line) => line.includes("installed")), []);
});

test("A11-354: the install runs after the move, when nothing is newer, and when the build failed, and each time from the release that is current", () => {
  const f = updateFixture({ states: {} });
  const currents: Array<string | null> = [];
  const hostInstall = () => { currents.push(currentVersionName(f.tool)); return { said: [], failed: [] }; };
  f.release("0.1.0");
  update({ version: "v0.1.0", channel: "release" }, f.deps({ hostInstall }));
  f.runFromVersion("v0.1.0");
  update({ version: undefined, channel: "release" }, f.deps({ hostInstall }));
  f.release("0.2.0");
  f.state.failBuild = true;
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps({ hostInstall })), /building it failed/);
  f.state.failBuild = false;
  update({ version: undefined, channel: "release" }, f.deps({ hostInstall }));
  assert.deepEqual(currents, ["v0.1.0", "v0.1.0", "v0.1.0", "v0.2.0"], "after the first install, with nothing newer, after a build that failed (the host keeps what is current), and after the move");
});

test("A11-354: what the install said is the update's log, and a failure is an error line that fails neither the move nor the update", () => {
  const f = updateFixture({ states: {} });
  f.release("0.1.0");
  const hostInstall = () => ({ said: [`installed ${SERVICE}`], failed: ["COULD NOT INSTALL the reviewers' door: install-reviewer-bin: source is missing"] });
  assert.equal(update({ version: "v0.1.0", channel: "release" }, f.deps({ hostInstall })), true);
  assert.ok(f.said.includes(`agent-org update: installed ${SERVICE}`));
  assert.deepEqual(f.errors, ["agent-org update: COULD NOT INSTALL the reviewers' door: install-reviewer-bin: source is missing"]);
  assert.equal(currentVersionName(f.tool), "v0.1.0", "the tool moved");
});

// --- what a review of the first version found -------------------------------------------------------------------------------------------------

test("A11-354: a manager that fails after the files were written puts them back, so the next pass writes them again and tries again", () => {
  const f = hostFixture();
  const stale = f.release(SERVICE).replace(/^Description=.*$/m, "Description=a11ign: the old janitor");
  writeFileSync(join(f.installedDir, SERVICE), stale);
  const failing = (args: string[]) => { if (args[0] === "daemon-reload") throw new Error("Failed to connect to bus"); return ""; };
  assert.throws(() => f.upkeep({ systemctl: failing }), /Failed to connect to bus/);
  assert.equal(readFileSync(join(f.installedDir, SERVICE), "utf8"), stale, "the unit that was replaced is back");
  assert.equal(existsSync(join(f.installedDir, TIMER)), false, "and the unit that was not there is gone again");

  f.upkeep();
  assert.equal(readFileSync(join(f.installedDir, SERVICE), "utf8"), f.release(SERVICE), "the next pass installs the release's");
  assert.deepEqual(f.calls.filter((call) => call[0] === "enable"), [["enable", "--now", TIMER]], "and starts the timer, which the failed pass never did");
});

test("A11-354: a masked unit (a link to /dev/null) is left alone, and not rewritten through the link", () => {
  const f = hostFixture();
  symlinkSync("/dev/null", join(f.installedDir, SERVICE));
  f.upkeep();
  assert.equal(readlinkSync(join(f.installedDir, SERVICE)), "/dev/null", "still masked");
  assert.equal(f.said.some((line) => line.includes(`installed ${SERVICE}`)), false, "and it was not written to, which would have been a write to /dev/null");
  assert.ok(f.said.some((line) => line.includes(`installed ${TIMER}`)), "POSITIVE CONTROL: the unit beside it was installed");
});

test("A11-354: a copy the install kept is not an installed unit to `host:check`", () => {
  const f = hostFixture();
  const withoutProgram = "[Service]\nWorkingDirectory=/nowhere/tree\nExecStart=%h/.local/bin/node src/gone.ts\n";
  const findingsFor = () => missingUnitPrograms({ shippedDir: join(f.root, "host"), installedDir: f.installedDir, host: hostWith(), units: UNITS, projectUnitsDir: null, declaredKeys: new Set<string>(), home: f.root } as never);
  writeFileSync(join(f.installedDir, "a11ign-gone.service"), withoutProgram);
  assert.ok(findingsFor().some((finding) => finding.unit === "a11ign-gone.service"), "POSITIVE CONTROL: the same text under a unit's name is a finding");
  rmSync(join(f.installedDir, "a11ign-gone.service"));
  writeFileSync(join(f.installedDir, "a11ign-gone.service.bak-20261027T211509Z"), withoutProgram);
  assert.deepEqual(findingsFor(), [], "under the kept copy's name it is not");
});

test("A11-354: a refused gh wrapper does not keep the launcher and the README from being installed, and the refusal is still raised", () => {
  const f = identityFixture();
  const fake = createFakeCodeHost().wrapper as NonNullable<ReturnType<typeof createFakeCodeHost>["wrapper"]>;
  const unreadable = { ...fake, file: (inputs: Parameters<typeof fake.file>[0]) => ({ ...fake.file(inputs), expected: null }) };
  assert.throws(() => f.install({ onlyChanged: true, wrapper: unreadable }), /gh: the shipped copy could not be read|cannot install gh/);
  assert.ok(existsSync(f.launcher) && existsSync(f.readme), "the files after it were written");
  rmSync(f.launcher);
  assert.throws(() => f.install({ wrapper: unreadable }), /cannot install gh/, "NEGATIVE CONTROL: a person's install stops at the refusal, as it always did");
  assert.equal(existsSync(f.launcher), false, "and wrote nothing after it");
});
