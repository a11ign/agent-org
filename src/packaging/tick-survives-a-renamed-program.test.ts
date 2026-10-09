// no-token: none -- git runs in disposable repositories `withGitSandbox` builds and the installed units are files in a temp directory; nothing reaches the network, `gh` or a clock.
//
// a11ign/a11ign#4392: A MERGE THAT RENAMES A PROGRAM AN INSTALLED UNIT RUNS MUST NOT STOP THE TICK, WHICH IS THE ONLY THING THAT WAKES THE INSTALLER.
//
// On 2026-10-09 agent-org#435 renamed `work-tick.mjs` and `update-tool.mjs`; `update-tool` moved the tool's checkout under the installed `a11ign-work-tick.service`, which still
// named them, and the tick crashed (exit 70) -- while the order to run `host:install` was the tick's to deliver. These cases build that situation with REAL git (a fake answers any argv),
// a tool checkout that is a clone at the old release, and installed units as files:
//
//   (1) the incident: the move is HELD, the unit keeps its program, and the gate's order names the unit as `host-install-pending`
//   (2) positive control: a release that renames nothing a unit runs advances as before and raises nothing
//   (3) after the install (the holders name programs the release has) the held checkout advances
//   (4) the launcher is in the class: a rename of the file it `exec`s holds the move on its own
//   (5) what is NOT lost: a program already absent, an untracked `node_modules` loader, a file outside the checkout
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "./host-units-project.ts"; // FIRST: makes a fixture project the tool's, so this runs from a bare clone with no `AGENT_ORG_HOST` (#3233).
// NOT `host-units.ts`: it reaches `git log --all`, and a test file importing it joins the `history` population (`work-gate.test.ts`'s ratchet). The question is asked in `update-tool.ts` for that reason too.
import { installPendingFindings, programsLostByMove, programsNamedBy, updateTool } from "../update-tool.ts";
import { sandboxGitEnv, withGitSandbox, type GitSandbox } from "../lib/git-sandbox.ts";

/**
 * The gate's own `hostDriftOrders`, loaded AFTER the fixture project is given the one declaration key the gate reads at import and the fixture (made for `host-units.ts`) lacks:
 * `roles` and its roster. Imported statically it would refuse the fixture, and a bare clone has no other project to resolve.
 */
async function gateOrders() {
  const declaration = join(PROJECT_ROOT, ".agent-org", "project.json");
  const parsed = JSON.parse(readFileSync(declaration, "utf8"));
  writeFileSync(declaration, JSON.stringify({ roles: { dir: ".agent-org/roles" }, ...parsed }));
  mkdirSync(join(PROJECT_ROOT, ".agent-org", "roles"), { recursive: true });
  writeFileSync(join(PROJECT_ROOT, ".agent-org", "roles", "sessions.json"), JSON.stringify({ live: [], retired: [] }));
  return (await import("../work-gate.ts")).hostDriftOrders;
}

const PREFIX = "a11ign-";
const UNIT = `${PREFIX}work-tick.service`;
const LAUNCHER = "the agent-org launcher";

/** A host with the tool's checkout, the installed units and the launcher laid out under one temp directory. */
type Host = { tool: string; installedDir: string; binDir: string; git: (args: string[]) => string; sandbox: GitSandbox };

const gitAt = (dir: string) => (args: string[]) => execFileSync("git", args, { cwd: dir, env: sandboxGitEnv(), encoding: "utf8" });

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** The unit text as `toolForm` renders it for the tick: the tool's checkout is its working directory and the programs are relative to it. */
const unitNaming = (tool: string, tick: string) => [
  "[Service]",
  `WorkingDirectory=${tool}`,
  `ExecStartPre=-/usr/bin/node --import=./src/lib/crash-exit.mjs --import tsx src/update-tool.mjs`,
  `ExecStart=/usr/bin/node --import=./src/lib/crash-exit.mjs --import tsx ${tick}`,
  `ExecStartPre=-/usr/bin/env -C /elsewhere /usr/bin/node --import ${tool}/node_modules/tsx/dist/loader.mjs ${tool}/src/update-primary.mjs`,
  "",
].join("\n");

const launcherNaming = (tool: string, bin: string) => `#!/bin/sh\n# exec src/ghost.mjs is only a comment\nexec node "${tool}/${bin}" "$@"\n`;

/**
 * An upstream with release v1.0.0 (every program under its old name) and v1.0.1 made by `release`, the tool checkout cloned BEFORE the tags as the host's was and fetched the way
 * `updateTool` does, then detached at v1.0.0. Installed units and the launcher name the OLD programs, as they did at 06:05Z.
 */
