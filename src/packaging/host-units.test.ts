// no-token: gh
//
// Nothing here spawns `gh`, and nothing here reaches the network. `shippedUnits`, `unitState`,
// `unitDrift` and `driftReport` all take their filesystem and their `systemctl` injected;
// `hostUnitsInstall` takes its copier; `orphanedUnits` takes its `git` (#1993), so a stub directory
// never reaches a real `git` and is never answered about a path outside the repository. The real reads
// are of `packages/agent-org/host/`, this repository's own directory, and of a two-commit git
// repository this file BUILDS in a temp directory and deletes -- never of this checkout's own history,
// which is as deep as whoever cloned chose to make it.

/**
 * #1858: A UNIT FILE IN THE REPOSITORY IS NOT A RUNNING TIMER.
 *
 * Measured 2026-09-21. #1844 shipped the nightly fleet scheduler -- built so the fleet batch would stop
 * depending on a session remembering it -- and merged at 19:22Z. At 19:38Z the chairman asked why nothing
 * was happening: `systemctl --user is-enabled a11ign-fleet-gated-nightly.timer` said `not-found`. The unit
 * had never been copied out of `packages/agent-org/host/`. Installing the scheduler depended on a session
 * remembering, which is the defect the scheduler existed to remove.
 *
 * `a11ign-corpus-snapshot.timer` failed the same hour in the quieter way: installed, `enabled`, and
 * `inactive` on a host up for nine days -- `enable` without `--now`, and nothing ever said so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { shippedUnits, unitState, unitDrift, driftReport, hostUnitsInstall, systemdUserAvailable,
  hostUnitDrift, permissionModeDrift, orphanedUnits, SHIPPED_DIR, REPO_ROOT, execCommands,
  entriesFromCommand, ghSpawnReachedFrom, identityDrift, unitsSpendingGh, opaqueCommands,
  retiredHere } from "../host-units.mjs";

const SYSTEMD_OK = () => "LANG=C\n";
const NO_SYSTEMD = () => { throw new Error("systemctl: command not found"); };

/** `systemctl` as a lookup table: {verb: {unit: answer}}, throwing like the real one on a non-zero word. */
const systemctlStub = (answers: Record<string, Record<string, string>>) => (args: string[]) => {
  if (args[0] === "show-environment") return "LANG=C\n";
  const word = answers[args[0]]?.[args[1]] ?? "unknown";
  if (word === "active" || word === "enabled") return `${word}\n`;
  // THE REAL SHAPE: systemctl writes the word to stdout AND exits non-zero for inactive/disabled, so
  // execFileSync throws with `.stdout` carrying the answer. A stub that merely returned the string would
  // let a `catch`-less implementation pass and then crash on a real host.
  const error: Error & { stdout?: string } = new Error(`Command failed: systemctl ${args.join(" ")}`);
  error.stdout = `${word}\n`;
  throw error;
};

test("#1858: a shipped unit that was never installed is the finding", () => {
  const state = unitState("a11ign-fleet-gated-nightly.timer", {
    exists: (() => false) as never,
    systemctl: systemctlStub({ "is-enabled": {}, "is-active": {} }),
  });
  assert.equal(state.present, false);
  assert.equal(state.current, null,
    "NULL, not false -- 'there is no copy' and 'the copy differs' need different remedies");
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "NOT INSTALLED");
  assert.match(finding.detail, /It cannot run/);
});

test("#1858: ENABLED BUT NOT RUNNING is its own finding -- the one that actually happened", () => {
  // `enabled` and `active` are separate fields precisely so this state has somewhere to live. A single
  // "is it on?" boolean would have had to pick one of systemd's two answers, and either choice reports
  // a11ign-corpus-snapshot.timer's nine dead days as healthy.
  const state = unitState("a11ign-corpus-snapshot.timer", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).includes("host/") ? "X" : "X")) as never,
    systemctl: systemctlStub({
      "is-enabled": { "a11ign-corpus-snapshot.timer": "enabled" },
      "is-active": { "a11ign-corpus-snapshot.timer": "inactive" },
    }),
  });
  assert.deepEqual([state.enabled, state.active], ["enabled", "inactive"],
    "the word systemd used survives the non-zero exit -- reading only the exit code loses it");
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "ENABLED BUT NOT RUNNING");
  assert.match(finding.detail, /--now/, "and it names the flag whose absence causes it");
});

test("#1858: a timer that is enabled AND active is NOT a finding -- the positive control", () => {
  const state = unitState("a11ign-work-tick.timer", {
    exists: (() => true) as never,
    read: (() => "X") as never,
    systemctl: systemctlStub({
      "is-enabled": { "a11ign-work-tick.timer": "enabled" },
      "is-active": { "a11ign-work-tick.timer": "active" },
    }),
  });
  assert.deepEqual(unitDrift([state]), [],
    "this check must be capable of finding nothing, or every report is noise");
});

test("#1858: an installed copy that DIFFERS from the repository is STALE", () => {
  // They are copies, not symlinks -- the convention already on the host -- so a merged edit does not
  // reach the host until somebody reinstalls. That gap is invisible without this.
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith(SHIPPED_DIR) ? "NEW" : "OLD")) as never,
  });
  assert.equal(state.current, false);
  const [finding] = unitDrift([state]);
  assert.equal(finding.problem, "STALE");
  assert.match(finding.detail, /does NOT reach the host until it is reinstalled/);
});

test("#1858: a .service is judged on PRESENT and CURRENT only -- a service has no timer's liveness", () => {
  // `systemctl is-active` on a `oneshot` service is `inactive` almost always, and correctly so: it ran
  // and exited. Judging one by liveness would report every healthy oneshot as broken.
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never, read: (() => "X") as never,
    systemctl: (() => { throw new Error("must not be asked about a .service"); }) as never,
  });
  assert.deepEqual([state.enabled, state.active], [null, null]);
  assert.deepEqual(unitDrift([state]), []);
});

