// no-token: none -- `exec` is a recorder that answers each `gh` call from a table: no GitHub CLI runs
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "../../src/plugins/manifest.ts";
import { CLONE_TIMEOUT_MS, REPOSITORY_LIST_LIMIT, cloneCommand, createRepositories, repositoryOfRemote } from "./repositories.ts";

type Call = { file: string; args: readonly string[]; options: unknown };
const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

/** An `exec` that records what it was asked to run and answers `answer(args)`. */
function recording(answer: (args: readonly string[]) => ExecResult) {
  const calls: Call[] = [];
  const exec = (file: string, args: readonly string[], options?: unknown): ExecResult => {
    calls.push({ file, args, options });
    return answer(args);
  };
  return { calls, exec };
}

const GITHUB = (args: readonly string[]): ExecResult => {
  const text = args.join(" ");
  if (text === "api user --jq .login") return ok("octo\n");
  if (text === "api user/orgs --paginate --jq .[].login") return ok("zeta-org\nacme\n");
  if (args[0] === "repo" && args[1] === "list") {
    const owner = args[2].startsWith("--") ? "octo" : args[2];
    return ok(JSON.stringify([{ name: "zed", nameWithOwner: `${owner}/zed` }, { name: "alpha", nameWithOwner: `${owner}/alpha` }]));
  }
  return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
};

test("owners are the signed-in account first, then the organisations by login, read as the person's own login", () => {
  const { calls, exec } = recording(GITHUB);
  assert.deepEqual(createRepositories({ exec }).readOwners(), [{ login: "octo", kind: "account" }, { login: "acme", kind: "organisation" }, { login: "zeta-org", kind: "organisation" }]);
  assert.deepEqual(calls.map(({ args }) => args.join(" ")), ["api user --jq .login", "api user/orgs --paginate --jq .[].login"]);
  for (const { file, options } of calls) {
    assert.equal(file, "gh");
    assert.deepEqual((options as { env: unknown }).env, {}, "no role environment: the person's own login");
  }
});

test("owners are null when the login or the organisations cannot be read", () => {
  assert.equal(createRepositories({ exec: recording(() => ({ status: 1, stdout: "", stderr: "gh: not logged in" })).exec }).readOwners(), null);
  assert.equal(createRepositories({ exec: recording((args) => (args[1] === "user" ? ok("octo\n") : { status: 1, stdout: "", stderr: "HTTP 403" })).exec }).readOwners(), null);
});

test("the account's repositories are listed with no owner argument, an organisation's with its login, archived ones left out, by name", () => {
  const { calls, exec } = recording(GITHUB);
  const repositories = createRepositories({ exec });
  assert.deepEqual(repositories.readRepositories({ login: "octo", kind: "account" }), [{ name: "alpha", fullName: "octo/alpha" }, { name: "zed", fullName: "octo/zed" }]);
  assert.deepEqual(repositories.readRepositories({ login: "acme", kind: "organisation" }), [{ name: "alpha", fullName: "acme/alpha" }, { name: "zed", fullName: "acme/zed" }]);
  assert.deepEqual(calls.map(({ args }) => args.join(" ")), [
    `repo list --no-archived --limit ${REPOSITORY_LIST_LIMIT} --json name,nameWithOwner`,
    `repo list acme --no-archived --limit ${REPOSITORY_LIST_LIMIT} --json name,nameWithOwner`,
  ]);
});

