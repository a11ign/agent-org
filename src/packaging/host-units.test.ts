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
  retiredHere, addedOnSomeRef, orphanOrigin, shellCommandWords, shellSpawnsGh, shippedHostScripts,
  supersededHostScripts, unitEntryPoints, missingUnitPrograms, workingDirectoryOf,
  programCandidates } from "../host-units.mjs";

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
 * A REAL THREE-COMMIT REPOSITORY, built here: one commit ships two units, the next deletes one of them,
 * and a third -- on a branch `main` has NOT merged -- adds one more.
 *
 * A FIXTURE AND NOT THIS CHECKOUT, which is the whole lesson of the first CI run. `retiredHere` was
 * asserted against this repository's own history ("#1941 deleted the fleet-gated nightly's units") --
 * true on the agent host, FALSE in the acceptance job, which checks out at the default depth on purpose.
 * A history bounded by whoever cloned cannot be a fixture; commits made here can.
 *
 * THE UNMERGED BRANCH IS ON THE SAME HISTORY AS THE RETIREMENT ON PURPOSE (#2013). The two questions --
 * "did a commit delete this" and "does any ref add this" -- are both TRUE of `a11ign-gone.timer`, so the
 * precedence between them can only be tested where both answers exist at once. A second fixture holding
 * one shape each could not have caught the ordering.
 * @returns {{ dir: string, git: (args: string[]) => string, pendingSha: string }}
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
  // AND A BRANCH THIS `main` HAS NOT MERGED, which is the state every host-unit row passes through
  // between installing a unit and merging the PR that ships it. `switch` back at the end, so the
  // working tree a test reads is `main`'s -- the unit must be ABSENT from it, or it is not an orphan.
  git(["switch", "-qc", "pending"]);
  writeFileSync(join(host, "a11ign-pending.timer"), "[Timer]\nOnCalendar=daily\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "ship a unit on a branch"]);
  const pendingSha = git(["rev-parse", "HEAD"]).trim();
  git(["switch", "-q", "main"]);
  return { dir, git, pendingSha };
};

/**
 * `git log --diff-filter=D` as a stub, in the two answers that mean different things (#1993). INJECTED
 * IN EVERY CASE below, so this file still spawns nothing and a stub directory never reaches a real
 * `git` that would answer about a path outside the repository.
 */
const RETIRED_HERE = () => "cafe1234cafe1234cafe1234cafe1234cafe1234\n";
const NEVER_SHIPPED_HERE = () => "";

// `git` IS TYPED BY THE REAL SIGNATURE, not inferred from whichever stub happened to be the default: the
// two #1993 stubs ignore their argument, so the inferred type was `() => string` and a stub that READS
// its argv -- which #2013's must, since the whole defect is a missing flag -- would not typecheck.
const dirs = (shipped: string[], installed: string[],
  git: (args: string[]) => string = NEVER_SHIPPED_HERE) => ({
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

// --- #2013: "no commit deleted it" was being read as "no commit ever shipped it" --------------------
//
// MEASURED 2026-09-22 21:05Z from the primary checkout, with `agent/worktree-prune-unit-2000` pushed and
// unmerged. `host:check` said `a11ign-worktree-prune.service` was ORPHANED -- NEVER SHIPPED HERE, "so it
// was installed by hand and this tree has never been able to see what it does". `git log --all --oneline
// -- packages/agent-org/host/a11ign-worktree-prune.service`, in the same checkout seconds later, named
// d77e47a29 shipping it. `retiredHere`'s `false` is true of THREE worlds -- never here, shipped on an
// unmerged ref, shipped and present -- and the middle one had no case, so it was reported as the first.
// The overstatement landed in the one message whose job is to STOP somebody acting.

/** `git log --diff-filter=D` empty, a whole history, and an ADD on some ref: the third world, as a stub. */
const SHIPPED_ON_A_REF = (sha = "d77e47a29d77e47a29d77e47a29d77e47a29d77e") => (args: string[]) => {
  if (args[0] === "rev-parse") return "false\n";
  return args.includes("--all") ? `${sha}\n` : "";
};

test("#2013: a unit added by a commit on an unmerged ref is SHIPPED, not a hand-installed mystery", () => {
  const [f] = orphanedUnits(dirs([], ["a11ign-worktree-prune.service"], SHIPPED_ON_A_REF()));
  assert.equal(f.problem, "ORPHANED -- SHIPPED ON AN UNMERGED REF d77e47a29d77",
    "the sha is IN the one-line problem: a reader with three findings needs to know which ref to go to "
    + "without reading three details");
  assert.doesNotMatch(f.detail, /NO COMMIT ON ANY REF HERE EVER SHIPPED IT/);
  assert.doesNotMatch(f.detail, /nobody here knows about/,
    "THE DONE-WHEN: the finding must stop telling the reader the remedy would delete something the "
    + "repository has never seen, when the repository has a commit that ships it");
  assert.match(f.detail, /it is\s+about to be ours/);
  assert.match(f.detail, /The remedy here is to MERGE/,
    "the remedy is INVERTED, not reworded -- merge the ref, rather than read a journal and decide "
    + "whether it is dead");
  assert.match(f.detail, /git branch -a --contains d77e47a29d77/,
    "and names the command that turns a sha into the ref carrying it, or `merge that` has no object");
  assert.notEqual(f.removesUnit, true,
    "`removesUnit` prints `this repository has no record of ever shipping it` on the REMEDY LINE, which "
    + "is the same overstatement one seam out -- sharing the flag would have moved it, not fixed it");
});

test("#2013: it still says DO NOT RUN THE REMEDY -- `host:install` would delete a unit mid-flight", () => {
  // The finding is not a downgrade to harmless. The unit is absent from THIS tree, so the one remedy
  // this report names would still delete it -- and the PR that ships it is open, so the deletion undoes
  // work already done. What changes is WHY, and therefore what the reader should do next.
  const report = driftReport(orphanedUnits(dirs([], ["a11ign-worktree-prune.service"], SHIPPED_ON_A_REF())));
  assert.match(report, /DO NOT RUN THE REMEDY YET/);
  assert.match(report, /a11ign-worktree-prune\.service would be DELETED, and commit d77e47a29d77 ships it/);
  assert.match(report, /Merge that ref first/);
  assert.doesNotMatch(report, /no record of ever\n\s+shipping it/,
    "the remedy line is where the careless reader ends up, so it is where the wrong claim did the "
    + "damage -- #1993 put it there deliberately and #2013 is why it needed a third paragraph");
  assert.ok(report.indexOf("DO NOT RUN") < report.indexOf("npm run host:install\n"),
    "ABOVE the command, as #1993's own is");
});

test("#2013: `addedOnSomeRef` reads a real unmerged branch out of a real history, through the real argv", () => {
  // AGAINST REAL `git` and a repository built here, for the reason the `retiredHere` twin gives: a stub
  // cannot catch a wrong flag, and `--all` is precisely the flag whose absence caused this row.
  const { dir, git, pendingSha } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.equal(addedOnSomeRef("a11ign-pending.timer", deps), pendingSha,
      "the unit is absent from main's tree and added by a commit only `pending` reaches -- so HEAD's own "
      + "log, which is what `retiredHere` asks, is the one history that CANNOT answer this");
    assert.equal(addedOnSomeRef("a11ign-never-existed.timer", deps), "",
      "POSITIVE CONTROL: a name no commit ever carried answers `` and not a sha, so `--all` is not "
      + "matching every commit in the repository");
    assert.equal(addedOnSomeRef("a11ign-stays.timer", deps), git(["rev-list", "--max-parents=0", "HEAD"]).trim(),
      "and a unit still in the tree names the commit that ADDED it, not the tip -- `--diff-filter=A` is "
      + "doing the work rather than the pathspec alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2013: DELETION DECIDES -- a retired unit was also ADDED once, and must not read as pending", () => {
  // THE ORDERING CONTROL, and the one assertion that fails if the two questions are asked the other way
  // round. Every retired unit has an adding commit still reachable from `--all`; verified against this
  // repository's own history, where `a11ign-fleet-gated-nightly.timer` answers both (added by 8dacbc254,
  // deleted by b65b874a8). Asking the addition question first would relabel EVERY retirement as
  // shipped-on-an-unmerged-ref -- and that finding's remedy is "merge it", which would send a reader off
  // to merge a deletion that already happened.
  const { dir, git, pendingSha } = repoWithARetirement();
  try {
    const deps = { shippedDir: join(dir, "packages/agent-org/host"), git };
    assert.notEqual(addedOnSomeRef("a11ign-gone.timer", deps), "",
      "THE CONFOUND ITSELF, asserted rather than assumed: some commit DOES add the retired unit, so the "
      + "two questions really are both true here and the precedence really is being exercised");
    assert.deepEqual(orphanOrigin("a11ign-gone.timer", deps), { state: "retired" });
    assert.deepEqual(orphanOrigin("a11ign-pending.timer", deps), { state: "unmerged", sha: pendingSha });
    assert.deepEqual(orphanOrigin("a11ign-never-existed.timer", deps), { state: "never" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2013: a SHALLOW clone cannot say `no ref adds it` either, and `orphanOrigin` keeps the UNKNOWN", () => {
  // `retiredHere` refuses to answer `never` on a bounded history (#1993). The addition question is bounded
  // the same way and by the same clone, so answering it confidently there would put the honest UNKNOWN
  // back into a confident NEVER through the new door.
  const shallow = (args: string[]) => (args[0] === "rev-parse" ? "true\n" : "");
  assert.equal(addedOnSomeRef("a11ign-pending.timer", { git: shallow }), null);
  assert.deepEqual(orphanOrigin("a11ign-pending.timer", { git: shallow }), { state: "unreadable" },
    "and it surfaces as HISTORY UNREADABLE rather than NEVER SHIPPED -- NOT ASKED and ANSWERED NO are "
    + "the substitution this file exists to stop");
  const whole = (args: string[]) => (args[0] === "rev-parse" ? "false\n" : "");
  assert.deepEqual(orphanOrigin("a11ign-pending.timer", { git: whole }), { state: "never" },
    "POSITIVE CONTROL: on a complete history the same empty log IS evidence, or `never` would be "
    + "unreachable and the #1993 finding dead");
});

test("#2013 POSITIVE CONTROL: the two #1993 states are unchanged, and were not weakened to fit", () => {
  // The done-when names these as the controls to keep passing. The new state must come from a question
  // that was not being asked, never from softening the two answers that were already right.
  const [never] = orphanedUnits(dirs([], ["a11ign-board-report.timer"], NEVER_SHIPPED_HERE));
  assert.equal(never.problem, "ORPHANED -- NEVER SHIPPED HERE");
  assert.equal(never.removesUnit, true);
  assert.equal(never.shippedOnRef, undefined);
  const [retired] = orphanedUnits(dirs([], ["a11ign-fleet-gated-nightly.timer"], RETIRED_HERE));
  assert.equal(retired.problem, "ORPHANED -- RETIRED HERE");
  assert.equal(retired.shippedOnRef, undefined);
  assert.notEqual(retired.removesUnit, true);
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
  assert.match(service, /^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/board-report-dispatch\.sh$/m,
    "#1998: the SHIPPED program, named the way the other code-running units name theirs. It read "
    + "`/home/agent/.local/bin/board-report-dispatch.sh` until then -- 31 lines of bash carried by no "
    + "commit anywhere, so every property above was a property of a file nobody here could read");
  assert.match(service, /^WorkingDirectory=\/home\/agent\/repos\/a11y-witness$/m,
    "and the checkout that repository-relative path resolves against, or systemd starts nothing");
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
    + "ACTIVITY_WINDOW_MS. Install and the calendar are the two entry points; boot is not one of them");
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

test("#2000: the prune timer is a CALENDAR timer, so `Persistent=` is not inert", () => {
  const timer = readFileSync(join(SHIPPED_DIR, "a11ign-worktree-prune.timer"), "utf8");
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:07:00$/m,
    "hourly: ~15 trees a day accumulate, one per claim, and a full pass measured 88s over 143 of them -- "
    + "and a tree cannot become removable for the 10 minutes ACTIVITY_WINDOW_MS makes it wait anyway, so "
    + "anything finer buys nothing. :07 rather than :00 for #965's reason -- the top of the hour is where "
    + "every other clock fires");
  assert.doesNotMatch(timer, /^OnBootSec=/m,
    "and NOT a boot-relative delay. The first version paired OnBootSec=15min with a comment promising the "
    + "box would settle first; measured on this host (up 9 days), a monotonic boot delay is long expired, "
    + "so the timer fired the instant `enable --now` ran. A settling claim that cannot hold is worse than "
    + "no claim");
  // PINNED SEPARATELY from the no-inert-`Persistent=` check below, because that one is satisfied by
  // DELETING the line and this one is not: an hour missed while the box was down should prune at the next
  // opportunity rather than wait for the following :07. A skipped prune is invisible -- the backlog it
  // leaves looks exactly like the backlog a working prune refused.
  assert.match(timer, /^Persistent=true$/m,
    "and the catch-up the comment claims, which only a calendar timer can actually perform");
});

// --- #2011's review, generalised: THE DIRECTIVE WAS INERT AND THE TEST ASSERTED ITS TEXT ----------------
//
// `reviewer` on #2011: "`Persistent=true` has effect for `OnCalendar` timers, not these monotonic
// triggers ... The new test only checks the directive's text and therefore passes while the behavior is
// absent." Correct, and `systemd.timer(5)` says it outright: Persistent= "only has an effect on timers
// configured with OnCalendar=".
//
// THE CHECK READS THE DIRECTORY RATHER THAN THE ONE UNIT THE REVIEW NAMED, and that is how it earns its
// place: asked of every shipped timer it immediately found `a11ign-work-tick.timer` carrying the identical
// pairing, with a comment claiming a catch-up systemd was never going to perform. A test written only
// against the prune timer would have fixed the instance and left the class.
test("#2000: no shipped timer pairs `Persistent=` with monotonic-only triggers", () => {
  const timers = shippedUnits().filter((u) => u.endsWith(".timer"));
  // THE POSITIVE CONTROL. `shippedUnits` reads a real directory, so a wrong path yields an empty list and
  // an empty list has no offenders -- the assertion below would pass over a check that had stopped working.
  assert.ok(timers.length >= 5,
    `the population must not be empty or this passes vacuously; found ${JSON.stringify(timers)}`);
  const offenders = timers
    .map((unit) => ({ unit, text: readFileSync(join(SHIPPED_DIR, unit), "utf8") }))
    .filter(({ text }) => /^Persistent=/m.test(text) && !/^OnCalendar=/m.test(text))
    .map(({ unit }) => unit);
  assert.deepEqual(offenders, [],
    "`Persistent=` has effect only on a timer configured with `OnCalendar=` (systemd.timer(5)). On a "
    + "monotonic-only timer the line is inert, and it is worse than absent: it states a catch-up the unit "
    + "does not perform, which is exactly what a reader checking whether a missed window is covered will "
    + "believe. Either give the timer an OnCalendar= expression or drop the line");
  // AND THE CONTROL IN THE OTHER DIRECTION: the rule must be capable of firing. A monotonic timer that
  // carries the line IS an offender -- asserted against a fixture, so the repository's own compliance is
  // not what makes this pass.
  const monotonicWithPersistent = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=2min\nPersistent=true\n";
  assert.equal(/^Persistent=/m.test(monotonicWithPersistent)
    && !/^OnCalendar=/m.test(monotonicWithPersistent), true,
    "NEGATIVE CONTROL: the predicate flags the exact shape a11ign-work-tick.timer carried before #2000");
  const calendarWithPersistent = "[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n";
  assert.equal(/^Persistent=/m.test(calendarWithPersistent)
    && !/^OnCalendar=/m.test(calendarWithPersistent), false,
    "and does NOT flag a calendar timer, or every nightly in this directory would be a finding");
});

// --- #2011's review, round two: THE UNIT NAMED A CAUSE IT HAD NOT DISTINGUISHED -----------------------
//
// The first answer to this blocker said the prune that ran the instant `enable --now` was issued was
// `OnBootSec=` counting from a boot 9 days earlier. Forty minutes later the same unit -- now a calendar
// timer with no `OnBootSec` anywhere in it -- ran a prune the instant it was installed again, so the
// sentence the PR shipped was known-false in the file it shipped. `product-manager`, 2026-09-22: "a
// why-comment carrying a superseded mechanism is a defect in the artefact, not prose around it."
//
// WHAT DISTINGUISHES IT, measured 22:23Z: two fresh throwaway units, identical calendar expression and
// `Persistent=true`, neither carrying a stamp file, differing ONLY in `Requires=`. The one with it ran its
// service in the same second as `enable --now`; the one without never ran its service. The two earlier
// probes could not perform that experiment, because both of them carried an expired `OnBootSec=`, which
// fires on activation by itself and masks whatever else would have.
//
// AND IT IS A CLASS RATHER THAN THIS UNIT'S QUIRK. `hostUnitsInstall` runs `enable --now` over EVERY
// shipped `.timer`, so `Requires=` in a timer silently appends "and runs once at every `host:install`" to
// its service's contract -- true today of the corpus snapshot and the corpus release nightly as much as of
// the prune. This test is what makes adding it to a fifth timer a decision somebody makes rather than a
// consequence nobody reads.
test("#2000: which shipped timers run their service at `host:install`, and which do not", () => {
  const timers = shippedUnits().filter((u) => u.endsWith(".timer"));
  const requiring = timers
    .filter((unit) => /^Requires=/m.test(readFileSync(join(SHIPPED_DIR, unit), "utf8"))).sort();
  // NEITHER SIDE OF THIS PARTITION IS AN EMPTINESS ASSERTION, which is why it needs no fixture control:
  // both lists are non-empty populations read from the real directory, so a `shippedUnits` that stopped
  // working fails both halves rather than passing vacuously.
  assert.deepEqual(requiring, [
    "a11ign-corpus-release-nightly.timer",
    "a11ign-corpus-snapshot.timer",
    "a11ign-work-tick.timer",
    "a11ign-worktree-prune.timer",
  ], "`Requires=` in a timer's [Unit] is an ordinary start dependency, so `enable --now` on the timer "
    + "starts the service too -- once, at install time, whether or not the timer was already running. "
    + "Adding a fifth entry here means that service now runs during `host:install`: say so in the unit, "
    + "and check it is a run you want unattended at an operator's keystroke");
  assert.deepEqual(timers.filter((u) => !requiring.includes(u)), ["a11ign-board-report.timer"],
    "THE CONTROL, and a measured one rather than a fixture: at the 2026-09-22 21:03Z `host:install` the "
    + "four above each started their service in that second and this one did not, though the same run "
    + "reinstalled it. It is the only shipped timer that activates its service by name alone");
  // AND THE INSTALL-TIME START IS NOT HYPOTHETICAL. The partition above only matters because the installer
  // really does issue that start job for every shipped timer; asserted through the same injected
  // `systemctl` the #1858 test uses, against the REAL shipped directory.
  const calls: string[][] = [];
  hostUnitsInstall({
    installedDir: "/installed",
    systemctl: ((args: string[]) => { calls.push(args); return ""; }) as never,
    copy: (() => undefined) as never,
    mkdir: (() => undefined) as never,
    out: () => undefined,
  });
  const enabled = calls.filter((c) => c[0] === "enable").map((c) => c[2]);
  for (const unit of requiring) {
    assert.ok(enabled.includes(unit),
      `${unit} declares Requires= but the installer never starts it, so the partition above means nothing`);
  }
});

// --- #1998: the unit shipped here and the program it starts did not ----------------------------------
//
// MEASURED ON THE AGENT HOST 2026-09-22, at `874948280`. #1993 put the two board-dispatch units under
// `packages/agent-org/host/` so the daily edition stopped being invisible to this repository, and scoped
// itself to the units. Its `ExecStart` was `/home/agent/.local/bin/board-report-dispatch.sh`:
//
//     git log --oneline --all -- '**/board-report-dispatch*'   ->  (empty)
//     wc -l /home/agent/.local/bin/board-report-dispatch.sh    ->  31
//     grep -cE '\bgh (workflow run|run list)\b' <that file>    ->  2
//
// So the unit was reviewable and the thing it ran was not. Every property #1993 declared on the unit --
// which `gh` is on the PATH, which account it spends -- was a property of a `gh` call inside a file
// nobody here could read, and the next edit to it reached production with no diff, no review and no test.
//
// THE PROGRAM IS NOT COPIED ANYWHERE, and that is the answer to the CURRENT question rather than a gap
// in it. The units live in `~/.config/systemd/user` because systemd will not read them out of the tree;
// nothing makes that demand of a script, so the tree copy IS the program and a merged edit is live at
// the next firing. A second copy would re-create #1858's own defect one level down. What that leaves is
// the leftover at `~/.local/bin`, which `supersededHostScripts` reports until somebody removes it.

test("#1998: the dispatch ships here, and it is the program that actually runs", () => {
  assert.ok(shippedHostScripts().includes("board-report-dispatch.sh"),
    "in the same directory as the unit that starts it -- the whole row in one assertion");
  const script = readFileSync(join(SHIPPED_DIR, "board-report-dispatch.sh"), "utf8");
  assert.match(script, /^set -euo pipefail$/m,
    "byte-faithful to the installed copy, whose own first act this is: a dispatch that swallowed a "
    + "failed `gh workflow run` would log a run id it never created");
  assert.equal(shellCommandWords(script).filter((w) => w === "gh").length, 2,
    "both `gh` calls, which is what the host measured: one `gh workflow run` and one `gh run list`. "
    + "The second is inside `$(...)` on an assignment line, and a reader counting line-leading words "
    + "would find one and charge the unit for half of what it spends");
  assert.match(script, /gh workflow run "\$\{WORKFLOW\}" --repo "\$\{REPO\}"/,
    "the dispatch itself, quoted from the file that has fired at 07:10 every morning since 2026-09-18");
});

test("#1998: the board dispatch's `gh` is READ, not merely not-ruled-out", () => {
  // THE DONE-WHEN, AND IT HAS TO FAIL FOR THE RIGHT REASON. `opaque: false` is also what a unit that
  // left the population reports -- by having no `Exec`, by not ending in `.service`, by a `shippedDir`
  // typo. So membership is asserted FIRST and the entry point that produced the answer is asserted by
  // name: this is green only when the script resolved and was read.
  const spending = unitsSpendingGh();
  const board = spending.find((u) => u.unit === "a11ign-board-report.service");
  assert.ok(board, "still IN the population -- `opaque` going quiet by the unit leaving is the one way "
    + "this assertion could pass while the row is undone");
  assert.equal(board.opaque, false, "the `gh` spawn was read out of the script, not inferred from a "
    + "path this repository cannot follow");
  assert.equal(board.via, join(SHIPPED_DIR, "board-report-dispatch.sh"),
    "and `via` names the file it was read from -- the entry point RESOLVED, which is the reason the "
    + "opaque branch stopped firing");
  assert.equal(board.declared, true, "#1993's identity line still stands");
  assert.deepEqual(spending.filter((u) => u.opaque), [],
    "no shipped unit starts anything this repository cannot read");
  assert.ok(spending.length >= 3, "the population is NOT EMPTY -- an emptiness assertion over a "
    + "`shippedDir` typo would read as compliance");
});

test("#1998: `unitEntryPoints` follows a shell interpreter exactly as it follows `node`", () => {
  const service = readFileSync(join(SHIPPED_DIR, "a11ign-board-report.service"), "utf8");
  assert.deepEqual(unitEntryPoints(service), [join(SHIPPED_DIR, "board-report-dispatch.sh")]);
  assert.deepEqual(entriesFromCommand("/usr/bin/bash packages/agent-org/host/board-report-dispatch.sh"),
    [join(SHIPPED_DIR, "board-report-dispatch.sh")],
    "RELATIVE TO THIS CHECKOUT and not to the `WorkingDirectory` the unit names, or the answer would be "
    + "right in the primary checkout and wrong in every worktree and in CI");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash -c 'gh workflow run x'"), [],
    "NEGATIVE CONTROL: `-c` is not a file, so it resolves to nothing and is correctly left unread "
    + "rather than guessed at");
});

test("#1998 NEGATIVE CONTROL: a shell script OUT of the tree is still OPAQUE", () => {
  // The branch #1993 added must still be reachable, or this row replaced a conservative reading with a
  // silent pass. `bash` is deliberately NOT in `ANALYSABLE_TOOLS`: an interpreter is followable only
  // when the PATH it is handed lands inside this repository.
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/usr/bin/bash /opt/vendor/dispatch.sh\n"),
    ["/usr/bin/bash /opt/vendor/dispatch.sh"]);
  assert.deepEqual(opaqueCommands("[Service]\nExecStart=/home/agent/.local/bin/board-report-dispatch.sh\n"),
    ["/home/agent/.local/bin/board-report-dispatch.sh"],
    "the exact command this unit carried until this row, still unreadable and still charged");
  assert.deepEqual(
    opaqueCommands("[Service]\nExecStart=/usr/bin/bash packages/agent-org/host/board-report-dispatch.sh\n"),
    [], "POSITIVE CONTROL: the same interpreter, a path this repository ships, and it is readable");
});

test("#1998: a shell script spawns `gh` as a WORD, which the JavaScript pattern cannot see", () => {
  assert.equal(ghSpawnReachedFrom(join(SHIPPED_DIR, "board-report-dispatch.sh")),
    join(SHIPPED_DIR, "board-report-dispatch.sh"));
  assert.deepEqual(shellCommandWords('RUN_ID="$(gh run list --repo x)"'), ["gh", "\""],
    "the `(` split: the line's own first word is an assignment, skipped, and the call sits one "
    + "substitution in. The trailing `\"` is the OVER-APPROXIMATION this reader is allowed -- splitting "
    + "on separators without matching quotes can name a fragment that is not a command, and the only "
    + "question asked of the list is whether `gh` is in it, which no dangling quote can answer yes");
  assert.deepEqual(shellCommandWords('echo "at $(date -u +%FT%TZ)"'), ["echo", "date", "\""],
    "a substitution is a command position wherever it sits, including inside a quoted argument");
  assert.equal(shellSpawnsGh('ISSUE="a11ign#1998"; gh issue view "$ISSUE"\n'), true,
    "THE WORD BOUNDARY ON THE COMMENT STRIP, and its failure direction is the dangerous one: a `#` "
    + "mid-word is an issue reference, a fragment or an anchor, and stripping from it to end-of-line "
    + "deletes a REAL `gh` call further along -- a false NEGATIVE, which here reads as a unit that "
    + "spends nobody's pool");
  assert.equal(shellSpawnsGh("# gh workflow run x\necho done\n"), false,
    "NEGATIVE CONTROL: a `gh` in a COMMENT is not a spawn -- the shape that charged row-file.mjs for a "
    + "note about the guard that read it (#804)");
  assert.equal(shellSpawnsGh("git push origin agent/gh-wrapper-1974\n"), false,
    "nor is `gh` inside a branch name, a path or a jq filter -- #1860 is this repository's own record "
    + "of `\\bgh\\b` over a whole file costing a file named after the thing it fixed");
  assert.equal(shellSpawnsGh("gh-real auth status\n"), false, "nor a DIFFERENT binary starting `gh`");
  assert.equal(shellSpawnsGh("if [ -n x ]; then /usr/bin/gh pr list; fi\n"), true,
    "POSITIVE CONTROL: past a keyword, past a separator, and by basename");
});

test("#1998: a leftover copy at ~/.local/bin is a finding, and says which way it differs", () => {
  const scripts = (hostText: string | null) => ({
    shippedDir: "/shipped",
    scriptDir: "/home/agent/.local/bin",
    readDir: (() => ["board-report-dispatch.sh", "a11ign-x.service"]) as never,
    exists: ((p: string) => hostText !== null || !String(p).startsWith("/home/agent")) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "shipped\n" : hostText)) as never,
  });
  assert.deepEqual(supersededHostScripts(scripts(null)), [],
    "POSITIVE CONTROL: no copy on the host is the correct state and must not be a finding, or this "
    + "check fires for ever and gets the whole report ignored");
  const [same] = supersededHostScripts(scripts("shipped\n"));
  assert.equal(same.problem, "SUPERSEDED COPY -- IDENTICAL FOR NOW");
  assert.equal(same.unit, "/home/agent/.local/bin/board-report-dispatch.sh");
  assert.match(same.detail, /matches the shipped file TODAY/,
    "identical is not safe, it is unchecked -- there is nothing holding the two together");
  const [drifted] = supersededHostScripts(scripts("edited by hand\n"));
  assert.equal(drifted.problem, "SUPERSEDED COPY -- ALREADY DIVERGED");
  assert.match(drifted.detail, /Read the diff before removing it/,
    "which of the two holds the change is a question this file cannot answer");
});

test("#1998: `host:check` ACTUALLY ASKS -- the check is wired, not merely written", () => {
  // THE SURVIVING MUTANT THIS TEST EXISTS FOR: deleting `...supersededHostScripts(deps)` from
  // `hostUnitDrift` killed nothing, because every other assertion here calls the function directly.
  // That is the shape this file's own #2000 block is about -- built, tested, shipped, never wired --
  // and it is the third time in this repository, so it gets an assertion rather than a habit.
  const drift = hostUnitDrift({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin", systemctl: SYSTEMD_OK,
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "a\n" : "b\n")) as never,
  });
  assert.ok(drift.some((d) => d.problem.startsWith("SUPERSEDED COPY")),
    "the command a reader actually runs is `host:check`, and it reaches `hostUnitDrift` -- a finding "
    + "no report can print is a finding nobody gets");
  assert.deepEqual(hostUnitDrift({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin", systemctl: NO_SYSTEMD,
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never, read: (() => "a\n") as never,
  }), [], "POSITIVE CONTROL: and a machine with no user systemd is told nothing about its ~/.local/bin "
    + "either -- a laptop that gets this finding is a laptop that silences the whole command");
});

test("#1998: the REMEDY LINE says the shared remedy does NOT fix it", () => {
  // The same seam #1974 and #1993 used, for the same reason: every other finding here ends at
  // `npm run host:install`, and a reader told that four times reads it the fifth time too.
  const report = driftReport(supersededHostScripts({
    shippedDir: "/shipped", scriptDir: "/home/agent/.local/bin",
    readDir: (() => ["board-report-dispatch.sh"]) as never,
    exists: (() => true) as never,
    read: ((p: string) => (String(p).startsWith("/shipped") ? "a\n" : "b\n")) as never,
  }));
  assert.match(report, /is NOT fixed by the remedy below/);
  assert.ok(report.indexOf("NOT fixed by the remedy") < report.indexOf("npm run host:install\n"),
    "ABOVE the command, not below it -- a warning under the thing it warns about is read afterwards");
  assert.match(report, /nothing in ~\/\.local\/bin/,
    "and says WHY `host:install` leaves it alone: this repository owns the a11ign-* units and owns "
    + "nothing in a directory that also holds `gh`, `gh-real` and `herdr`");
  assert.doesNotMatch(report, /DO NOT RUN THE REMEDY YET/,
    "NOT the destructive warning: running `host:install` here is harmless, it simply does not help");
});

/**
 * #2174 CONSTRAINT 3: "INSTALLED AND CURRENT" IS NOT THE CLAIM "THE PROGRAM IT NAMES EXISTS".
 *
 * `ExecStart` is repository-RELATIVE and resolves against the unit's own `WorkingDirectory=` -- a
 * DIFFERENT TREE from the one anybody installed from. So every other check in this file is structurally
 * blind to it: `unitDrift` compares shipped text against installed text, and a unit copied perfectly
 * from the tree agrees on both sides while the file it starts is absent.
 *
 * MEASURED, and it is why this exists. Closing #2173 the primary checkout happened to sit at `518de0e32`
 * and carried `board-report-dispatch.sh`, so the 06:10Z board edition would run. Had it been left at the
 * `72c8fbcd5` it held earlier that day, every reading taken that afternoon would have been IDENTICAL and
 * the firing would still have failed on a missing file.
 */
const installedStub = (units: Record<string, string>) => ({
  installedDir: "/installed",
  readDir: (() => Object.keys(units)) as never,
  read: ((path: string) => {
    const hit = units[String(path).split("/").pop() as string];
    if (hit === undefined) throw new Error(`ENOENT: ${path}`);
    return hit;
  }) as never,
});
const UNIT_WITH = (program: string) =>
  `[Service]\nWorkingDirectory=/repo\nExecStart=/usr/bin/bash ${program}\n`;

test("#2174 POSITIVE CONTROL: a unit naming a program that is not there is REPORTED", () => {
  const found = missingUnitPrograms({
    ...installedStub({ "a11ign-board-report.service": UNIT_WITH("host/gone.sh") }),
    exists: () => false,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].unit, "a11ign-board-report.service");
  assert.equal(found[0].problem, "PROGRAM MISSING");
  assert.equal(found[0].missingProgram, "/repo/host/gone.sh",
    "resolved against the unit's OWN WorkingDirectory, which is the whole point");
  assert.match(found[0].detail, /WorkingDirectory=\/repo/,
    "the finding names the directory it resolved against, so a reader can check the right tree");
});

test("#2174: a unit whose program IS there is not reported -- the matched pair", () => {
  // THE SAME UNIT TEXT, differing in exactly one thing: whether the file exists. Without this the test
  // above passes against a function that reports every unit it can see.
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "a11ign-board-report.service": UNIT_WITH("host/there.sh") }),
    exists: () => true,
  }), []);
});