test("#1858: NO SYSTEMD REPORTS NOTHING, and says so rather than saying everything is fine", () => {
  // The first version of this file lacked this gate while its own comment claimed the property, and on
  // the Mac it was written on it reported all six shipped units "NOT INSTALLED" -- true, useless, and
  // the fastest possible route to somebody silencing the check that matters.
  assert.equal(systemdUserAvailable(NO_SYSTEMD as never), false);
  assert.equal(systemdUserAvailable(SYSTEMD_OK as never), true);
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD as never }), [],
    "a developer checkout is not a host that failed to install anything");
  assert.match(driftReport([], false), /NOT CHECKED/);
  assert.doesNotMatch(driftReport([], false), /every shipped unit is installed/,
    "NOT ASKED and ALL CORRECT are both an empty list, and the report must never say the second when "
    + "it means the first");
  assert.match(driftReport([], true), /every shipped unit is installed/);
});

test("#1858: the installer uses `enable --now`, never a bare `enable`", () => {
  // MUTATION TARGET. An installer that can reproduce the bug it exists to fix is not an installer:
  // a bare `enable` is exactly what left a11ign-corpus-snapshot.timer enabled and dead for nine days.
  const calls: string[][] = [];
  const copied: string[] = [];
  // The REAL shipped directory, with only the WRITES stubbed: `hostUnitsInstall` discovers units through
  // `shippedUnits`, so a made-up source path finds nothing and the assertions below pass vacuously --
  // which is exactly what the first version of this test did.
  hostUnitsInstall({
    installedDir: "/installed",
    systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
    copy: ((from: string) => { copied.push(String(from)); }) as never,
    mkdir: (() => undefined) as never,
    out: () => undefined,
  });
  assert.ok(copied.length > 0, "it copied the units it found");
  assert.deepEqual(calls[0], ["daemon-reload"], "reload BEFORE enabling, or systemd enables a stale unit");
  const enables = calls.filter((c) => c[0] === "enable");
  assert.ok(enables.length > 0, "and it enabled the timers");
  for (const call of enables) {
    assert.deepEqual(call.slice(0, 2), ["enable", "--now"], `bare enable in ${JSON.stringify(call)}`);
    assert.match(call[2], /\.timer$/, "only timers are enabled -- a oneshot service is pulled by its timer");
  }
});

test("#1858: every unit this repository ships is discovered -- against the real directory", () => {
  const units = shippedUnits();
  assert.ok(units.includes("a11ign-work-tick.timer"), "the tick timer is the one known-good unit");
  assert.ok(units.includes("a11ign-corpus-release-nightly.timer"),
    "and the corpus release nightly, which this check caught shipped-but-uninstalled on its first day");
  // #1941 RETIRED `a11ign-fleet-gated-nightly.*`, which this test originally named as its second example
  // (it was #1858's own case: shipped by #1844 and never installed). Its question -- are there
  // fleet-gated rows to dispatch? -- moved into `work-gate.mjs` as `fleet-batch-due`, because it is a
  // STATE question and `agent-practices.md` forbids putting those on a clock. The units are gone so
  // `host:install` cannot put the timer back beside the gate cause and fire the same batch twice.
  assert.ok(!units.some((u) => u.startsWith("a11ign-fleet-gated-nightly")),
    "the retired nightly must not ship");
  assert.deepEqual(units, [...units].sort(), "sorted, so a report reads the same way twice");
  assert.ok(units.every((u) => u.endsWith(".timer") || u.endsWith(".service")),
    "nothing but units -- a README dropped in that directory must not become a finding");
});

// --- #1863: the org silently reverts to auto mode every time herdr restarts ---------------------------
//
// Measured 2026-09-21. `orchestrator` did every step of the corpus backup, reached the upload, and
// stopped: its permission classifier refused the publish as "Modify Shared Resources". It could not ask
// either -- `agentArgs` removes `AskUserQuestion` (#1744) because a session that stops to ask is one
// herdr reports as `blocked`. Unable to act AND unable to ask, on the operations that matter.
//
// `agentArgs` DOES pass --dangerously-skip-permissions, but only on `herdr agent start`. herdr resumes an
// existing session as a bare `claude --resume <uuid>`, and re-resumes all of them when it restarts: six
// came back at 18:47:27 in one instant, in auto mode. A launch flag cannot hold a posture across a resume.

const settings = (json: string) => ({
  settingsPath: "/home/agent/.claude/settings.json",
  exists: (() => true) as never,
  read: (() => json) as never,
});

test("#1863: bypassPermissions is the only posture that is NOT a finding", () => {
  assert.deepEqual(permissionModeDrift(settings('{"permissions":{"defaultMode":"bypassPermissions"}}')), [],
    "the positive control -- this check must be capable of passing");
});

test("#1863: auto mode is the finding, and the message says WHY it strands a session", () => {
  const [f] = permissionModeDrift(settings('{"permissions":{"defaultMode":"acceptEdits"}}'));
  assert.equal(f.problem, "ORG IS IN AUTO MODE");
  assert.match(f.detail, /acceptEdits/, "it names the mode it found rather than only the one it wants");
  assert.match(f.detail, /cannot ask either/,
    "the compounding half: AskUserQuestion is removed, so the session stops with NO signal at all");
  assert.match(f.detail, /does not survive herdr resuming/,
    "and it says why the launch flag is not the remedy, or the next reader adds the flag again");
});

test("#1863: an ABSENT key and an absent FILE are both findings, neither silently fine", () => {
  const [unset] = permissionModeDrift(settings('{"model":"opus[1m]"}'));
  assert.equal(unset.problem, "ORG IS IN AUTO MODE");
  assert.match(unset.detail, /unset/, "an absent key is auto mode -- that is exactly how this happened");
  const [absent] = permissionModeDrift({ settingsPath: "/nope", exists: (() => false) as never });
  assert.equal(absent.problem, "NO SETTINGS FILE");
});

test("#1863: UNREADABLE is its own verdict -- unknown is not the same as wrong", () => {
  // Reporting broken JSON as "auto mode" would send a reader to change a key in a file that will not
  // load whatever they put in it.
  const [f] = permissionModeDrift(settings("{ this is not json"));
  assert.equal(f.problem, "UNREADABLE");
  assert.match(f.detail, /UNKNOWN rather than wrong/);
  // AND THE PARSER'S OWN MESSAGE SURVIVES. Without this a mutant that drops the cause passed: "the file
  // is unparseable" sends a reader to look at 40 lines of JSON, where the position the parser names
  // sends them to the character. Losing a cause is this repository's most-repaid mistake.
  assert.match(f.detail, /at position \d+/,
    "the JSON parser's own complaint reaches the reader, not just the verdict that it failed. Matched on "
    + "`at position <n>`, which ONLY the parser produces -- my first attempt matched /JSON/ and passed "
    + "against the static words \"Fix the JSON first\", so the mutant that dropped the cause survived");
});

