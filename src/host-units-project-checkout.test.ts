// no-token: gh -- nothing here spawns `gh`: the git spawns only build two temporary checkouts and read their HEAD, and the install stubs every write and every removal
/**
 * (#1505) `host:check` AND `host:install` NAME WHAT THEY READ. Two directories on one host gave one reading `1 problem` and another `14 files not
 * shipped`, and neither said which checkout it had read. The first line of each names the project checkout and its HEAD; `host:install` lists each
 * unit it will delete, and the directory it compared against, before it deletes anything; and a project units directory that exists and holds none of
 * its units is a PROBLEM line, not silence.
 *
 * Imports `host-units-project.ts` first, for the fixture project's `AGENT_ORG_HOST` and its two units.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./packaging/host-units-project.ts";
import { driftReport, emptyProjectUnitsFinding, hostUnitsInstall, projectUnitsLine } from "./host-units.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

/** The fixture project's own units: two files, a timer and the service it starts. */
const PROJECT_UNITS = join(PROJECT_ROOT, ".agent-org/units");

/** A git stub that answers "on no ref": an orphan with no history is a plain orphan, and no real `git` is asked about this repository. */
const ON_NO_REF = (() => "") as never;

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() }).trim();
}

/** A checkout with one commit, and that commit's short sha. */
function checkout(): { dir: string; sha: string } {
  const dir = tmpDir("project-checkout-");
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { dir, sha: git(dir, ["rev-parse", "--short", "HEAD"]) };
}

/** An installed directory holding copies of `names`, read from the fixture project's units. */
function installedWith(names: string[], extra: string[] = []): string {
  const installed = tmpDir("installed-units-");
  for (const name of names) copyFileSync(join(PROJECT_UNITS, name), join(installed, name));
  for (const name of extra) writeFileSync(join(installed, name), "");
  return installed;
}

const PROJECT_FILES = readdirSync(PROJECT_UNITS).sort();

test("#1505: the first line of the project-units reading names the checkout and its HEAD", () => {
  const { dir, sha } = checkout();
  const units = join(dir, ".agent-org/units");
  mkdirSync(units, { recursive: true });
  for (const name of PROJECT_FILES) writeFileSync(join(units, name), "");
  assert.equal(projectUnitsLine(units), `project units read from ${realpathSync(dir)} @ ${sha}, ${PROJECT_FILES.length} files\n`);
  // A directory that is not in a checkout still says which directory it read, so the line is never silent about a missing HEAD.
  const bare = tmpDir("no-checkout-");
  assert.equal(projectUnitsLine(bare), `project units read from ${bare} @ no HEAD (not a git checkout), 0 files\n`);
  assert.equal(projectUnitsLine(null), "project units: none read -- this run reads no project units directory.\n");
});

test("#1505: host:install prints the project reading as its first line, and lists each orphan before it removes it", () => {
  const installed = installedWith(PROJECT_FILES, ["a11ign-retired.timer"]);
  const out: string[] = [];
  const removed: string[] = [];
  hostUnitsInstall({
    installedDir: installed,
    projectUnitsDir: PROJECT_UNITS,
    declaredKeys: new Set(),
    systemctl: (() => "") as never,
    write: (() => undefined) as never,
    mkdir: (() => undefined) as never,
    rm: ((path: string) => { removed.push(String(path)); }) as never,
    git: ON_NO_REF,
    out: (line: string) => { out.push(line); },
  });
  assert.equal(out[0], projectUnitsLine(PROJECT_UNITS), "the first line is the reading, before anything is written or removed");
  const orphan = out.findIndex((line) => line.startsWith("ORPHAN a11ign-retired.timer -- not shipped by the directories compared: "));
  const removal = out.findIndex((line) => line.startsWith("REMOVED a11ign-retired.timer"));
  assert.ok(orphan > 0, `the orphan is listed, with the directories it was compared against: ${out.join("")}`);
  assert.ok(orphan < removal, "the list comes before the removal");
  assert.ok(out[orphan].includes(PROJECT_UNITS), "and it names the project units directory it compared against");
  assert.deepEqual(removed, [join(installed, "a11ign-retired.timer")], "and it removed exactly the orphan");
});

test("#1505: a project units directory that holds none of its units, with units installed, is a PROBLEM line", () => {
  const installed = installedWith(PROJECT_FILES);
  const empty = tmpDir("empty-project-units-");
  // POSITIVE CONTROL: the empty directory raises the PROBLEM, and the driftReport carries the line the operator reads.
  const findings = emptyProjectUnitsFinding({ projectUnitsDir: empty, installedDir: installed });
  assert.equal(findings.length, 1);
  assert.match(driftReport(findings), /host units: 1 problem\(s\)\.\n {2}\S+: PROJECT UNITS EMPTY/);
  // NEGATIVE CONTROL: the same installed units, with the project's own units present, raise nothing.
  assert.deepEqual(emptyProjectUnitsFinding({ projectUnitsDir: PROJECT_UNITS, installedDir: installed }), []);
  // And an empty directory with nothing installed is not a problem: there is nothing for an install to delete.
  assert.deepEqual(emptyProjectUnitsFinding({ projectUnitsDir: empty, installedDir: tmpDir("nothing-installed-") }), []);
});