test("#2174: it is a SEPARATE finding from STALE, and the shared remedy says it cannot fix it", () => {
  const [finding] = missingUnitPrograms({
    ...installedStub({ "a11ign-work-tick.service": UNIT_WITH("src/work-tick.mjs") }),
    exists: () => false,
  });
  const report = driftReport([finding]);
  // THE REMEDY LOOKS LIKE IT SHOULD WORK, which is what makes this worse than the superseded-script case:
  // `host:install` copies the unit, this unit is ALREADY correct, so re-running it changes nothing and
  // the reader is left believing it did.
  assert.match(report, /NOT fixed by the remedy below either/,
    "a reader who runs host:install on this and sees no change must have been told why beforehand");
  assert.match(report, /re-installing an already-correct unit will not create it/);
  assert.match(report, /\/repo\/src\/work-tick\.mjs/, "and it names the file that is missing");
});

test("#2174: a unit with NO WorkingDirectory is SKIPPED, never guessed at", () => {
  // A relative path would then resolve against systemd's own default, and inventing a base directory to
  // check against is how a checker starts reporting faults that are really its own.
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "a11ign-x.service": "[Service]\nExecStart=/usr/bin/bash host/gone.sh\n" }),
    exists: () => false,
  }), []);
});

test("#2174: only this repository's units are examined", () => {
  assert.deepEqual(missingUnitPrograms({
    ...installedStub({ "someone-elses.service": UNIT_WITH("host/gone.sh") }),
    exists: () => false,
  }), [], "the host runs others; those are not ours to have an opinion about");
});

