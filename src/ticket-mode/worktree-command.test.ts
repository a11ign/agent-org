// no-token: gh -- real git in repositories this file builds in its own temporary directories; nothing reaches a network remote
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { TICKET_ENV, main, makeWorktree } from "./worktree-command.ts";
import type { Git } from "./worktree.ts";

const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git: Git = async (cwd, args) => gitSync(cwd, args);

/** A clone of a remote whose default branch is `develop`, and the settings that offer it as `repo-a`. */
function machine() {
  const scratch = realpathSync(tmpDir("ticket-worktree-command-"));
  const remote = join(scratch, "remote");
  gitSync(scratch, ["init", "-q", "-b", "develop", remote]);
  gitSync(remote, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "on develop"]);
  gitSync(scratch, ["clone", "-q", remote, join(scratch, "repo-a")]);
  return parseTicketSettings({ clones: { "repo-a": join(scratch, "repo-a") }, stateDir: join(scratch, "state"), tickets: { worktreeRoot: join(scratch, "tickets") } });
}

test("the worker's chosen repository gets a worktree in the ticket's folder on the ticket's branch, and the same one again on a retry", async () => {
  const settings = machine();
  const made = await makeWorktree("repo-a", { settings, key: "NBF-1", branch: "nbf-1-fix", git });
  assert.equal(made.path, join(settings.worktreeRoot, "NBF-1", "repo-a"));
  assert.equal(gitSync(made.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "nbf-1-fix");
  const again = await makeWorktree("repo-a", { settings, key: "NBF-1", branch: "nbf-1-fix", git });
  assert.equal(again.path, made.path, "a retry continues in the earlier run's worktree");
});

test("a repository this machine does not have is refused, naming the ones it does and the wrong-repo way out", async () => {
  const settings = machine();
  await assert.rejects(makeWorktree("netbox_physical_geometry", { settings, key: "NBF-2", branch: "nbf-2", git }), /not one of this machine's repositories \(repo-a\).*wrong-repo/);
});

test("the host file the pool names wins over an AGENT_ORG_HOST the worker's profile sets", async () => {
  const settings = machine();
  const dir = tmpDir("ticket-worktree-host-");
  const poolHost = join(dir, "pool-host.json");
  writeFileSync(poolHost, JSON.stringify({ clones: settings.clones, stateDir: settings.stateDir, tickets: { worktreeRoot: settings.worktreeRoot } }));
  const made = await main(["repo-a"], { [TICKET_ENV.key]: "NBF-4", [TICKET_ENV.branch]: "nbf-4", [TICKET_ENV.host]: poolHost, AGENT_ORG_HOST: join(dir, "profile-host-that-does-not-exist.json") });
  assert.equal(made.code, 0, made.out);
  assert.ok(made.out.includes(join(settings.worktreeRoot, "NBF-4", "repo-a")));
});

test("the command needs its repository, and the ticket and branch the pool starts the worker with", async () => {
  const settings = machine();
  assert.equal((await main([], {}, () => settings)).code, 2);
  const unset = await main(["repo-a"], {}, () => settings);
  assert.equal(unset.code, 2);
  assert.match(unset.out, new RegExp(`${TICKET_ENV.key} and ${TICKET_ENV.branch} are unset`));
  const refused = await main(["nope"], { [TICKET_ENV.key]: "NBF-3", [TICKET_ENV.branch]: "nbf-3" }, () => settings);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /not one of this machine's repositories/);
});

test("--from makes the ticket's worktree from another branch, and a malformed --from is refused before git runs", async () => {
  const settings = machine();
  const remote = join(settings.clones["repo-a"], "..", "remote");
  gitSync(remote, ["checkout", "-q", "-b", "nbf-1-fit"]);
  gitSync(remote, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "on nbf-1-fit"]);
  gitSync(remote, ["checkout", "-q", "develop"]);
  const env = { [TICKET_ENV.key]: "NBF-2", [TICKET_ENV.branch]: "nbf-2-zoom" };
  const made = await main(["repo-a", "--from", "nbf-1-fit"], env, () => settings);
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /\(branch nbf-2-zoom, from nbf-1-fit\)/);
  assert.equal(gitSync(join(settings.worktreeRoot, "NBF-2", "repo-a"), ["log", "-1", "--format=%s"]).trim(), "on nbf-1-fit");
  for (const argv of [["repo-a", "--from"], ["repo-a", "--from", "--upload-pack=x"], ["repo-a", "--onto", "b"], ["repo-a", "--from", "b", "extra"]]) {
    const refused = await main(argv, env, () => settings);
    assert.deepEqual([refused.code, refused.out], [2, "usage: ticket:worktree <repo> [--from <branch>]"], argv.join(" "));
  }
});

test("A11-116: a worktree made from a stacked branch records the commit it was branched at, beside the ticket's files; one made from the default branch records none", async () => {
  const settings = machine();
  const env = { [TICKET_ENV.key]: "NBF-3", [TICKET_ENV.branch]: "nbf-3" };
  const stacked = await main(["repo-a", "--from", "develop"], env, () => settings);
  assert.equal(stacked.code, 0, stacked.out);
  const record = join(settings.stateDir, "tickets", "NBF-3", "stack-base.json");
  const sha = gitSync(join(settings.clones["repo-a"]), ["rev-parse", "origin/develop"]).trim();
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { repo: "repo-a", branch: "develop", sha }, "the repository, branch and commit it was branched at");
  const plain = await main(["repo-a"], { [TICKET_ENV.key]: "NBF-4", [TICKET_ENV.branch]: "nbf-4" }, () => settings);
  assert.equal(plain.code, 0, plain.out);
  assert.equal(existsSync(join(settings.stateDir, "tickets", "NBF-4", "stack-base.json")), false, "no --from, no record");
});
