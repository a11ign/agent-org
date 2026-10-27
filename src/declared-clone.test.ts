import { test } from "node:test";
import assert from "node:assert/strict";
import { repositoryOfClone, repositoryOfRemoteUrl, type DeclaredRepository } from "./declared-clone.ts";

const CODE: readonly DeclaredRepository[] = [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "github", repo: "a11ign/.github" }];
const noRemote = (): undefined => undefined;

test("A11-360: repositoryOfRemoteUrl reads owner/name from https and ssh remotes, keeping a leading dot, and nothing from another host", () => {
  assert.equal(repositoryOfRemoteUrl("https://github.com/a11ign/.github.git"), "a11ign/.github");
  assert.equal(repositoryOfRemoteUrl("git@github.com:a11ign/.github.git\n"), "a11ign/.github");
  assert.equal(repositoryOfRemoteUrl("https://github.com/a11ign/a11ign.github.io"), "a11ign/a11ign.github.io");
  assert.equal(repositoryOfRemoteUrl("https://gitlab.com/a11ign/x.git"), undefined);
});

test("A11-360: a clone behind an alias key resolves to its real repository, the declared one first and then its git remote, and never to a name made from the key", () => {
  assert.equal(repositoryOfClone("github", "/c/github", { code: CODE, remote: noRemote }), "a11ign/.github", "the alias is a declared key, and the declaration names the repository (`a11ign/github` is no repository)");
  assert.equal(repositoryOfClone(".github", "/c/github", { code: CODE, remote: noRemote }), "a11ign/.github", "the repository's own name is found in the declaration too");
  assert.equal(repositoryOfClone("stopgap", "/c/github", { code: CODE, remote: () => "https://github.com/a11ign/.github.git" }), "a11ign/.github", "an undeclared alias is resolved by the clone's remote");
  assert.equal(repositoryOfClone("github", "/c/github", { code: [], remote: () => "git@github.com:a11ign/.github.git" }), "a11ign/.github", "so is the alias of a repository the project does not declare");
  assert.equal(repositoryOfClone("stopgap", "/c/none", { code: CODE, remote: noRemote }), undefined, "no declaration and no remote: the key is not guessed at");
  assert.equal(repositoryOfClone("elsewhere", "/c/x", { code: CODE, remote: () => "https://gitlab.com/o/n.git" }), undefined, "another host's remote names no repository here");
});