test("#2174: an unreadable installed directory reports nothing rather than inventing findings", () => {
  assert.deepEqual(missingUnitPrograms({
    installedDir: "/nope",
    readDir: (() => { throw new Error("ENOENT"); }) as never,
    read: (() => "") as never,
    exists: () => false,
  }), [], "a reader that never got to look must not report a clean host OR a drifting one");
});

test("#2174: workingDirectoryOf follows systemd's own last-wins rule, and an empty value RESETS", () => {
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\n"), "/a");
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\nWorkingDirectory=/b\n"), "/b",
    "systemd takes the last of a repeated directive; a first-match read would check against a "
    + "directory the service manager has already discarded");
  assert.equal(workingDirectoryOf("WorkingDirectory=/a\nWorkingDirectory=\n"), null,
    "an empty assignment resets it to the default, which is a unit that declares no base directory");
  assert.equal(workingDirectoryOf("[Service]\nExecStart=/usr/bin/true\n"), null);
  assert.equal(workingDirectoryOf(""), null);
  assert.equal(workingDirectoryOf(null as unknown as string), null);
});

/**
 * #2174: `programCandidates` IS `entriesFromCommand` WITHOUT THE `exists` FILTER, and that filter is
 * exactly why the older function structurally cannot answer this row -- a unit naming a program that is
 * not there returns `[]` from it, indistinguishable from a unit naming no repository file at all.
 */