test("#1863: a machine with no user systemd is not told its permissions are wrong", () => {
  // Same gate as the timers, and for the same reason: a laptop told "ORG IS IN AUTO MODE" teaches its
  // owner to ignore this command, which loses the timer finding along with it.
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD as never }), []);
});

test("#1911: the corpus-release unit reads fleet.env, the only place a unit can get A11Y_PVE_KEY", () => {
  // `~/.zshenv` exported it for every shell and for no unit, so the nightly failed every firing. The `-`
  // leaves a missing file to corpus-release-nightly.mjs's own refusal, which names it.
  const unit = readFileSync(join(SHIPPED_DIR, "a11ign-corpus-release-nightly.service"), "utf8");
  assert.match(unit, /^EnvironmentFile=-%h\/\.config\/a11ign\/fleet\.env$/m);
});

// --- #1951: a unit the repo stopped shipping keeps firing, and nothing said so ------------------------
//
// MEASURED 2026-09-22. #1941 retired `a11ign-fleet-gated-nightly.{service,timer}` -- the 01:00 batch
// became work-gate's `fleet-batch-due` cause, and the unit files were DELETED precisely so `host:install`
// could not put the clock back beside the gate cause. The PR merged. And the timer was still installed,
// still enabled, still active, still scheduled:
//
//     Wed 2026-09-23 01:00:00 UTC   a11ign-fleet-gated-nightly.timer
//
// One night from dispatching the same batch twice, from two mechanisms at two cadences. `host:check`
// printed "every shipped unit is installed, current and running" over it, because every check it had
// asked "is what we ship installed?" and none asked "is what is installed still ours?".

/**
 * A REAL TWO-COMMIT REPOSITORY, built here: one commit ships two units, the next deletes one of them.
 *
 * A FIXTURE AND NOT THIS CHECKOUT, which is the whole lesson of the first CI run. `retiredHere` was
 * asserted against this repository's own history ("#1941 deleted the fleet-gated nightly's units") --
 * true on the agent host, FALSE in the acceptance job, which checks out at the default depth on purpose.
 * A history bounded by whoever cloned cannot be a fixture; two commits made here can.
 * @returns {{ dir: string, git: (args: string[]) => string }}
 */
const repoWithARetirement = () => {
  const dir = mkdtempSync(join(tmpdir(), "host-units-retirement-"));
  const git = (args: string[]) =>
    // `sandboxGitEnv()` for the same reason the production spawn uses it: an inherited `GIT_DIR` from a
    // hook or a merge worktree would aim every one of these at somebody else's repository.
    String(execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() }));
  const host = join(dir, "packages/agent-org/host");
  mkdirSync(host, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "fixture"]);
  writeFileSync(join(host, "a11ign-gone.timer"), "[Timer]\nOnCalendar=daily\n");
  writeFileSync(join(host, "a11ign-stays.timer"), "[Timer]\nOnCalendar=daily\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "ship both units"]);
  rmSync(join(host, "a11ign-gone.timer"));
  git(["add", "-A"]);
  git(["commit", "-qm", "retire one of them"]);
  return { dir, git };
};

/**
 * `git log --diff-filter=D` as a stub, in the two answers that mean different things (#1993). INJECTED
 * IN EVERY CASE below, so this file still spawns nothing and a stub directory never reaches a real
 * `git` that would answer about a path outside the repository.
 */
const RETIRED_HERE = () => "cafe1234cafe1234cafe1234cafe1234cafe1234\n";
const NEVER_SHIPPED_HERE = () => "";

const dirs = (shipped: string[], installed: string[], git = NEVER_SHIPPED_HERE) => ({
  shippedDir: "/shipped",
  installedDir: "/installed",
  readDir: ((d: string) => (String(d) === "/shipped" ? shipped : installed)) as never,
  git,
});

