// no-token: none -- git is injected, or runs in a disposable repository `withGitSandbox` builds; nothing reaches the network, `gh` or a clock.
//
// #3443: THE TOOL'S CHECKOUT FOLLOWS RELEASE TAGS, NOT `origin/main`. Run from this checkout: `node --import tsx --test src/update-tool.test.ts`.
//
// Cases (1)-(4) inject git and read the recorded calls, so a mutant of the selection is killed by the list it is given; (7) is the one real-git case, because a
// fake answers any argv and a flag git rejects (exit 129) would pass a suite that never ran it. The unit-template cases (5) and (6) are in
// `packaging/host-units.test.ts`, which is where the rendered units are already compared byte for byte.
//
// a11ign/agent-org#714: THE MOVE INSTALLS THE `dependencies` A RELEASE ADDS BEFORE IT ADVANCES. Cases (D1)-(D5) run REAL git in a tool checkout cloned before the tags; only `pnpm` is
// injected (a test may not reach the registry), and what the stand-in sees -- the cwd it is run in, where the checkout and the fresh tree are at that instant -- is the evidence.
import { PROJECT_ROOT } from "./packaging/host-units-project.ts"; // FIRST: makes the tool a project, which `update-tool.ts` resolves at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyDrift, installCommand, installDependencies, installPendingFindings, restartLongRunning, satisfies, updateTool } from "./update-tool.ts";
import { liveToolVersion, toolVersionLine } from "./lib/tool-version.ts";
import { sandboxGitEnv, withGitSandbox, type GitSandbox } from "./lib/git-sandbox.ts";