function withHost(release: (sandbox: GitSandbox) => void, fn: (host: Host) => void) {
  withGitSandbox((sandbox) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tick-renamed-4392-")));
    try {
      sandbox.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      for (const file of ["work-tick.mjs", "update-tool.mjs", "update-primary.mjs", "bin.mjs", "lib/crash-exit.mjs"]) write(join(sandbox.dir, "src", file), `// ${file}\n`);
      sandbox.run(["add", "."]);
      sandbox.commit("old programs");
      sandbox.run(["tag", "v1.0.0"]);
      const tool = join(scratch, "tool");
      execFileSync("git", ["clone", "-q", sandbox.dir, tool], { env: sandboxGitEnv(), encoding: "utf8" });
      release(sandbox);
      sandbox.run(["add", "-A"]);
      sandbox.commit("the release under test");
      sandbox.run(["tag", "v1.0.1"]);
      const git = gitAt(tool);
      git(["fetch", "--force", "--tags", "--quiet", "origin"]);
      git(["checkout", "--detach", "refs/tags/v1.0.0", "--quiet"]);
      const installedDir = join(scratch, "units");
      const binDir = join(scratch, "bin");
      write(join(installedDir, UNIT), unitNaming(tool, "src/work-tick.mjs"));
      write(join(binDir, "agent-org"), launcherNaming(tool, "src/bin.ts"));
      fn({ tool, installedDir, binDir, git, sandbox });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

/** The renames #435 made, and #4389 will make to the launcher's target: `.mjs` to `.ts`. */
const renameTickPrograms = ({ run }: GitSandbox) => {
  for (const file of ["work-tick", "update-tool", "update-primary"]) run(["mv", join("src", `${file}.mjs`), join("src", `${file}.ts`)]);
};

const renameBin = ({ run }: GitSandbox) => run(["mv", "src/bin.ts", "src/bin.ts"]);

/** What `host-units.ts` adds to `hostUnitDrift` (and the gate reads from `--json`), for the tool and the units this case laid out. */
const findingsOf = (host: Host) => installPendingFindings({
  tool: host.tool, toolVersion: "latest", binDir: host.binDir, prefix: PREFIX, installedDir: host.installedDir, run: host.git,
});

const lostBy = (host: Host) => (tag: string) => programsLostByMove({
  tag, root: host.tool, run: host.git,
  holders: [{ holder: UNIT, text: unitNaming(host.tool, "src/work-tick.mjs") }, { holder: LAUNCHER, text: launcherNaming(host.tool, "src/bin.ts") }],
});

const head = (host: Host) => host.git(["rev-parse", "HEAD"]).trim();

test("#4392 (1) the incident: a release that renames the tick's programs is HELD, and the gate's order names the unit as host-install-pending", async () => {
  const hostDriftOrders = await gateOrders();
  withHost(renameTickPrograms, (host) => {
    const before = head(host);
    const said = updateTool(host.tool, host.git, "latest", lostBy(host));
    assert.equal(head(host), before, "the checkout did NOT move under the installed unit: the tick that wakes the installer still runs");
    assert.match(said, /HELD .*NOT moved to v1\.0\.1.*host-install-pending/);
    assert.match(said, new RegExp(`${UNIT} runs .*src/work-tick\\.mjs`));
    assert.doesNotMatch(said, /ghost/, "a comment in the launcher is not a program it runs");

    const findings = findingsOf(host);
    assert.ok(findings.some((f) => f.unit === UNIT && f.problem === "host-install-pending"), JSON.stringify(findings));
    const [order] = hostDriftOrders(findings);
    assert.equal(order.session, "orchestrator", "the installer is woken");
    assert.match(order.prompt, new RegExp(`${UNIT}: host-install-pending`), "with the unit's name in the order");
    assert.match(order.prompt, /src\/work-tick\.mjs/);
    assert.match(order.prompt, /worktree add --detach .* refs\/tags\/v1\.0\.1 && .*--install\) && .*update-tool\.ts/, "and the install-then-advance command, in that order");
  });
});

test("#4392 (2) positive control: a release that renames nothing a unit runs advances as before and raises no host-install-pending", () => {
  withHost(({ dir }) => write(join(dir, "src", "something-new.ts"), "// new\n"), (host) => {
    const tag = host.git(["rev-parse", "refs/tags/v1.0.1"]).trim();
    assert.deepEqual(findingsOf(host), []);
    assert.match(updateTool(host.tool, host.git, "latest", lostBy(host)), /^agent-org v1\.0\.1 \(/);
    assert.equal(head(host), tag, "it moved to the release");
  });
});

test("#4392 (3) after the install -- the holders name programs the release HAS -- the held checkout advances on the next update", () => {
  withHost(renameTickPrograms, (host) => {
    const before = head(host);
    assert.match(updateTool(host.tool, host.git, "latest", lostBy(host)), /HELD/, "CONTROL: it is held before the install");
    write(join(host.installedDir, UNIT), unitNaming(host.tool, "src/work-tick.ts").replaceAll("update-tool.mjs", "update-tool.ts").replaceAll("update-primary.mjs", "update-primary.ts"));
    assert.deepEqual(findingsOf(host), [], "the finding clears by itself once the install has run");
    const installed = [{ holder: UNIT, text: unitNaming(host.tool, "src/work-tick.ts").replaceAll("update-tool.mjs", "update-tool.ts").replaceAll("update-primary.mjs", "update-primary.ts") },
      { holder: LAUNCHER, text: launcherNaming(host.tool, "src/bin.ts") }];
    const said = updateTool(host.tool, host.git, "latest", (tag) => programsLostByMove({ tag, root: host.tool, run: host.git, holders: installed }));
    assert.match(said, /^agent-org v1\.0\.1 \(/);
    assert.notEqual(head(host), before);
    assert.equal(head(host), host.git(["rev-parse", "refs/tags/v1.0.1"]).trim());
  });
});

test("#4392 (4) the launcher is in the class: a rename of the file it execs holds the move on its own, and the finding names the launcher", () => {
  withHost(renameBin, (host) => {
    const before = head(host);
    assert.match(updateTool(host.tool, host.git, "latest", lostBy(host)), /HELD.*the agent-org launcher runs src\/bin\.mjs/);
    assert.equal(head(host), before);
    const findings = findingsOf(host);
    assert.deepEqual(findings.map((f) => [f.unit, f.problem]), [[LAUNCHER, "host-install-pending"]], "only the launcher: the unit's programs all survive");
    write(join(host.binDir, "agent-org"), launcherNaming(host.tool, "src/bin.ts"));
    assert.deepEqual(findingsOf(host), [], "and it clears when the launcher names the new file");
  });
});

test("#4392 (5) what is NOT lost: a program already absent, an untracked loader, and a file outside the checkout", () => {
  withHost(renameTickPrograms, (host) => {
    const text = [unitNaming(host.tool, "src/never-existed.mjs"), `ExecStartPre=/usr/bin/node /usr/lib/elsewhere/tool.mjs`].join("\n");
    const lost = programsLostByMove({ tag: "v1.0.1", root: host.tool, run: host.git, holders: [{ holder: UNIT, text }] });
    assert.deepEqual(lost.flatMap((l) => l.programs).sort(), ["src/update-primary.mjs", "src/update-tool.mjs"],
      "never-existed.mjs is not lost (the move cannot make it worse), node_modules/... is untracked, /usr/lib/... is not the checkout's; the two renamed programs ARE");
  });
});

test("#4392: `programsNamedBy` reads the Exec lines and the launcher's exec, resolved against the unit's last WorkingDirectory", () => {
  const unit = "[Service]\nWorkingDirectory=/t\nWorkingDirectory=/t/sub\nExecStart=/usr/bin/node --import tsx src/a.ts --flag=b.mjs\n# ExecStart=src/commented.ts\n";
  assert.deepEqual(programsNamedBy(unit, "/t"), ["sub/src/a.ts", "sub/b.mjs"]);
  assert.deepEqual(programsNamedBy(launcherNaming("/t", "src/bin.ts"), "/t"), ["src/bin.ts"]);
  assert.deepEqual(programsNamedBy("[Service]\nExecStart=/usr/bin/node src/a.ts\n", "/t"), [], "no WorkingDirectory: a relative path names nothing under the checkout");
});

test("#4392: `hostUnitDrift` includes the finding -- the wiring that lets the gate's `hostDriftOrders` see it (text pin: importing `host-units.ts` here would charge this file with history)", () => {
  const source = readFileSync(new URL("../host-units.ts", import.meta.url), "utf8");
  const drift = source.slice(source.indexOf("export function hostUnitDrift"));
  assert.match(drift.slice(0, drift.indexOf("\n}\n")), /\.\.\.hostInstallPending\(deps\)/, "hostUnitDrift spreads hostInstallPending");
  assert.match(source, /export function hostInstallPending[\s\S]*?installPendingFindings\(\{ tool: host\.tool/, "and it asks update-tool's question");
});
