// no-token: gh -- pure functions over a project's summary text
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoOfProject } from "./project-repo.ts";

const CLONES = ["agent-org", "control", "screenreader-worker"];

test("A11-116: a project whose summary names a clone's github.com address is planned for that clone", () => {
  assert.equal(repoOfProject("github.com/a11ign/agent-org", CLONES), "agent-org");
  assert.equal(repoOfProject("https://github.com/a11ign/control", CLONES), "control");
  assert.equal(repoOfProject("github.com/a11ign/screenreader-worker.git", CLONES), "screenreader-worker");
  assert.equal(repoOfProject("github.com/a11ign/control/", CLONES), "control");
  assert.equal(repoOfProject("Owned by the platform team. github.com/a11ign/control", CLONES), "control");
});

test("A11-116: a summary with no address, or no summary, names no repository", () => {
  assert.equal(repoOfProject(null, CLONES), null);
  assert.equal(repoOfProject(undefined, CLONES), null);
  assert.equal(repoOfProject("", CLONES), null);
  assert.equal(repoOfProject("the agent-org project", CLONES), null, "a name is not an address");
});

test("A11-116: an address to a repository that is not a clone names none, so the worker chooses", () => {
  assert.equal(repoOfProject("github.com/a11ign/retired-repo", CLONES), null);
  assert.equal(repoOfProject("github.com/a11ign/agent-org-old", CLONES), null, "a longer name is not agent-org");
  assert.equal(repoOfProject("github.com/a11ign/agent-org", []), null, "no clones, no repository");
});

test("A11-116: the repository is the address's name, never the owner or a folder", () => {
  assert.equal(repoOfProject("github.com/agent-org/control", CLONES), "control");
  assert.equal(repoOfProject("github.com/a11ign/agent-org/tree/main/src", CLONES), null, "a path into a repository names none");
});