test("#2174: the split preserves entriesFromCommand's behaviour and exposes what it filtered away", () => {
  const deps = { repoRoot: "/repo", scripts: {} };
  assert.deepEqual(programCandidates("/usr/bin/bash host/gone.sh", deps), ["/repo/host/gone.sh"],
    "the candidate is resolved whether or not it exists");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash host/gone.sh", { ...deps, exists: () => false }), [],
    "while entriesFromCommand still answers its own question -- files that are really there");
  assert.deepEqual(entriesFromCommand("/usr/bin/bash host/gone.sh", { ...deps, exists: () => true }),
    ["/repo/host/gone.sh"], "and is unchanged when they are");
  // `npm run <script>` is followed through the WorkingDirectory's OWN package.json, which is what makes
  // `ExecStart=/usr/bin/npm run corpus:snapshot` a path rather than the opaque word `npm`.
  assert.deepEqual(programCandidates("/usr/bin/npm run snap",
    { repoRoot: "/repo", scripts: { snap: "node packages/lab/scripts/snap.mjs" } }),
  ["/repo/packages/lab/scripts/snap.mjs"]);
  assert.deepEqual(programCandidates("/usr/bin/bash -c 'something opaque'", deps), [],
    "an opaque command yields no candidate and is correctly not charged as missing");
});

