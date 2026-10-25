// no-token: none -- the classifier is pure, and reads a title and a branch
// A11-255: what a Dependabot pull request is to the board
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDependencyPull, majorKey, redGroupKey } from "./classify.ts";

const classify = (title: string, headRefName = "dependabot/npm_and_yarn/x") => classifyDependencyPull({ title, headRefName });

test("A11-255: an ungrouped bump whose semver major differs is a major, with the package, both versions and the major it moves to", () => {
  assert.deepEqual(classify("deps: bump @x/y from 1.4.0 to 2.0.0", "dependabot/npm_and_yarn/x/y-2.0.0"), { kind: "major", package: "@x/y", from: "1.4.0", to: "2.0.0", major: 2, ecosystem: "npm_and_yarn" });
  assert.deepEqual(classify("Bump vite from 5.4.1 to 6.0.0 in /ui"), { kind: "major", package: "vite", from: "5.4.1", to: "6.0.0", major: 6, ecosystem: "npm_and_yarn" });
  assert.deepEqual(classify("DEPS: BUMP actions/checkout FROM v4 TO v5", "dependabot/github_actions/actions/checkout-5"), { kind: "major", package: "actions/checkout", from: "v4", to: "v5", major: 5, ecosystem: "github_actions" });
  assert.equal(classify("deps(npm): bump zod from 3.23.8 to 4.0.0-beta.1").kind, "major");
});

test("A11-255: a minor, a patch and a 0.x minor are not majors: Dependabot's semver rule, which the standard configuration groups", () => {
  for (const title of ["deps: bump a from 1.4.0 to 1.5.0", "deps: bump a from 1.4.0 to 1.4.1", "deps: bump @a11ign/toolchain from 0.1.7 to 0.10.2", "deps: bump a from 0.1.7 to 0.1.8"]) {
    const update = classify(title);
    assert.equal(update.kind, "skip", title);
    assert.match((update as { reason: string }).reason, /not a major/, title);
  }
});

test("A11-255: a non-semver Actions sha move, a title that does not parse and an odd package name are skipped with the reason, never guessed at", () => {
  assert.match((classify("deps: bump actions/checkout from 3d5c1a2b to 8a1f0b3c") as { reason: string }).reason, /not both semver/);
  assert.match((classify("deps: bump actions/checkout from 1234567 to 7654321") as { reason: string }).reason, /not both semver/, "an all-digit sha is not a four-digit major");
  assert.match((classify("Update the lockfile") as { reason: string }).reason, /not "bump <package> from <a> to <b>"/);
  assert.match((classify("deps: bump `rm -rf` from 1.0.0 to 2.0.0") as { reason: string }).reason, /not "bump|package name/);
  assert.match((classify("deps: bump a;b from 1.0.0 to 2.0.0") as { reason: string }).reason, /package name/);
});

test("A11-255: a group is named by its title or its branch, and a group is never a major however its title reads", () => {
  assert.deepEqual(classify("deps: bump the npm-minor-patch group with 3 updates"), { kind: "group", group: "npm-minor-patch" });
  assert.deepEqual(classify("deps: bump the actions group across 1 directory with 2 updates"), { kind: "group", group: "actions" });
  assert.deepEqual(classify("deps: bump something", "dependabot/npm_and_yarn/ui/minor-and-patch-4a3b2c1d5e6f7a8b"), { kind: "group", group: "minor-and-patch" });
  assert.deepEqual(classify("deps: bump something", "dependabot/github_actions/actions-0123456789abcdef"), { kind: "group", group: "actions" });
  assert.equal(classify("deps: bump the weird;group group with 1 update").kind, "skip");
});

test("A11-255: the keys: a major by repository, package and major; a red group by pull request and head", () => {
  assert.equal(majorKey("o/r", { package: "@X/Y", major: 2 }), "o/r:@x/y@2");
  assert.equal(redGroupKey("o/r", 7, "abc"), "o/r#7@abc");
});
