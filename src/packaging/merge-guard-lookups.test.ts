/**
 * EVERY NETWORK/PROCESS LOOKUP THE RULES READ -- #455's split into `packages/agent-org/src/merge-guard/lookups.mjs`.
 * `null` on failure, never an empty answer -- most of these need a live `gh`/`git` to exercise fully, so
 * only the offline-testable parsing is driven here; each rule's own test covers what the LOOKUP feeds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupBranchTip, lookup, lookupRequiredContexts } from "../merge-guard/lookups.mjs";

test("lookupBranchTip reads the real tip of a real branch in this repo", () => {
  const tip = lookupBranchTip("main");
  assert.ok(tip, "main always has a tip");
  assert.match(tip as string, /^[0-9a-f]{40}$/, "a full sha, not an abbreviation or a ref name");
});

test("lookupBranchTip returns null for a branch that does not exist, never an empty string", () => {
  const tip = lookupBranchTip("this-branch-does-not-exist-294");
  assert.equal(tip, null);
});

test("lookup returns null on a thrown error, never lets the exception escape", () => {
  const result = lookup(() => {
    throw new Error("simulated failure");
  });
  assert.equal(result, null);
});

test("lookup returns the function's real result on success, including a falsy one", () => {
  assert.equal(lookup(() => 0), 0);
  assert.equal(lookup(() => ""), "");
  assert.equal(lookup(() => null), null);
});

/**
 * A `gh` ON `PATH` THAT PLAYS A NON-ADMIN CREDENTIAL (#2331): every `branches/main/protection*` path is a
 * 404, exactly as GitHub answers `a11ign-ai-workers` (`permissions.admin: false`), and `branches/main`
 * answers with `body`. It logs every request, so a test can assert the ADMIN endpoint was never asked for
 * rather than merely that the answer came out right -- a site that tried the admin path first and fell
 * back would pass the second and fail the first.
 */
function withNonAdminGh<T>(body: object, fn: (requests: () => string[]) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2331-"));
  const log = join(dir, "requests.log");
  writeFileSync(join(dir, "body.json"), JSON.stringify(body));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *branches/main/protection*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *branches/main) cat "${dir}/body.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath ?? ""}`;
  try {
    return fn(() => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []));
  } finally {
    process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `branches/main` as measured 2026-09-24 for `a11ign-ai-workers`. */
const PROTECTED_WITH_GATE = { name: "main", protected: true,
  protection: { enabled: true, required_status_checks: { contexts: ["gate"], enforcement_level: "everyone" } } };
/** The POSITIVE CONTROL's body: protected, but no list to read -- what a default would paper over. */
const PROTECTED_WITHOUT_LIST = { name: "main", protected: true, protection: { enabled: true } };

test("lookupRequiredContexts reads the required checks with the ADMIN endpoint answering 404 -- #2331", () => {
  withNonAdminGh(PROTECTED_WITH_GATE, (requests) => {
    assert.deepEqual(lookupRequiredContexts(), ["gate"]);
    assert.ok(requests().length > 0, "the read reached the fake `gh` at all");
    assert.ok(requests().every((r) => !r.includes("branches/main/protection")),
      `no request may name the admin-only endpoint; saw ${JSON.stringify(requests())}`);
  });
});

test("lookupRequiredContexts: a protected branch showing no list is null, not a default -- #2331's control", () => {
  // Without this, the test above is satisfied by a lookup that returns ["gate"] unconditionally.
  withNonAdminGh(PROTECTED_WITHOUT_LIST, () => {
    assert.equal(lookupRequiredContexts(), null);
  });
});
