// no-token: gh -- `claimRefusalOf` is pure here: the filesystem questions are injected `exists` and `owner` seams
/**
 * agent-org#819: THE STUCK-CLAIM REPORT READS A KEYED ROW'S OWN TREE.
 *
 * `claimRefusalOf` looked at `wt-<n>` for every row, but a row of a KEYED repository is claimed into `wt-<key>-<n>`
 * (`claimNames`), so agent-org#724's existing `wt-agent-org-724` was never seen and nobody was told.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRefusalOf } from "./work-gate/causes/rows-claims.ts";
import { claimNames, worktreeTargetReason } from "./row-claim.ts";

const KEYED = { number: 724, repoKey: "agent-org" };
const UNKEYED = { number: 724 };
const only = (name: string) => (p: string) => p === `/w/${name}`;

test("#819 a keyed row whose wt-<key>-<n> exists and is stamped is REFUSED, naming the stamping session", () => {
  const got = claimRefusalOf(KEYED, { worktreesDir: "/w", exists: only("wt-agent-org-724"), owner: () => "worker-agent-org-724" });
  assert.ok(got !== null);
  assert.match(got, /--worktree=\.\.\/wt-agent-org-724 ALREADY EXISTS, stamped by `worker-agent-org-724`/);
});

test("#819 the same keyed row with only the UNKEYED wt-<n> present is NOT refused", () => {
  assert.equal(claimRefusalOf(KEYED, { worktreesDir: "/w", exists: only("wt-724"), owner: () => "worker-724" }), null);
});

test("#819 an unkeyed row (no key, or the empty one) is unchanged: wt-<n> refuses, wt-<key>-<n> does not", () => {
  for (const row of [UNKEYED, { number: 724, repoKey: "" }]) {
    const got = claimRefusalOf(row, { worktreesDir: "/w", exists: only("wt-724"), owner: () => "worker-724" });
    assert.ok(got !== null && got.includes("--worktree=../wt-724 ALREADY EXISTS"));
    assert.equal(claimRefusalOf(row, { worktreesDir: "/w", exists: only("wt-agent-org-724") }), null);
  }
});

test("#819 the directory name and the words are row-claim's own, keyed and unkeyed", () => {
  for (const key of ["", "agent-org"]) {
    const { worktree } = claimNames({ key, number: 724 });
    const ours = claimRefusalOf({ number: 724, repoKey: key }, { worktreesDir: "/w", exists: only(worktree), owner: () => "worker-x" });
    const theirs = worktreeTargetReason({ branch: "agent/t-724", worktree: `../${worktree}`, issueNumber: 724 },
      { exists: () => true, owner: () => "worker-x", run: () => "" });
    assert.equal(ours, theirs, `key "${key}"`);
  }
});
