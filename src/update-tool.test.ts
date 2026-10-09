// no-token: none -- git is injected, or runs in a disposable repository `withGitSandbox` builds; nothing reaches the network, `gh` or a clock.
//
// #3443: THE TOOL'S CHECKOUT FOLLOWS RELEASE TAGS, NOT `origin/main`. Run from this checkout: `node --import tsx --test src/update-tool.test.ts`.
//
// Cases (1)-(4) inject git and read the recorded calls, so a mutant of the selection is killed by the list it is given; (7) is the one real-git case, because a
// fake answers any argv and a flag git rejects (exit 129) would pass a suite that never ran it. The unit-template cases (5) and (6) are in
// `packaging/host-units.test.ts`, which is where the rendered units are already compared byte for byte.
import { PROJECT_ROOT } from "./packaging/host-units-project.ts"; // FIRST: makes the tool a project, which `update-tool.ts` resolves at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { restartLongRunning, updateTool } from "./update-tool.ts";
import { liveToolVersion, toolVersionLine } from "./lib/tool-version.mjs";
import { sandboxGitEnv, withGitSandbox } from "./lib/git-sandbox.ts";

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
    assert.throws(() => updateTool(root, dirty.run), /uncommitted changes[\s\S]*src\/work-tick\.mjs/);
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
  const listener = fileURLToPath(new URL("./messaging/listen.mjs", import.meta.url));
  const ran = spawnSync(process.execPath, [listener], { encoding: "utf8", cwd: PROJECT_ROOT, env: { ...process.env, HOME: realpathSync(tmpdir()) } });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  const [first, second] = ran.stdout.split("\n");
  assert.match(first, /^agent-org (v\d+\.\d+\.\d+|\(at no release tag: \w+\)|\(version unreadable: .+\))$/, "the version is the first line");
  assert.match(second, /^messaging: OFF/, "POSITIVE CONTROL: the listener ran to its own first line after it, so the version line did not replace anything");
});