/** A primary checkout as `isPrimaryWorktree` reads one (a real `.git` directory), holding nothing else: git itself is the fake. */
function withPrimaryDirectory(fn: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "update-tool-3443-")));
  try {
    mkdirSync(join(root, ".git"));
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A git that records every call and answers the three reads `updateTool` makes: the status, the tag list and HEAD. */
function fakeGit({ tags, dirty = "" }: { tags: any; dirty?: string }) {
  const calls: any[] = [];
  const run = (args: any) => {
    calls.push(args);
    if (args[0] === "status") return dirty;
    if (args[0] === "tag") return tags.map((tag: any) => `${tag}\n`).join("");
    return args[0] === "rev-parse" ? "0123abc\n" : "";
  };
  return { run, calls, checkouts: () => calls.filter((call) => call[0] === "checkout") };
}

const MIXED_TAGS = ["v0.7.9", "v0.7.10", "v0.8.0-rc1", "latest", "v0.7.8"];

test("#3443 (1): `latest` selects the newest release by NUMERIC order, ignoring a pre-release and a name that is no version", () => {
  withPrimaryDirectory((root: any) => {
    const git = fakeGit({ tags: MIXED_TAGS });
    assert.equal(updateTool(root, git.run, "latest"), "agent-org v0.7.10 (0123abc)", "it prints and returns the version and the commit");
    assert.deepEqual(git.checkouts(), [["checkout", "--detach", "refs/tags/v0.7.10", "--quiet"]],
      "v0.7.10 beats v0.7.9 (a lexical sort picks v0.7.9), v0.8.0-rc1 is no release, `latest` is no version");
  });
});

test("#3443 (1) control: with the pre-release alone, `latest` still refuses -- the list above is what kills the mutants", () => {
  withPrimaryDirectory((root: any) => {
    const git = fakeGit({ tags: ["v0.8.0-rc1", "latest"] });
    assert.throws(() => updateTool(root, git.run, "latest"), /no release tag/);
    assert.deepEqual(git.checkouts(), []);
  });
});

test("#3443 (2): a pin selects exactly that tag; an absent pin refuses BY NAME and moves nothing", () => {
  withPrimaryDirectory((root: any) => {
    const pinned = fakeGit({ tags: MIXED_TAGS });
    assert.match(updateTool(root, pinned.run, "v0.7.8"), /^agent-org v0\.7\.8 \(/);
    assert.deepEqual(pinned.checkouts(), [["checkout", "--detach", "refs/tags/v0.7.8", "--quiet"]], "the pin is chosen although v0.7.10 is newer");
    const absent = fakeGit({ tags: MIXED_TAGS });
    assert.throws(() => updateTool(root, absent.run, "v0.7.7"), /pins v0\.7\.7 and no such release tag exists/);
    assert.deepEqual(absent.checkouts(), [], "nothing moved");
    assert.throws(() => updateTool(root, fakeGit({ tags: MIXED_TAGS }).run, "v0.8.0-rc1"), /pins v0\.8\.0-rc1/, "a pre-release is no pin either");
  });
});

test("#3443 (3): the fetch NAMES TAGS, and a dirty tree is still refused with the file named before any fetch", () => {
  withPrimaryDirectory((root: any) => {
    const git = fakeGit({ tags: ["v1.0.0"] });
    updateTool(root, git.run);
    const fetches = git.calls.filter((call) => call[0] === "fetch");
    assert.equal(fetches.length, 1);
    assert.ok(fetches[0].includes("--tags"), `a plain fetch never brings a release tag down (its commit is on no branch); this one was ${fetches[0].join(" ")}`);
    const dirty = fakeGit({ tags: ["v1.0.0"], dirty: " M src/work-tick.ts\n" });
    assert.throws(() => updateTool(root, dirty.run), /uncommitted changes[\s\S]*src\/work-tick\.ts/);
    assert.deepEqual(dirty.calls.filter((call) => call[0] === "fetch" || call[0] === "checkout"), [], "refused before it fetched or moved");
  });
});

test("#3443 (4): NO TAGS refuses and issues no checkout of origin/main; the same run with one tag does check out", () => {
  withPrimaryDirectory((root: any) => {
    const none = fakeGit({ tags: [] });
    assert.throws(() => updateTool(root, none.run), /does NOT fall back to origin\/main/);
    assert.deepEqual(none.checkouts(), [], "no checkout of any kind");
    assert.ok(!none.calls.flat().some((arg) => arg.includes("origin/main")), "and no call names origin/main");
    const one = fakeGit({ tags: ["v0.1.0"] });
    updateTool(root, one.run);
    assert.equal(one.checkouts().length, 1, "POSITIVE CONTROL: the identical run with one tag checks out");
  });
});

test("#3443: the live version is READ off the checkout -- the newest release pointing at HEAD, a line for none, and a line that never throws", () => {
  const at = (answer: any) => (args: any) => (args[0] === "tag" ? answer : "9f8e7d6\n");
  assert.equal(liveToolVersion(at("v0.7.9\nv0.7.10\nsnapshot\n")), "v0.7.10");
  assert.equal(liveToolVersion(at("snapshot\n")), null, "a tag that is no release names no version");
  assert.equal(toolVersionLine(at("v0.8.3\n")), "agent-org v0.8.3");
  assert.equal(toolVersionLine(at("")), "agent-org (at no release tag: 9f8e7d6)");
  assert.match(toolVersionLine(() => { throw new Error("not a git repository"); }), /^agent-org \(version unreadable: not a git repository\)$/);
});

test("#3443: a move restarts each long-running unit with `try-restart`; an uninstalled one is a line, and a failure is SAID and does not stop the rest", () => {
  const lines: { log: string[]; error: string[] } = { log: [], error: [] };
  const out = { log: (line: any) => lines.log.push(line), error: (line: any) => lines.error.push(line) };
  const asked: any[] = [];
  const exec = (file: any, args: any) => {
    asked.push([file, ...args]);
    if (args.at(-1) === "gone.service") throw Object.assign(new Error("Unit gone.service not found."), { status: 5 });
    if (args.at(-1) === "broken.service") throw Object.assign(new Error("Failed to connect to bus"), { status: 1 });
  };
  restartLongRunning(["listen.service", "gone.service", "broken.service", "after.service"], { exec, out });
  assert.deepEqual(asked.map((call) => call.slice(0, 3)), Array(4).fill(["systemctl", "--user", "try-restart"]), "every unit is asked, the failure not ending the walk");
  assert.deepEqual(asked.map((call) => call.at(-1)), ["listen.service", "gone.service", "broken.service", "after.service"]);
  assert.deepEqual(lines.log.map((line) => (line as any).split(" ")[0] + " " + (line as any).split(" ")[1]), ["restarted listen.service", "gone.service is", "restarted after.service"]);
  assert.equal(lines.error.length, 1, "exactly the unit that failed is reported as a failure");
  assert.match(lines.error[0], /COULD NOT RESTART broken\.service.*PREVIOUS agent-org version/);
});

/** git in a directory with every `GIT_*` variable stripped. */
const gitAt = (dir: any) => (args: any) => execFileSync("git", args, { cwd: dir, env: sandboxGitEnv(), encoding: "utf8" });

test("#3443 (7): a release commit that is NOT an ancestor of the branch, tagged, is found by a clone that had no tags -- real git", () => {
  withGitSandbox((sandbox) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "update-tool-3443-clone-")));
    try {
      sandbox.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      sandbox.commit("merge one", ["--allow-empty"]);
      // What `release.yml` does: a commit on top of the merge, pushed as the TAG alone, reachable from no branch.
      const release = (version: any) => {
        sandbox.run(["checkout", "-q", "--detach", "main"]);
        sandbox.commit(`release ${version}`, ["--allow-empty"]);
        sandbox.run(["tag", version]);
        sandbox.run(["checkout", "-q", "main"]);
        return sandbox.run(["rev-parse", `${version}^{commit}`]).trim();
      };
      // THE CLONE IS MADE BEFORE THE TAGS EXIST, as the host's was: a clone taken after them copies every tag, and the case that failed was a tool checkout
      // cloned when `agent-org` had none.
      const [tool, project] = [join(scratch, "tool"), join(scratch, "project")];
      for (const clone of [tool, project]) execFileSync("git", ["clone", "-q", sandbox.dir, clone], { env: sandboxGitEnv(), encoding: "utf8" });
      const git = gitAt(tool);
      const projectHead = gitAt(project)(["rev-parse", "HEAD"]);
      const nine = release("v1.2.9");
      const ten = release("v1.2.10");
      sandbox.commit("merge two, unreleased", ["--allow-empty"]);

      git(["fetch", "-q", "origin"]);
      assert.equal(git(["tag", "--list"]).trim(), "", "POSITIVE CONTROL: a plain `git fetch origin` brings no tag down, the release commits being on no branch");
      assert.throws(() => git(["cat-file", "-e", `${ten}^{commit}`]), "and the release commit itself is not in the clone");

      assert.equal(updateTool(tool, git), `agent-org v1.2.10 (${ten})`);
      assert.equal(git(["rev-parse", "HEAD"]).trim(), ten, "the tool is at the newest release, not at origin/main");
      assert.notEqual(git(["rev-parse", "HEAD"]).trim(), git(["rev-parse", "origin/main"]).trim());
      assert.equal(liveToolVersion(git), "v1.2.10", "and the reader says so from the checkout");

      assert.equal(updateTool(tool, git, "v1.2.9"), `agent-org v1.2.9 (${nine})`, "pinning the previous tag is the whole rollback");
      assert.equal(git(["rev-parse", "HEAD"]).trim(), nine);
      assert.throws(() => updateTool(tool, git, "v1.2.8"), /pins v1\.2\.8/);
      assert.equal(git(["rev-parse", "HEAD"]).trim(), nine, "an absent pin moved nothing");
      assert.equal(gitAt(project)(["rev-parse", "HEAD"]), projectHead, "the project checkout beside the tool was never moved");
      assert.equal(gitAt(project)(["tag", "--list"]).trim(), "", "and never fetched from");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test("#3443: the listener's journal opens with the agent-org version it loaded, and a project with no `messaging` key still prints its OFF line after it", () => {
  const listener = fileURLToPath(new URL("./messaging/listen.ts", import.meta.url));
  const ran = spawnSync(process.execPath, [listener], { encoding: "utf8", cwd: PROJECT_ROOT, env: { ...process.env, HOME: realpathSync(tmpdir()) } });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  const [first, second] = ran.stdout.split("\n");
  assert.match(first, /^agent-org (v\d+\.\d+\.\d+|\(at no release tag: \w+\)|\(version unreadable: .+\))$/, "the version is the first line");
  assert.match(second, /^messaging: OFF/, "POSITIVE CONTROL: the listener ran to its own first line after it, so the version line did not replace anything");
});

// ---- a11ign/agent-org#714: the dependencies a release adds are installed BEFORE the checkout moves ----

const writeFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const writePackage = (dir: string, dependencies: Record<string, string>) => writeFile(join(dir, "package.json"), JSON.stringify({ name: "agent-org", version: "0.0.0", dependencies }));

/** The toolchain the host's checkout holds, and what v1.0.0 asked of it (the release before agent-org#522). */
const OLD_TOOLCHAIN = { "@a11ign/toolchain": "^0.1.0" };
/** What #522 declared, and a dependency that is not in `node_modules` at all. */
const NEW_TOOLCHAIN = { "@a11ign/toolchain": "^0.7.0", "added-dep": "^1.0.0" };

type DependencyHost = { tool: string; units: string; git: (args: string[]) => string; v100: string; v101: string };

/**
 * An upstream with v1.0.0 declaring `OLD_TOOLCHAIN` and v1.0.1 as `release` makes it; a tool checkout cloned BEFORE the tags (as the host's was), detached at v1.0.0 and holding
 * `node_modules` with toolchain 0.1.2, the host's real state in the row. `units` is an empty installed-units directory, so `installPendingFindings` can look.
 */
function withDependencyHost(release: (sandbox: GitSandbox) => void, fn: (host: DependencyHost) => void) {
  withGitSandbox((sandbox) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "update-tool-714-")));
    try {
      sandbox.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      writePackage(sandbox.dir, OLD_TOOLCHAIN);
      writeFile(join(sandbox.dir, "src", "tick.ts"), "// v1.0.0\n");
      sandbox.run(["add", "."]);
      sandbox.commit("v1.0.0");
      sandbox.run(["tag", "v1.0.0"]);
      const tool = join(scratch, "tool");
      execFileSync("git", ["clone", "-q", sandbox.dir, tool], { env: sandboxGitEnv(), encoding: "utf8" });
      release(sandbox);
      sandbox.run(["add", "-A"]);
      sandbox.commit("v1.0.1");
      sandbox.run(["tag", "v1.0.1"]);
      const git = gitAt(tool);
      git(["fetch", "--force", "--tags", "--quiet", "origin"]);
      git(["checkout", "--detach", "refs/tags/v1.0.0", "--quiet"]);
      writeFile(join(tool, "node_modules", "@a11ign", "toolchain", "package.json"), JSON.stringify({ name: "@a11ign/toolchain", version: "0.1.2" }));
      const units = join(scratch, "units");
      mkdirSync(units);
      const sha = (tag: string) => git(["rev-parse", `refs/tags/${tag}^{commit}`]).trim();
      fn({ tool, units, git, v100: sha("v1.0.0"), v101: sha("v1.0.1") });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

/** v1.0.1 as #522 made it: the toolchain at `^0.7.0` and a dependency the host has never installed. */
const addsDependencies = ({ dir }: GitSandbox) => writePackage(dir, NEW_TOOLCHAIN);
/** v1.0.1 as an ordinary release is: code changes, `dependencies` do not. */
const changesCodeOnly = ({ dir }: GitSandbox) => writeFile(join(dir, "src", "tick.ts"), "// v1.0.1\n");

type PnpmCall = { file: string; args: string[]; cwd: string; path: string; toolHead: string; freshHead: string };

/**
 * `pnpm` as the move runs it, replaced: it records WHERE the checkout and the fresh tree are the moment it is called, and what a real install leaves (a `node_modules` in the cwd holding each
 * declared dependency at the version its range names), or fails as an unreachable registry does.
 */
function stubbedPnpm(host: DependencyHost, { fails = false }: { fails?: boolean } = {}) {
  const calls: PnpmCall[] = [];
  const exec = (file: string, args: string[], options: any) => {
    calls.push({ file, args, cwd: options.cwd, path: String(options.env?.PATH ?? ""), toolHead: host.git(["rev-parse", "HEAD"]).trim(), freshHead: gitAt(options.cwd)(["rev-parse", "HEAD"]).trim() });
    if (fails) throw Object.assign(new Error("Command failed: pnpm install"), { stderr: " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/@a11ign%2ftoolchain: ENOTFOUND\n" });
    const { dependencies } = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    for (const [name, range] of Object.entries(dependencies as Record<string, string>)) {
      writeFile(join(options.cwd, "node_modules", name, "package.json"), JSON.stringify({ name, version: range.replace(/^\D+/, "") }));
    }
  };
  /** `pnpmCliInvocation`, replaced: whichever pnpm this machine has is not the test's business. */
  const pnpm = (args: string[]) => ({ command: "pnpm", args });
  return { exec, pnpm, calls };
}

/** `updateTool` as `main` calls it, the install being `installDependencies` with the stand-in for pnpm. */
const moveWith = (host: DependencyHost, pnpm: ReturnType<typeof stubbedPnpm>, toolVersion = "latest") =>
  updateTool(host.tool, host.git, toolVersion, () => [], (tag) => installDependencies({ root: host.tool, tag, run: host.git, exec: pnpm.exec, pnpm: pnpm.pnpm }));

const installedVersionIn = (host: DependencyHost, name: string) => {
  const file = join(host.tool, "node_modules", name, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : null;
};

const worktrees = (host: DependencyHost) => host.git(["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "));

test("#714 (D1): a release that adds a dependency is installed in a fresh tree BEFORE the checkout advances, then node_modules is swapped in and the checkout moves", () => {
  withDependencyHost(addsDependencies, (host) => {
    const pnpm = stubbedPnpm(host);
    assert.deepEqual(dependencyDrift({ root: host.tool, tag: "v1.0.1", run: host.git }).map(({ name, wanted, installed }) => [name, wanted, installed]),
      [["@a11ign/toolchain", "^0.7.0", "0.1.2"], ["added-dep", "^1.0.0", null]], "THE PREMISE: the installed toolchain is OLDER than the one named, and the other is absent");

    assert.equal(moveWith(host, pnpm), `agent-org v1.0.1 (${host.v101})`);

    assert.equal(pnpm.calls.length, 1, "exactly one install");
    const [call] = pnpm.calls;
    assert.deepEqual([call.file, ...call.args], ["pnpm", "install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"], "no lockfile to freeze on, production dependencies only, no scripts");
    assert.equal(call.path.split(delimiter)[0], dirname(process.execPath), "the node this process runs on comes first on the PATH, so pnpm's `env node` shim finds one under systemd");
    assert.equal(call.toolHead, host.v100, "THE CHECKOUT HAD NOT ADVANCED when the install ran: that order is the whole fix");
    assert.equal(call.freshHead, host.v101, "the install ran in a tree AT the release");
    assert.equal(dirname(call.cwd), dirname(host.tool), "which is BESIDE the checkout, so the swap is a rename on one filesystem");
    assert.notEqual(call.cwd, host.tool, "and is not the live checkout, whose node_modules a running tick holds");

    assert.equal(host.git(["rev-parse", "HEAD"]).trim(), host.v101, "afterwards the checkout is at the release");
    assert.equal(installedVersionIn(host, "@a11ign/toolchain"), "0.7.0", "and holds the toolchain the release names");
    assert.equal(installedVersionIn(host, "added-dep"), "1.0.0");
    assert.deepEqual(worktrees(host), [`worktree ${host.tool}`], "the fresh tree is gone from git's list");
    assert.ok(!existsSync(call.cwd), "and from the disk");
    assert.ok(!existsSync(join(host.tool, "node_modules.superseded")), "and the superseded node_modules is not kept");
    assert.deepEqual(dependencyDrift({ root: host.tool, tag: "v1.0.1", run: host.git }), [], "so the same question now answers none");

    const again = stubbedPnpm(host);
    moveWith(host, again);
    assert.equal(again.calls.length, 0, "a second run with nothing missing installs nothing");
  });
});

test("#714 (D2): a FAILING install leaves the checkout and node_modules where they were, says so naming the command, and host:check reports host-install-pending with it", () => {
  withDependencyHost(addsDependencies, (host) => {
    const pnpm = stubbedPnpm(host, { fails: true });
    const said = moveWith(host, pnpm);

    assert.equal(pnpm.calls.length, 1, "the install was tried");
    assert.match(said, new RegExp(`^agent-org HELD at ${host.v100}, NOT moved to v1\\.0\\.1 \\(host-install-pending\\)`));
    assert.match(said, /@a11ign\/toolchain, added-dep/, "naming what is missing");
    assert.match(said, /ENOTFOUND/, "and why pnpm said it failed");
    assert.ok(said.includes("pnpm install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace"), `naming the command: ${said}`);
    assert.equal(host.git(["rev-parse", "HEAD"]).trim(), host.v100, "THE CHECKOUT DID NOT ADVANCE");
    assert.equal(installedVersionIn(host, "@a11ign/toolchain"), "0.1.2", "node_modules is untouched");
    assert.deepEqual(worktrees(host), [`worktree ${host.tool}`], "and the half-made fresh tree was removed");
    assert.equal(installedVersionIn(host, "added-dep"), null);
    assert.ok(!existsSync(join(host.tool, "node_modules.superseded")));

    const findings = installPendingFindings({ tool: host.tool, toolVersion: "latest", binDir: join(host.units, "bin"), prefix: "a11ign-", installedDir: host.units, run: host.git });
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.deepEqual([findings[0].unit, findings[0].problem], ["package.json", "host-install-pending"]);
    assert.ok(findings[0].detail.includes(installCommand(host.tool, "v1.0.1")), "the finding names the command");
    assert.match(findings[0].detail, /@a11ign\/toolchain@\^0\.7\.0 \(node_modules holds 0\.1\.2\)/, "and what the installed toolchain is");
    assert.match(findings[0].detail, /added-dep@\^1\.0\.0 \(node_modules holds none\)/);
  });
});

test("#714 (D3) negative control: a release whose dependencies are unchanged advances with NO install and raises no finding", () => {
  withDependencyHost(changesCodeOnly, (host) => {
    const pnpm = stubbedPnpm(host, { fails: true });
    assert.equal(moveWith(host, pnpm), `agent-org v1.0.1 (${host.v101})`, "advanced although an install would have failed: none was asked for");
    assert.equal(pnpm.calls.length, 0, "pnpm was never run");
    assert.equal(host.git(["rev-parse", "HEAD"]).trim(), host.v101);
    assert.deepEqual(worktrees(host), [`worktree ${host.tool}`], "and no fresh tree was made");
    assert.deepEqual(installPendingFindings({ tool: host.tool, toolVersion: "latest", binDir: join(host.units, "bin"), prefix: "a11ign-", installedDir: host.units, run: host.git }), []);
  });
});

test("#714 (D4): a checkout ALREADY at a release whose dependencies it lacks (an older mover advanced it without installing) is mended by the next run, which installs and stays put", () => {
  withDependencyHost(addsDependencies, (host) => {
    host.git(["checkout", "--detach", "refs/tags/v1.0.1", "--quiet"]);
    const pnpm = stubbedPnpm(host);
    assert.equal(moveWith(host, pnpm), `agent-org v1.0.1 (${host.v101})`);
    assert.equal(pnpm.calls.length, 1, "it installed although there was no move to make");
    assert.equal(pnpm.calls[0].toolHead, host.v101);
    assert.equal(installedVersionIn(host, "@a11ign/toolchain"), "0.7.0");
    assert.equal(installedVersionIn(host, "added-dep"), "1.0.0");
  });
});

test("#714 (D5): an unpinned dependency drifts on what can be told -- absent, or a range that CHANGED -- and an unreadable range that is unchanged is left alone", () => {
  const at = (heads: Record<string, string>, declared: Record<string, string>) => (args: string[]) => {
    if (args[0] === "ls-tree") return "package.json\n";
    const ref = args[1].split(":")[0];
    return JSON.stringify({ dependencies: ref === "HEAD" ? heads : declared });
  };
  const installed = (versions: Record<string, string>) => ((path: any) => {
    const name = String(path).replace(/^.*node_modules\//, "").replace(/\/package\.json$/, "");
    if (!(name in versions)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return JSON.stringify({ version: versions[name] });
  }) as typeof readFileSync;
  const drift = (heads: Record<string, string>, declared: Record<string, string>, versions: Record<string, string>) =>
    dependencyDrift({ root: "/tool", tag: "v2.0.0", run: at(heads, declared), read: installed(versions) }).map(({ name }) => name);

  assert.deepEqual(drift({ u: ">=1 <3" }, { u: ">=1 <3" }, { u: "2.0.0" }), [], "an exotic range, unchanged, with something installed: not drift (else it reinstalls every tick)");
  assert.deepEqual(drift({ u: ">=1 <3" }, { u: ">=1 <4" }, { u: "2.0.0" }), ["u"], "the same range CHANGED: drift");
  assert.deepEqual(drift({ u: ">=1 <3" }, { u: ">=1 <3" }, {}), ["u"], "and absent is drift whatever the range");
  assert.deepEqual(drift({}, {}, {}), [], "a release that declares none has none to install");
  assert.deepEqual(dependencyDrift({ root: "/tool", tag: "v2.0.0", run: () => "", read: installed({}) }), [], "nor does a tree with no package.json");
});

test("#714: `satisfies` orders versions the way the ranges this tool declares mean, and says `null` for a range it cannot read, never `false`", () => {
  const cases: [string, string, boolean | null][] = [
    ["0.1.2", "^0.7.0", false], ["0.7.0", "^0.7.0", true], ["0.7.9", "^0.7.0", true], ["0.8.0", "^0.7.0", false], ["0.6.9", "^0.7.0", false],
    ["1.4.0", "^1.2.0", true], ["1.1.9", "^1.2.0", false], ["2.0.0", "^1.2.0", false],
    ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false],
    ["0.7.1", "~0.7.0", true], ["0.8.0", "~0.7.0", false], ["0.6.0", "~0.7.0", false],
    ["1.0.0", "1.0.0", true], ["1.0.1", "1.0.0", false], ["10.0.0", "9.0.0", false],
    ["1.2.3", "*", true],
    ["1.0.0", ">=1 <2", null], ["1.0.0", "github:a/b#v1", null], ["1.0.0", "^1.0.0 || ^2.0.0", null], ["1.0.0-rc1", "^1.0.0", null], ["not-a-version", "^1.0.0", null],
  ];
  for (const [version, range, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} against ${range}`);
});

test("#714: the move asks for the install, and `main` hands it the real one and restarts the units when only node_modules changed", () => {
  const source = readFileSync(fileURLToPath(new URL("./update-tool.ts", import.meta.url)), "utf8");
  const main = source.slice(source.indexOf("if (import.meta.url === pathToFileURL"));
  assert.match(source.slice(source.indexOf("export function updateTool"), source.indexOf("async function longRunningUnits")), /installDeps\(tag\)[\s\S]*?run\(\["checkout"/,
    "the install is asked for before the checkout call, in that order");
  assert.match(main, /installDependencies\(\{ root, tag, run \}\)/, "main installs through the real installer");
  assert.match(main, /updateTool\(root, run, homeHostConfig\(\)\.toolVersion, [^;]*installDeps\)/, "and passes it to the move, which would otherwise default to installing nothing");
  assert.match(main, /installed \|\| run\(\["rev-parse", "HEAD"\]\)/, "and a swapped node_modules restarts the long-running units though HEAD did not change");
});