test("#1951: a unit the repository RETIRED is ORPHANED, and the message says why it matters", () => {
  const [f] = orphanedUnits(dirs(["a11ign-work-tick.timer"],
    ["a11ign-work-tick.timer", "a11ign-fleet-gated-nightly.timer"], RETIRED_HERE));
  assert.equal(f.unit, "a11ign-fleet-gated-nightly.timer");
  assert.equal(f.problem, "ORPHANED -- RETIRED HERE");
  assert.match(f.detail, /does not\s+uninstall it/,
    "the reader must learn that deleting the file was not enough -- that is the whole misconception");
  assert.match(f.detail, /both are now firing/,
    "and the consequence, which is worse than an idle leftover: a replacement running beside it");
  assert.match(f.detail, /npm run host:install` removes it/,
    "and for a unit a commit deliberately deleted, the remedy IS the remedy");
  assert.notEqual(f.removesUnit, true, "this is the branch where deleting it is the intent");
});

// --- #1993: "not shipped" has two causes and the check used to know only one ------------------------
//
// MEASURED 2026-09-22. `a11ign-board-report.{service,timer}` -- the LIVE daily board dispatch, firing at
// 07:10 every morning since at least 2026-09-19 -- were hand-installed on 2026-09-18 and never
// committed. `orphanedUnits` had ONE BIT, "installed and not in the tree", and spelled it *NO LONGER
// SHIPPED*: an inference about the past that the bit cannot carry. So `host:check` printed the one
// remedy it has, `npm run host:install`, which DELETES an orphan -- and nothing would have reported the
// loss except a board edition that never arrived.

test("#1993: a unit NO COMMIT HERE EVER SHIPPED is not a retirement, and must not be offered for deletion", () => {
  const [f] = orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE));
  assert.equal(f.problem, "ORPHANED -- NEVER SHIPPED HERE");
  assert.equal(f.removesUnit, true, "which is what puts the DELETION on the remedy line");
  assert.match(f.detail, /DO NOT reach for `npm run host:install`/,
    "the one remedy this report has is the wrong one here, and saying so is the whole fix");
  assert.match(f.detail, /ship it under packages\/agent-org\/host\/ or\s+confirm it is dead/,
    "a refusal nobody can follow is a refusal nobody acts on: both exits are named");
});

test("#1993: a history it CANNOT read is UNKNOWN, and falls to the careful branch rather than the tidy one", () => {
  // A `git` that cannot answer -- no pack, a stub path, a checkout without the history -- would
  // otherwise land in whichever branch the `catch` picked. If it picked RETIRED, the check would
  // recommend deleting a live unit for a second, quieter reason.
  const [f] = orphanedUnits(dirs([], ["a11ign-board-report.timer"],
    (() => { throw new Error("fatal: not a git repository"); }) as never));
  assert.equal(f.problem, "ORPHANED -- HISTORY UNREADABLE");
  assert.equal(f.removesUnit, true);
  assert.match(f.detail, /whether it was ever ours is UNKNOWN/,
    "NOT ASKED and ALL CLEAR must not read the same, which is this repository's most-repeated defect");
});

test("#1993: `retiredHere` reads a real deletion out of a real history, through the real argv", () => {
  // AGAINST REAL `git`, and against a repository built here rather than against this checkout.
  //
  // The first version asserted on THIS tree ("#1941 deleted the fleet-gated nightly's units"), which is
  // true on the agent host and FALSE IN CI: `reusable-acceptance.yml` checks out at the default depth on
  // purpose, so `--diff-filter=D` saw no commits and the assertion failed on the first CI run. A history
  // bounded by whoever cloned is not a fixture. This one is: two commits, one of which deletes a file.
  const { dir, git } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.equal(retiredHere("a11ign-gone.timer", deps), true,
      "a commit deleted it, so `--diff-filter=D` finds that commit -- and a stub could not have caught a "
      + "wrong flag or a path form git rejects, which is why this one runs the real thing");
    assert.equal(retiredHere("a11ign-stays.timer", deps), false,
      "POSITIVE CONTROL: a file still in the tree answers false, not true -- the filter is not matching "
      + "every commit that touched the path");
    assert.equal(retiredHere("a11ign-never-existed.timer", deps), false,
      "and a name no commit ever carried answers false, not null: the question was asked and answered, "
      + "which is a different thing from being unanswerable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1993: a SHALLOW clone cannot say `never`, and must not answer as though it could", () => {
  // THE DEFECT CI FOUND, pinned. An empty `git log` means "no deletion IN WHAT I CAN SEE", and how much
  // that is was chosen by whoever cloned. Answering `false` there reports a RETIRED unit as one this
  // repository never shipped -- the careful branch, so the direction is safe, but wrong and silent.
  const shallow = (args: string[]) => (args[0] === "rev-parse" ? "true\n" : "");
  assert.equal(retiredHere("a11ign-gone.timer", { git: shallow }), null,
    "UNKNOWN, not `false` -- NOT ASKED and ANSWERED NO are the substitution this repository keeps "
    + "re-learning");
  const whole = (args: string[]) => (args[0] === "rev-parse" ? "false\n" : "");
  assert.equal(retiredHere("a11ign-gone.timer", { git: whole }), false,
    "POSITIVE CONTROL: on a complete history the same empty log IS evidence, or this branch would make "
    + "the answer `null` for everything and the RETIRED finding unreachable");
});

test("#1951: ONLY this org's units -- the host runs others and they are not ours to judge", () => {
  // The agent host runs `launchpadlib-cache-clean.timer` and whatever else the distribution ships.
  // Reporting those would be wrong and would train an operator to ignore this command, taking the real
  // finding with it.
  assert.deepEqual(orphanedUnits(dirs([], ["launchpadlib-cache-clean.timer", "systemd-tmpfiles.service"])), []);
  assert.deepEqual(orphanedUnits(dirs([], ["a11ign-gone.timer"])).map((o) => o.unit), ["a11ign-gone.timer"],
    "POSITIVE CONTROL: an a11ign unit in the same position IS reported, so the filter is not just silent");
});

test("#1951: non-unit files in the install directory are not orphans", () => {
  assert.deepEqual(orphanedUnits(dirs([], ["a11ign-notes.md", "a11ign-backup.timer.bak"])), [],
    "only .service and .timer are units; a stray file is not something to disable");
});

test("#1951 POSITIVE CONTROL: a host matching the repository has no orphans", () => {
  const units = ["a11ign-work-tick.service", "a11ign-work-tick.timer"];
  assert.deepEqual(orphanedUnits(dirs(units, units)), [],
    "this check must be capable of finding nothing, or every run is noise");
});

test("#1951: a missing install directory is not a pile of orphans", () => {
  assert.deepEqual(orphanedUnits({
    shippedDir: "/shipped", installedDir: "/nope",
    readDir: ((d: string) => { if (String(d) === "/nope") throw new Error("ENOENT"); return ["a11ign-x.timer"]; }) as never,
  }), [], "nothing installed means nothing orphaned -- the missing-unit half already reports the absence");
});

test("#1951: the installer REMOVES an orphan, disabling the timer before deleting the file", () => {
  // MUTATION TARGET, and the first version of this test could not reach the code it claimed to check:
  // `hostUnitsInstall` hard-wired the real `readdirSync` into its orphan lookup, so with stub directories
  // it found nothing and deleting the ENTIRE removal loop killed zero tests. `read` is injected now.
  //
  // `disable --now` BEFORE the delete is the load-bearing order: removing the file while its
  // `timers.target.wants` symlink stands leaves a dangling want, and systemd warns on every later
  // daemon-reload -- noise that trains an operator to ignore this command's output.
  const calls: string[][] = [];
  const removed: string[] = [];
  hostUnitsInstall({
    shippedDir: "/shipped",
    installedDir: "/installed",
    readDir: ((d: string) => (String(d) === "/shipped"
      ? ["a11ign-work-tick.timer"]
      : ["a11ign-work-tick.timer", "a11ign-fleet-gated-nightly.timer", "a11ign-old.service"])) as never,
    systemctl: ((a: string[]) => { calls.push(a); return ""; }) as never,
    git: RETIRED_HERE,
    copy: (() => undefined) as never,
    mkdir: (() => undefined) as never,
    rm: ((path: string) => { removed.push(String(path)); }) as never,
    out: () => undefined,
  });

  assert.deepEqual(removed,
    ["/installed/a11ign-fleet-gated-nightly.timer", "/installed/a11ign-old.service"],
    "both orphans are deleted, and the still-shipped unit is NOT");
  assert.deepEqual(calls.filter((c) => c[0] === "disable"),
    [["disable", "--now", "a11ign-fleet-gated-nightly.timer"]],
    "the orphaned TIMER is disabled --now; the orphaned .service has no timer to disable");

  const reloadAt = calls.findIndex((c) => c[0] === "daemon-reload");
  const disableAt = calls.findIndex((c) => c[0] === "disable");
  assert.ok(disableAt >= 0 && disableAt < reloadAt,
    "removal happens BEFORE daemon-reload, so systemd never re-reads a unit on its way out");
  assert.deepEqual(calls.filter((c) => c[0] === "enable"),
    [["enable", "--now", "a11ign-work-tick.timer"]],
    "and the shipped timer is still enabled afterwards -- removal must not skip the install");
});

// --- #1974: a unit that spawns `gh` and never says as whom gets a person's account -------------------
//
// MEASURED 2026-09-22. `a11ign-work-tick.service` ran with no `GH_CONFIG_DIR`, so the work gate
// authenticated as `DanBeckDev` -- a PERSON -- and spent that human account's 5,000 GraphQL requests.
// The gate then refused correctly and SILENTLY ("CANNOT ASK: neither the pull-request list nor the Ready
// rows could be read"), which from inside the org is indistinguishable from a quiet queue.
//
// The routing lives in `~/.local/bin/gh` and keys on `HERDR_WORKSPACE_ID` -- which every org session has
// and no systemd unit does. A unit that does not DECLARE its account cannot get the right one, and the
// repository could not see the choice being made at all: `GH_CONFIG_DIR` appeared nowhere in this tree.

test("#1974: every shipped unit that spawns `gh` declares which account -- over the units on disk", () => {
  // THE POSITIVE CONTROL COMES FIRST, and it is load-bearing rather than decorative. `identityDrift()`
  // derives its population from a real directory walk and a real import closure: a wrong `shippedDir`, a
  // package.json whose scripts do not resolve, or a glob that matches nothing all yield an EMPTY
  // population, and an empty population has no undeclared members. The assertion below would pass over a
  // check that had stopped working, which is the failure this repository keeps re-learning.
  const spending = unitsSpendingGh();
  assert.ok(spending.length >= 3,
    `the population must not be empty or this check passes vacuously; found ${JSON.stringify(spending)}`);
  // THE FLOOR IS RAISED RATHER THAN LEFT WHERE IT WAS (#1993). `>= 2` held at 2 and would have held at
  // 3, so the day the board dispatch joined the population nothing would have said whether it did. The
  // units it names are the assertion that it did: a floor is a bound on the count, and these are the
  // members.
  assert.deepEqual(spending.map((u) => u.unit).sort(),
    ["a11ign-board-report.service", "a11ign-corpus-release-nightly.service", "a11ign-work-tick.service"],
    "every shipped .service that can reach `gh` -- including the one whose ExecStart this repository "
    + "cannot read, which is charged on UNKNOWN rather than excused on it");
  assert.deepEqual(identityDrift(), [],
    "a unit reaching a `gh` spawn with no Environment=GH_CONFIG_DIR= line inherits `~/.config/gh` -- a "
    + "person's account -- and spends a human's rate limit until it runs out");
});

test("#1974 NEGATIVE CONTROL: an undeclared gh-spawning unit IS a finding, and names its entry point", () => {
  // The assertion above is an emptiness assertion, so this is where it is shown capable of failing.
  // Stub directories, so the finding is produced by the rule rather than by the repository's own state.
  const unit = "[Service]\nExecStart=/usr/bin/node packages/agent-org/src/work-tick.mjs\n";
  const [f] = identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-spends.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? unit : "execFileSync(\"gh\", [])")) as never,
  });
  assert.equal(f.unit, "a11ign-spends.service");
  assert.equal(f.problem, "NO IDENTITY DECLARED");
  assert.match(f.detail, /work-tick\.mjs/, "it names the entry point, not just the unit");
  assert.match(f.detail, /Environment=GH_CONFIG_DIR=/,
    "and the line to add -- a refusal nobody can follow is a refusal nobody acts on");
  assert.deepEqual(identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-spends.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped")
      ? `${unit}Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n`
      : "execFileSync(\"gh\", [])")) as never,
  }), [], "and the SAME unit with the line is not a finding -- the rule reads the declaration");
});

test("#1974: a `.timer` is not asked for an identity -- it starts a service, it spawns nothing", () => {
  assert.deepEqual(identityDrift({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-x.timer"]) as never,
    read: (() => "[Timer]\nOnUnitActiveSec=2min\n") as never,
  }), [], "charging a timer for its service's spawns would demand the line in two places");
});

test("#1974: systemd's Exec prefixes are stripped, or `-npm` resolves to nothing and the unit reads clean", () => {
  // `ExecStartPre=-/usr/bin/npm run primary:update` -- the `-` means "ignore failure", not a program
  // called `-/usr/bin/npm`. A parser that kept it finds no entry point, and a unit whose only gh-spawning
  // command carried a prefix would pass while spending a person's pool.
  assert.deepEqual(execCommands("[Service]\nExecStartPre=-/usr/bin/npm run primary:update\n"
    + "ExecStart=/usr/bin/node a.mjs\nEnvironment=HOME=/home/agent\n"),
  ["/usr/bin/npm run primary:update", "/usr/bin/node a.mjs"]);
  assert.deepEqual(execCommands("[Service]\nExecStop=@/bin/true stop\n"), ["/bin/true stop"],
    "`@` (argv[0] override) too, and ExecStop -- every Exec directive, so a fourth kind is not a fourth incident");
});

test("#1974: `npm run <script>` is followed through package.json to the file it actually starts", () => {
  // `ExecStart=/usr/bin/npm run corpus:snapshot` is a path to a .mjs with one hop in between. A check
  // that stopped at the word `npm` would find no entry point in two of this repo's three units.
  const entries = entriesFromCommand("/usr/bin/npm run work:tick", {
    repoRoot: "/repo",
    scripts: { "work:tick": "node packages/agent-org/src/work-gate.mjs | node packages/agent-org/src/wake.mjs" },
    exists: (() => true) as never,
  });
  assert.deepEqual(entries,
    ["/repo/packages/agent-org/src/work-gate.mjs", "/repo/packages/agent-org/src/wake.mjs"],
    "and BOTH sides of the pipeline -- `work:tick` is two programs and either of them can spend the pool");
  assert.deepEqual(entriesFromCommand("/usr/bin/npm run nope",
    { repoRoot: "/repo", scripts: {}, exists: (() => true) as never }), [],
  "an unknown script resolves to nothing rather than to a guess");
});

test("#1974: the `npm run` edge inside CODE is followed -- an import walk alone reports this unit clean", () => {
  // corpus-release-nightly.mjs reaches `gh` ONLY through `npmCliInvocation("npm", ["run",
  // "corpus:release"])`. There is no import edge to follow, so a closure walk that knew only about
  // imports returned NO gh for it -- measured, before this edge existed -- and the nightly would have
  // shipped undeclared while the check said it was fine.
  const nightly = join(REPO_ROOT, "packages/lab/scripts/corpus-release-nightly.mjs");
  const hit = ghSpawnReachedFrom(nightly);
  assert.ok(hit, "the nightly reaches a `gh` spawn");
  assert.match(String(hit), /corpus-release\.mjs$/,
    "through the script it SPAWNS, which no import of its own names");
  assert.equal(ghSpawnReachedFrom(join(REPO_ROOT, "packages/agent-org/src/update-primary.mjs")), null,
    "POSITIVE CONTROL: a unit entry point that does NOT touch `gh` is not charged for one");
});

// --- #1974, the trap: the remedy every finding names is the thing that re-breaks it ------------------
//
// The units are COPIES, so `host:install` writes the repository over the host. On 2026-09-22 the host
// carried the identity fix and the repository did not, while two unrelated ORPHANED units sat in the
// same report under the same one-line remedy. The next session to clear the orphans would have run the
// recommended command and silently reverted the work gate's account in the same breath.

const staleWithIdentity = () => unitState("a11ign-work-tick.service", {
  exists: (() => true) as never,
  read: ((p: string) => (String(p).startsWith(SHIPPED_DIR)
    ? "[Service]\nEnvironment=HOME=/home/agent\n"
    : "[Service]\nEnvironment=HOME=/home/agent\nEnvironment=GH_CONFIG_DIR=/home/agent/workers/gh\n")) as never,
});

test("#1974: a STALE whose diff is an identity the HOST has and the repo lacks is its own problem", () => {
  const state = staleWithIdentity();
  assert.deepEqual(state.identityRevert, ["Environment=GH_CONFIG_DIR=/home/agent/workers/gh"],
    "the line itself survives to the message -- a reader has to be able to paste it back");
  const [f] = unitDrift([state]);
  assert.equal(f.problem, "STALE -- REINSTALLING WOULD REVERT AN IDENTITY",
    "its own problem word, not a detail on the ordinary STALE: a reader scanning for urgency reads these");
  assert.equal(f.revertsIdentity, true);
  assert.match(f.detail, /would DELETE that line/);
  assert.match(f.detail, /host\/ FIRST/, "and says what to do instead of the remedy");
});

test("#1974: the DIRECTION matters -- repo-has/host-lacks is the drift the remedy FIXES", () => {
  const state = unitState("a11ign-work-tick.service", {
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith(SHIPPED_DIR)
      ? "[Service]\nEnvironment=GH_CONFIG_DIR=/home/agent/workers/gh\n"
      : "[Service]\n")) as never,
  });
  assert.deepEqual(state.identityRevert, []);
  const [f] = unitDrift([state]);
  assert.equal(f.problem, "STALE",
    "this is exactly what `host:install` is for; shouting here would train a reader to ignore the shout");
});

test("#1974: the REMEDY LINE carries the warning, because the reader is there for the orphans", () => {
  // The trap is not that `host:install` is wrong for the orphans -- it is right for them. It is that a
  // session clearing two harmless ORPHANED units runs the same command, having scrolled past a finding
  // that was not theirs. So the stop has to be where every reader ends up.
  const report = driftReport([
    ...unitDrift([staleWithIdentity()]),
    { unit: "a11ign-board-report.timer", problem: "ORPHANED", detail: "no longer shipped." },
  ]);
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-work-tick\.service is installed with a `GH_CONFIG_DIR`/,
    "and names WHICH unit, so a reader with three findings knows which one is the live wire");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("npm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
});

test("#1974 POSITIVE CONTROL: ordinary findings still get the plain one-line remedy", () => {
  const report = driftReport([{ unit: "a11ign-x.timer", problem: "ORPHANED", detail: "no longer shipped." }]);
  assert.match(report, /Remedy for all of them: npm run host:install/);
  assert.doesNotMatch(report, /DO NOT RUN/,
    "a warning on every report is a warning on no report");
});

// --- #1993: an ExecStart this repository cannot read, and the two units it was about to delete -------
//
// MEASURED 2026-09-22 on the agent host. `a11ign-board-report.{service,timer}` fired at 07:10 that
// morning and every morning back to at least 2026-09-19, dispatching the board edition `ceo` reads --
// and `git log --all -- 'packages/agent-org/host/a11ign-board-report*'` was EMPTY. Hand-installed on
// 2026-09-18, never committed. Two consequences, and this row is both of them:
//
//   `host:check` read "installed and not shipped" as RETIRED and offered `npm run host:install`, which
//   DELETES an orphan -- so the one remedy the report has would have stopped the daily edition, and the
//   only thing that would ever have reported it is an edition that did not arrive.
//
//   The unit declared no PATH, so the script's bare `gh` resolved to /usr/bin/gh -- the routing wrapper
//   at ~/.local/bin/gh was not merely unconfigured, it was never executed -- and its ~/.config/gh is the
//   HUMAN account. `unitsSpendingGh` could not see it either: `unitEntryPoints` follows `node <file>`
//   and `npm run <script>`, and an out-of-tree shell script yields NEITHER, which scored identically to
//   a unit that genuinely spawns nothing.

test("#1993: an Exec command this repository cannot follow is OPAQUE, not clean", () => {
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n"),
    ["/home/agent/.local/bin/board-report-dispatch.sh"]);
  assert.deepEqual(opaqueCommands("[Service]\nExecStartPre=-/usr/bin/npm run primary:update\n"
    + "ExecStart=/usr/bin/node packages/agent-org/src/work-tick.mjs\n"), [],
  "POSITIVE CONTROL: `npm` and `node` are exactly the two this repository CAN follow into a file, so "
  + "charging them here would put the warning on every unit and therefore on none");
});

