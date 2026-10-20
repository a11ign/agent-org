// no-token: readRowLabels -- missingUnitPrograms never reaches the gh spawn in readRowLabels (host-units.ts:3072); a logging gh stub on PATH saw 0 calls
/**
 * #1112: `host:check` read the `%h` of an ExecStart as a literal directory under the unit's WorkingDirectory and reported a program
 * that is there as PROGRAM MISSING. systemd expands `%h` to the home before anything runs, so the file a unit starts is under the home.
 *
 * The home is passed in, never read from the machine, so this test says the same thing on every host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { missingUnitPrograms } from "./host-units.ts";
import { programCandidates } from "./host-units/shipped-unit-texts-and-declarations.ts";

const HOME = "/home/tester";
const WORK = "/work/tree";
const FLEET_WATCH = `${HOME}/repos/control/src/fleet-watch.ts`;
const UNIT = "a11ign-fleet-watch.service";
const UNIT_TEXT = `[Service]\nWorkingDirectory=${WORK}\nExecStart=%h/.local/bin/node %h/repos/control/src/fleet-watch.ts --post\n`;

const findingsWith = (exists: (path: unknown) => boolean) => missingUnitPrograms({
  installedDir: "/installed",
  readDir: (() => [UNIT]) as never,
  read: (() => UNIT_TEXT) as never,
  exists,
  home: HOME,
  units: { prefix: "a11ign-", boardReportWorkflow: "", own: [] },
});

test("#1112 POSITIVE CONTROL: a `%h` script that is there is NOT reported", () => {
  assert.deepEqual(findingsWith((path) => String(path) === FLEET_WATCH), [],
    "the program systemd runs is under the home, and the file is there");
});

test("#1112 NEGATIVE CONTROL: a `%h` script that is NOT there is still reported, against the home and not a literal `%h`", () => {
  const found = findingsWith(() => false);
  assert.equal(found.length, 1, "a missing program is still a finding");
  assert.equal(found[0].problem, "PROGRAM MISSING");
  assert.equal(found[0].missingProgram, FLEET_WATCH);
  assert.ok(!found[0].missingProgram.includes("%h"), "the specifier is expanded, not joined under the WorkingDirectory as a directory");
});

test("#1112: `$HOME` at the start of a script is the home too; `~` is not, since systemd does not expand it", () => {
  assert.deepEqual(programCandidates(`node $HOME/repos/control/src/fleet-watch.ts`, { repoRoot: WORK, scripts: {}, home: HOME }),
    [FLEET_WATCH]);
  assert.deepEqual(programCandidates(`node ~/repos/control/src/fleet-watch.ts`, { repoRoot: WORK, scripts: {}, home: HOME }),
    [`${WORK}/~/repos/control/src/fleet-watch.ts`],
    "a literal `~` stays a repository-relative name, so a missing file under it is still reported");
});

test("#1112: only the LEADING specifier is expanded; a `%h` later in the path is left as written", () => {
  assert.deepEqual(programCandidates(`node ./%h/y.ts`, { repoRoot: WORK, scripts: {}, home: HOME }),
    [`${WORK}/%h/y.ts`]);
});

test("#1112: a load check that names `%h` inside node's inline code still yields no program", () => {
  assert.deepEqual(programCandidates(`%h/.local/bin/node -e "import('%h/repos/control/src/fleet-watch.ts')"`,
    { repoRoot: WORK, scripts: {}, home: HOME }), []);
});
