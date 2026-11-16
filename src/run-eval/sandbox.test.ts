// no-token: gh -- runs real `git` against local repositories in temporary directories and the eval's own stand-ins; nothing here reaches GitHub, the tracker or a model
/**
 * A11-431: NOTHING LEAVES THE MACHINE during an eval. The throwaway clone holds the base sha and not the merged answer, its only remote is a local bare repository, git refuses any
 * URL that is not a local path, and the stand-ins record a pull request and refuse every other call to the code host, the tracker or the board.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ATTEMPTS_FILE, cloneAt, EVAL_PULL_URL, offlineEnv, PULL_BODY_FILE, shellWord, writeStandIns, type Git } from "./sandbox.ts";

const git: Git = (args, cwd) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (repo: string, file: string, text: string): string => {
  writeFileSync(join(repo, file), text);
  git(["add", file], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", file], repo);
  return git(["rev-parse", "HEAD"], repo).trim();
};

/** A source repository with a base commit and the merged answer after it, and the eval's clone of the base. */
function cloned() {
  const root = tmpDir("run-eval-sandbox-");
  const source = join(root, "source");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", source], { env: sandboxGitEnv() });
  const base = commit(source, "a.txt", "base\n");
  const answer = commit(source, "b.txt", "the merged answer\n");
  const place = { origin: join(root, "origin.git"), clone: join(root, "clone"), folder: join(root, "folder"), record: join(root, "record"), standIns: join(root, "bin"), ghConfig: join(root, "gh-config"), noHost: join(root, "no-host.json") };
  cloneAt(git, { source, sha: base, origin: place.origin, clone: place.clone });
  writeStandIns(place.standIns, { record: place.record, clones: { "agent-org": place.clone }, folder: place.folder, branch: "admin/a11-1-x" });
  const env = offlineEnv({ ...process.env, GH_TOKEN: "secret" }, place);
  const sh = (command: string, cwd: string = root) => spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  return { root, source, base, answer, place, env, sh };
}

test("the clone is at the base sha, and neither it nor its origin holds the merged answer", () => {
  const { base, answer, place } = cloned();
  assert.equal(git(["rev-parse", "HEAD"], place.clone).trim(), base);
  assert.equal(git(["branch", "--show-current"], place.clone).trim(), "main");
  for (const repo of [place.clone, place.origin]) {
    assert.throws(() => git(["cat-file", "-e", `${answer}^{commit}`], repo), Error, `${repo} must not hold the merged commit`);
  }
});

test("the clone's only remote is the local bare origin, so a push lands in the eval's folder", () => {
  const { place, sh } = cloned();
  const urls = git(["remote", "-v"], place.clone).trim().split("\n").map((line) => line.split(/\s+/)[1]);
  assert.deepEqual([...new Set(urls)], [place.origin]);
  commit(place.clone, "c.txt", "work\n");
  const pushed = sh("git push --quiet origin HEAD:refs/heads/eval", place.clone);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(git(["rev-parse", "refs/heads/eval"], place.origin).trim(), git(["rev-parse", "HEAD"], place.clone).trim());
});

test("a push to a URL that is not a local path is refused by git before it connects", () => {
  const { place, sh } = cloned();
  const pushed = sh("git push https://github.com/a11ign/agent-org.git HEAD:refs/heads/eval-escape", place.clone);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /transport 'https' not allowed/);
  const ssh = sh("git push git@github.com:a11ign/agent-org.git HEAD:refs/heads/eval-escape", place.clone);
  assert.match(ssh.stderr, /transport 'ssh' not allowed/);
});

/** Run `command` through the stand-ins, with `body` as `body.md` when given, and read back its exit, its answer and the pull request it recorded. */
function recordedPull(command: string, body?: string) {
  const { root, place, sh } = cloned();
  if (body !== undefined) writeFileSync(join(root, "body.md"), body);
  const ran = sh(command);
  return { ran, pull: readFileSync(join(place.record, PULL_BODY_FILE), "utf8"), attempts: readFileSync(join(place.record, ATTEMPTS_FILE), "utf8") };
}