test("#1993: a unit whose ExecStart is an unshipped script must still DECLARE its account", () => {
  const opaque = "[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n";
  const stub = (unit: string) => ({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-opaque.service"]) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? unit : "")) as never,
  });
  const [spending] = unitsSpendingGh(stub(opaque));
  assert.equal(spending.opaque, true, "the reach was NOT RULED OUT rather than READ, and the field says so");
  const [f] = identityDrift(stub(opaque));
  assert.equal(f.problem, "NO IDENTITY DECLARED");
  assert.match(f.detail, /board-report-dispatch\.sh/, "it names the command, not just the unit");
  assert.match(f.detail, /UNKNOWN rather than no/,
    "and says WHY it is charged -- a reader who thinks the check read the script will go looking for a "
    + "`gh` in it and conclude the check is broken");
  assert.deepEqual(identityDrift(stub(`${opaque}Environment=GH_CONFIG_DIR=/home/agent/workers/gh\n`)), [],
    "and the SAME unit with the line is not a finding -- the rule reads the declaration");
});

test("#1993: a unit that starts nothing at all is still not charged", () => {
  // The conservative reading must stay attached to something the unit actually runs. A `.service` with
  // no Exec at all reaches nothing and cannot spend anything, and charging it would be the noise that
  // gets this whole check ignored.
  assert.deepEqual(unitsSpendingGh({
    shippedDir: "/shipped",
    readDir: (() => ["a11ign-quiet.service"]) as never,
    read: (() => "[Unit]\nDescription=nothing\n[Service]\nType=oneshot\n") as never,
  }), []);
});

