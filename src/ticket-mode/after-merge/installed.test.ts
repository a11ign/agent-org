// no-token: none -- the tool folder is a temporary directory
// A11-302: a change counts as installed when the release this instance runs holds its pull request's acceptance file, or, for another repository's, once its own release has had time
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { holdsChange, isInstalled, mergesIn, ownRepositoryOf, OTHER_REPOSITORY_GRACE_MS } from "./installed.ts";

/** A tool folder of the repository `repository`, whose release holds the acceptance files named `accepted`. */
function toolFolder(repository: string, accepted: readonly string[]): string {
  const root = tmpDir("installed-tool-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-org", repository: { type: "git", url: `git+https://github.com/${repository}.git` } }));
  mkdirSync(join(root, ".acceptance"), { recursive: true });
  for (const name of accepted) writeFileSync(join(root, ".acceptance", name), "x");
  return root;
}

const OWN = "https://github.com/a11ign/agent-org/pull/1960";
const OTHER = "https://github.com/a11ign/control/pull/9";

test("A11-302: the tool's repository is read from its package, and a tool folder holds a ticket's change when its release shipped that pull request's acceptance file", () => {
  const root = toolFolder("a11ign/agent-org", ["admin~a11-301-the-board-lists-it.md", "test~suite-off-the-network.md"]);
  assert.equal(ownRepositoryOf(root), "a11ign/agent-org");
  assert.equal(ownRepositoryOf(tmpDir("no-package-")), null);
  assert.equal(holdsChange(root, "A11-301"), true);
  assert.equal(holdsChange(root, "A11-30"), false, "a ticket whose key only starts the same is another ticket");
  assert.equal(holdsChange(root, "A11-302"), false);
  assert.equal(holdsChange(tmpDir("no-acceptance-"), "A11-301"), false);
});

test("A11-302: a change merged into the tool's repository is installed only when the running release holds it; one merged into another repository, once its own release has had an hour", () => {
  const root = toolFolder("a11ign/agent-org", ["admin~a11-301-x.md"]);
  let now = 10_000_000;
  const merges: Record<string, { url: string; at: number }[]> = { "A11-301": [{ url: OWN, at: now - 1 }], "A11-302": [{ url: OWN, at: now - 1 }], "A11-303": [{ url: OTHER, at: now - 1000 }], "A11-304": [{ url: OWN, at: now - 1 }, { url: OTHER, at: now - 2 * OTHER_REPOSITORY_GRACE_MS }] };
  const justMerged = { url: OWN, at: now + OTHER_REPOSITORY_GRACE_MS };
  const reads = { toolRoot: root, now: () => now, merges: (key: string) => merges[key] ?? [] };
  assert.equal(isInstalled(reads, "A11-301"), true, "the release holds the pull request");
  assert.equal(isInstalled(reads, "A11-302"), false, "merged, not released: the running release does not hold it");
  assert.equal(isInstalled(reads, "A11-303"), false, "another repository's change, merged a moment ago");
  now += OTHER_REPOSITORY_GRACE_MS;
  assert.equal(isInstalled(reads, "A11-303"), true, "and after the hour");
  assert.equal(isInstalled(reads, "A11-304"), false, "every pull request of the ticket must be installed");
  assert.equal(isInstalled(reads, "A11-399"), true, "a ticket whose merges the run log no longer holds reads as installed");
  merges["A11-305"] = [justMerged];
  assert.equal(isInstalled({ ...reads, toolRoot: undefined }, "A11-305"), false, "with no tool folder an own-repository change is judged as another repository's: by time");
  assert.equal(isInstalled({ ...reads, toolRoot: undefined }, "A11-302"), true, "and an old one reads as installed");
});

test("A11-302: the merges of a ticket are read out of its run log", () => {
  assert.deepEqual(mergesIn([{ kind: "started", model: "m", effort: "e", instance: null, at: 1 }, { kind: "merged", url: OWN, at: 5 }]), [{ url: OWN, at: 5 }]);
  assert.deepEqual(mergesIn(undefined), []);
});