test("`gh pr create` is recorded, never sent: its title and body are kept and it answers with an .invalid URL", () => {
  const { ran, pull, attempts } = recordedPull("gh pr create --base main --title 'feat: x' --body-file body.md", "Closes A11-1\n");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), EVAL_PULL_URL);
  assert.equal(pull, "# feat: x\n\nCloses A11-1\n");
  assert.match(attempts, /^gh pr create --base main --title feat: x --body-file body\.md$/m);
});

test("a pull request whose --title has no value is still recorded, not ended by the shell's shift", () => {
  const { ran, pull } = recordedPull("gh pr create --title");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), EVAL_PULL_URL);
  assert.equal(pull, "# \n\n");
});

test("the brief's pull-request command is recorded the same way", () => {
  const { ran, pull } = recordedPull("eval-pr-open create --title 't' --body-file body.md", "body\n");
  assert.equal(ran.stdout.trim(), EVAL_PULL_URL);
  assert.equal(pull, "# t\n\nbody\n");
});

test("every other `gh` call, and every `agent-org` call, is refused and recorded", () => {
  const { place, sh } = cloned();
  const calls = ["gh api repos/a11ign/agent-org/issues -f title=x", "gh issue create --title x", "agent-org ticket:comment A11-1 hi"];
  for (const command of calls) {
    const ran = sh(command);
    assert.equal(ran.status, 1, command);
    assert.match(ran.stderr, /stand-in in an offline eval; nothing was sent/);
  }
  assert.deepEqual(readFileSync(join(place.record, ATTEMPTS_FILE), "utf8").trim().split("\n"), calls);
  assert.equal(existsSync(join(place.record, PULL_BODY_FILE)), false);
});

test("the brief's worktree command makes a worktree of the local clone on the ticket's branch, and again gives it back", () => {
  const { base, place, sh } = cloned();
  for (const round of [1, 2]) {
    const made = sh("eval-worktree agent-org");
    assert.equal(made.status, 0, `round ${round}: ${made.stderr}`);
  }
  const tree = join(place.folder, "agent-org");
  assert.equal(git(["branch", "--show-current"], tree).trim(), "admin/a11-1-x");
  assert.equal(git(["rev-parse", "HEAD"], tree).trim(), base);
  assert.notEqual(sh("eval-worktree screenreader-worker").status, 0, "a repository the eval did not clone has no worktree");
});

test("`tailscale` is a stand-in, so a test the worker runs cannot switch off the board's serves", () => {
  const { place, sh } = cloned();
  assert.equal(sh("tailscale serve reset").status, 0);
  assert.match(readFileSync(join(place.record, ATTEMPTS_FILE), "utf8"), /^tailscale serve reset$/m);
});

test("the offline environment drops credentials, git redirects and the board's variables, names a host file that does not exist, and keeps Claude's own", () => {
  const env = offlineEnv({ PATH: "/usr/bin", HOME: "/home/x", GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_HOST: "c", LINEAR_API_KEY: "d", NPM_TOKEN: "e", MY_SECRET: "f", GIT_DIR: "/real/.git",
    AGENT_ORG_HOST: "/host.json", AGENT_ORG_TICKET_KEY: "A11-1", CLAUDE_CODE_OAUTH_TOKEN: "g", ANTHROPIC_API_KEY: "h" }, { standIns: "/eval/bin", ghConfig: "/eval/gh", noHost: "/eval/no-host.json" });
  assert.deepEqual(env, { PATH: "/eval/bin:/usr/bin", HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "g", ANTHROPIC_API_KEY: "h", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: "/eval/gh", GH_PROMPT_DISABLED: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", AGENT_ORG_HOST: "/eval/no-host.json" });
});

test("shellWord quotes a single quote", () => {
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellWord("it's $HOME")}`], { encoding: "utf8" }), "it's $HOME");
});