test("#2174: hostUnitDrift asks the new question too, and stays silent where it always did", () => {
  assert.deepEqual(hostUnitDrift({ systemctl: NO_SYSTEMD }), [],
    "no user systemd manager is still NOT CHECKED -- the gate that keeps this whole file honest");
});

/**
 * #2174, OVER THE REAL SHIPPED UNITS rather than a fixture -- the regression test for the latent false
 * positive above. Two of the five shipped services run `/usr/bin/bash` or `/usr/bin/npm`, and one of the
 * ways a unit can be written is `bash -c`. A fixture would have let the `-c` bug survive here.
 */
test("#2174: no shipped unit is falsely charged, and every one of them is charged when it should be", () => {
  const units = Object.fromEntries(shippedUnits().map((u) =>
    [u, readFileSync(join(SHIPPED_DIR, u), "utf8")]));
  const stub = {
    installedDir: "/installed",
    readDir: (() => Object.keys(units)) as never,
    read: ((path: string) => units[String(path).split("/").pop() as string]) as never,
  };
  assert.deepEqual(missingUnitPrograms({ ...stub, exists: () => true }), [],
    "with every program present, the real shipped set is clean -- if this fails, something resolves an "
    + "option or a flag as a path");
  // THE CONTROL, and it is what makes the line above mean anything: the same real units, with nothing
  // on disk, must produce findings. An emptiness assertion over a population that resolves to nothing
  // passes for the wrong reason.
  const charged = missingUnitPrograms({ ...stub, exists: () => false });
  assert.ok(charged.length > 0,
    "the real shipped units DO name programs, so a reader that finds none is broken rather than lucky");
  for (const finding of charged) {
    assert.ok(!finding.missingProgram?.split("/").pop()?.startsWith("-"),
      `an option was resolved as a path: ${finding.missingProgram}`);
  }
});

/**
 * #2174, FOUND BY MUTATION: the `text === null` skip in `missingForUnit` survived deletion, because no
 * test had a unit that `readDir` LISTS and `read` cannot open. That is a real state -- a unit removed
 * between the listing and the read, or one this process may not read -- and it is `unitDrift`'s finding
 * rather than this one's. Without the skip, `workingDirectoryOf(null)` returns null and the unit is
 * silently dropped anyway, so the mutant is invisible until `workingDirectoryOf` changes; this pins the
 * behaviour at the boundary that owns it instead.
 */
test("#2174: a unit that is listed but cannot be READ yields no finding and does not throw", () => {
  const found = missingUnitPrograms({
    installedDir: "/installed",
    readDir: (() => ["a11ign-vanished.service"]) as never,
    read: (() => { throw new Error("ENOENT: it went away between the listing and the read"); }) as never,
    exists: () => false,
  });
  assert.deepEqual(found, [],
    "an unreadable unit is `unitDrift`'s finding -- guessing at what it starts would report a second "
    + "fault for one cause");
});