test("a list at its limit is null, not a partial list; so are a failing call and an answer of another shape", () => {
  const owner = { login: "acme", kind: "organisation" } as const;
  const full = Array.from({ length: REPOSITORY_LIST_LIMIT }, (_, at) => ({ name: `r${at}`, nameWithOwner: `acme/r${at}` }));
  assert.equal(createRepositories({ exec: recording(() => ok(JSON.stringify(full))).exec }).readRepositories(owner), null);
  const justUnder = createRepositories({ exec: recording(() => ok(JSON.stringify(full.slice(1)))).exec }).readRepositories(owner);
  assert.equal(justUnder?.length, REPOSITORY_LIST_LIMIT - 1);
  assert.equal(createRepositories({ exec: recording(() => ({ status: 1, stdout: "", stderr: "HTTP 404" })).exec }).readRepositories(owner), null);
  assert.equal(createRepositories({ exec: recording(() => ok("{}")).exec }).readRepositories(owner), null);
  assert.equal(createRepositories({ exec: recording(() => ok("[{\"name\":1}]")).exec }).readRepositories(owner), null);
});

test("a remote URL names its repository in every form a checkout's origin takes, and another host's names none", () => {
  const lab = { name: "lab", fullName: "a11ign/lab" };
  for (const url of ["https://github.com/a11ign/lab", "https://github.com/a11ign/lab.git", "https://github.com/a11ign/lab/", "http://github.com/a11ign/lab.git", "git@github.com:a11ign/lab.git", "git@github.com:a11ign/lab",
    "ssh://git@github.com/a11ign/lab.git", "git+https://github.com/a11ign/lab.git", "https://GitHub.com/a11ign/lab.git", "https://x-access-token:abc@github.com/a11ign/lab.git", "  https://github.com/a11ign/lab.git\n"]) {
    assert.deepEqual(repositoryOfRemote(url), lab, url);
  }
  assert.deepEqual(repositoryOfRemote("git@github.com:A11ign/Lab.Site.git"), { name: "Lab.Site", fullName: "A11ign/Lab.Site" }, "the owner and name as written, dots kept");
  for (const url of ["https://gitlab.com/a11ign/lab.git", "git@gitlab.com:a11ign/lab.git", "https://github.com.evil.example/a11ign/lab", "https://github.com/a11ign", "https://github.com/a11ign/lab/tree/main", "/home/me/lab", ""]) {
    assert.equal(repositoryOfRemote(url), null, url);
  }
});

test("the clone command is what a person would type, with a path a shell would split quoted", () => {
  assert.equal(cloneCommand("a11ign/lab", "/home/me/repos/lab"), "gh repo clone a11ign/lab /home/me/repos/lab");
  assert.equal(cloneCommand("a11ign/lab", "/home/me/my repos/lab"), "gh repo clone a11ign/lab '/home/me/my repos/lab'");
});

test("a clone runs `gh repo clone` as the person's own login with a ten-minute cut, and answers null once cloned", () => {
  const { calls, exec } = recording(() => ok(""));
  assert.equal(createRepositories({ exec }).cloneRepository("a11ign/lab", "/work/lab"), null);
  assert.deepEqual(calls, [{ file: "gh", args: ["repo", "clone", "a11ign/lab", "/work/lab"], options: { timeoutMs: CLONE_TIMEOUT_MS, env: {} } }]);
  assert.equal(CLONE_TIMEOUT_MS, 600_000);
});

test("a failed clone answers the first line gh printed, and a gh that cannot start answers why", () => {
  const refused = recording(() => ({ status: 1, stdout: "", stderr: "\nfatal: repository 'https://github.com/a11ign/lab/' not found\nmore\n" }));
  assert.equal(createRepositories({ exec: refused.exec }).cloneRepository("a11ign/lab", "/work/lab"), "fatal: repository 'https://github.com/a11ign/lab/' not found");
  const absent = recording(() => ({ status: null, stdout: "", stderr: "spawnSync gh ENOENT" }));
  assert.equal(createRepositories({ exec: absent.exec }).cloneRepository("a11ign/lab", "/work/lab"), "spawnSync gh ENOENT");
  const silent = recording(() => ({ status: 1, stdout: "", stderr: "" }));
  assert.match(createRepositories({ exec: silent.exec }).cloneRepository("a11ign/lab", "/work/lab") ?? "", /Command failed: gh repo clone a11ign\/lab \/work\/lab/);
});