test("#1993: the REMEDY LINE names the DELETION, because that is what silently stops something", () => {
  // The same seam #1974 used for the identity revert, and for the same reason: the reader who gets hurt
  // is the one who scrolled past the finding that was not theirs. `host:install` is the only command
  // this report names, so the stop has to be where every reader ends up.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE)));
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-board-report\.timer would be DELETED/,
    "and names WHICH unit -- a reader with three findings has to know which one is the live wire");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("npm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
});

test("#1993 POSITIVE CONTROL: a RETIRED orphan still gets the plain one-line remedy", () => {
  // The warning has to be capable of not firing, or it is a warning on every report and therefore on
  // none. A unit a commit here deliberately deleted is exactly what `host:install` is for.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-fleet-gated-nightly.timer"], RETIRED_HERE)));
  assert.match(report, /Remedy for all of them: npm run host:install/);
  assert.doesNotMatch(report, /DO NOT RUN/);
});

test("#1993: the board dispatch is SHIPPED, and faithful to the pair that actually runs", () => {
  // The whole row in one assertion: a unit that fires daily and appears nowhere in the tree cannot be
  // checked, reviewed or reasoned about by anything here. These values are read from the installed pair
  // on the agent host, 2026-09-22 -- the schedule and the program must not drift in the act of
  // committing them.
  const service = readFileSync(join(SHIPPED_DIR, "a11ign-board-report.service"), "utf8");
  const timer = readFileSync(join(SHIPPED_DIR, "a11ign-board-report.timer"), "utf8");
  assert.match(service, /^ExecStart=\/home\/agent\/\.local\/bin\/board-report-dispatch\.sh$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 07:10:00 Europe\/London$/m,
    "London in the expression, not resolved once into a UTC hour that drifts at each BST boundary");
  assert.match(timer, /^Persistent=true$/m, "a host asleep at 07:10 still publishes");
  assert.doesNotMatch(service, /^\[Install\]$/m,
    "and the .service has NO [Install]: `WantedBy=default.target` would dispatch another board edition "
    + "at every boot. The timer is the only thing that may start it");
});

test("#1993: the board dispatch declares the PATH that reaches this host's `gh`, and whose account", () => {
  // Measured on the agent host 2026-09-22: the user manager's PATH does not contain
  // /home/agent/.local/bin, so the script's bare `gh` was /usr/bin/gh and the routing wrapper never ran.
  // Declaring the account as well as the path is what makes the choice visible to this repository --
  // the wrapper keys on HERDR_WORKSPACE_ID, which no systemd unit has.
  const service = readFileSync(join(SHIPPED_DIR, "a11ign-board-report.service"), "utf8");
  assert.match(service, /^Environment=PATH=\/home\/agent\/\.local\/bin:/m,
    "the wrapper's directory FIRST, or the declaration changes nothing");
  assert.match(service, /^Environment=GH_CONFIG_DIR=\/home\/agent\/workers\/gh$/m,
    "the workers account: `a11ign-ai-workers` has push on a11ign/a11ign and has already dispatched four "
    + "workflow_dispatch runs there, and `board-report.yml` runs on `github.token` under its own "
    + "permissions block, so the edition does not depend on who dispatched it");
});

// --- #2000: the prune existed for 13 days and no clock ever called it --------------------------------
//
// MEASURED ON THE AGENT HOST 2026-09-22. `prune-worktrees.mjs` shipped 2026-09-09 with 45k of measured
// refusals, and `crontab -l`, `systemctl --user list-timers` and a grep of `.github/` and `work-gate.mjs`
// all came back with nothing that runs it. What that cost: 143 worktrees, 133 carrying a trailing row
// number, 124 of those belonging to CLOSED rows, `~/repos` at 16G, and the oldest leaked tree 9 days old
// rather than ancient debris. `row-claim claim` makes a worktree per claim (#1432) and about 7% were ever
// removed.
//
// The third instance of one shape in a day, after the fleet scheduler (#1858) and the corpus release
// nightly: built, tested, shipped, never wired. These tests are the wiring's own check -- `shippedUnits`
// reads the directory rather than a list, so a file in `packages/agent-org/host/` IS the installable unit.

test("#2000: the worktree prune ships as a pair, so `host:install` has something to install", () => {
  const units = shippedUnits();
  assert.ok(units.includes("a11ign-worktree-prune.service"),
    "the service, or `host:install` copies nothing and the 16G stands");
  assert.ok(units.includes("a11ign-worktree-prune.timer"),
    "and the timer, which is the only half that makes it recur -- `hostUnitsInstall` enables `.timer` "
    + "units and nothing else, so a service shipped alone is installed, inert and reported as fine");
});

test("#2000: the unit passes `--apply`, or the clock runs a REPORT and the backlog stands", () => {
  // THE HIGHEST-VALUE ASSERTION IN THIS FILE'S #2000 SET, because its failure is invisible everywhere
  // else: a unit running the bare script is installed, enabled, active, current, exits 0, writes a full
  // breakdown to the journal every hour and removes nothing. Every other check here would be green.
  //
  // The dry run is the DEFAULT deliberately (2026-09-09: a session ran `npm run worktrees:prune` to read
  // the breakdown before writing a row about worktree accounting, and removed three other sessions'
  // trees), so the flag has to be in the unit, and something has to say that it is.
  const service = readFileSync(join(SHIPPED_DIR, "a11ign-worktree-prune.service"), "utf8");
  assert.match(service, /^ExecStart=\/usr\/bin\/npm run worktrees:prune -- --apply$/m);
  assert.deepEqual(entriesFromCommand(execCommands(service)[0]),
    [join(REPO_ROOT, "packages/agent-org/src/prune-worktrees.mjs")],
    "and the command resolves through package.json to the script itself -- a renamed npm script leaves "
    + "the unit syntactically perfect and starting nothing");
  assert.match(service, /^WorkingDirectory=\/home\/agent\/repos\/a11y-witness$/m,
    "the PRIMARY checkout: `pruneWorktrees` identifies the tree it must never remove structurally, as "
    + "the one whose `.git` is a directory, so pointed at a linked worktree it would protect that one "
    + "and offer the fleet-driving checkout up instead");
  assert.doesNotMatch(service, /^\[Install\]$/m,
    "and the service has NO [Install]: `WantedBy=default.target` would also prune at boot, while `herdr` "
    + "is restoring sessions into trees that have by definition been git-quiet for longer than "
    + "ACTIVITY_WINDOW_MS. The timer's OnBootSec=15min is the deliberate version of the same idea");
});

test("#2000: the prune spends no API budget, and that is READ rather than assumed", () => {
  // ceo's 2026-09-22 ruling on #1950 refused a `work-gate.mjs` cause for this chore BECAUSE it costs no
  // API budget and needs no judgment -- a gate cause exists to WAKE somebody. So "it makes zero `gh`
  // calls" is not a remark about this unit, it is the premise that lets it run on a clock at all, and it
  // has to be checked rather than restated.
  const entry = join(REPO_ROOT, "packages/agent-org/src/prune-worktrees.mjs");
  // THE POSITIVE CONTROL, and it is the whole reason the null below means anything. `ghSpawnReachedFrom`
  // returns null for a file it cannot read exactly as it does for a file whose closure is clean, so the
  // assertion that follows would pass against a wrong path, a broken import walk, or a typo. This names
  // where the control lives: the same function, the same checkout, on a file that does reach `gh`.
  assert.equal(ghSpawnReachedFrom(join(REPO_ROOT, "packages/agent-org/src/work-tick.mjs")) !== null, true,
    "control: the import walk can find a `gh` spawn in this checkout, so a null is a reading");
  assert.equal(ghSpawnReachedFrom(entry), null,
    "the predicate is `git merge-base --is-ancestor` against origin/main; the closure is `git-env.mjs` "
    + "and `cli-flags.mjs` and reaches no `gh`");
  const spending = unitsSpendingGh();
  assert.ok(spending.length >= 3,
    `control: the population must not be empty, or absence from it is vacuous; got ${JSON.stringify(spending)}`);
  assert.ok(!spending.some((u) => u.unit === "a11ign-worktree-prune.service"),
    "so it must not appear among the units charged for an identity");
  // AND THE UNIT MUST NOT CARRY THE LINE ANYWAY. `identityDrift` only ever ASKS for a `GH_CONFIG_DIR`
  // line; nothing anywhere objects to a spurious one, so three units having it makes copying it into a
  // fourth the obvious edit -- and that line would assert this unit spends an API pool, which is the exact
  // opposite of the fact that got it scheduled.
  //
  // THIS ASSERTION IS MEANT TO COLLIDE. The day a `gh` call appears under this entry point, `identityDrift`
  // will demand the line and this will refuse it, and the collision is the point: it forces whoever made
  // that change back to #1950's ruling, which put this chore on a clock instead of a wake-cause precisely
  // because it spends nothing. A unit that quietly grew an API identity would keep the clock and lose the
  // argument for it.
  const service = readFileSync(join(SHIPPED_DIR, "a11ign-worktree-prune.service"), "utf8");
  assert.doesNotMatch(service, /^Environment=GH_CONFIG_DIR=/m,
    "no identity line: this unit spends no pool, and saying it spends one would be false as well as "
    + "unnecessary");
});

test("#2000: the timer recurs and survives a missed window", () => {
  const timer = readFileSync(join(SHIPPED_DIR, "a11ign-worktree-prune.timer"), "utf8");
  assert.match(timer, /^OnUnitActiveSec=1h$/m,
    "hourly: about 15 trees a day accumulate, one per claim, and a full pass measured 88s over 143 of "
    + "them -- and a tree cannot become removable for the 10 minutes ACTIVITY_WINDOW_MS makes it wait "
    + "anyway, so anything finer buys nothing");
  assert.match(timer, /^OnBootSec=15min$/m, "not at boot itself -- see the service's missing [Install]");
  assert.match(timer, /^Persistent=true$/m,
    "a skipped prune is invisible: the backlog it leaves looks exactly like the backlog a working prune "
    + "refused, which is `a11ign-corpus-snapshot.timer`'s nine dead days in a different costume");
});
