// no-token: gh -- `dora.ts` reaches `gh` only through the readers this file injects; the file listing is a walk of this file's own `src/` directory (#4688)
/**
 * `src/dora.ts`, a11ign/a11ign#4688: THE DORA READING AND `release-behind-main.ts` AGREE ON WHAT A RELEASABLE CHANGE IS.
 *
 * `a11ign/documents#13` touched one file under the declared releasable path, `src/mjs-ratchet.test.ts`. The release-behind-main detector excluded a test file and a changeset;
 * the DORA reading was a bare prefix match, so it counted the merge as an unreleased change and read a release as missed. One rule, now one definition: `isShipped`.
 *
 * THE POPULATION IS DERIVED: every file under this checkout's `src/`, asked of `isShipped` and of the DORA reading (through `measureRepository`, one fixture pull request
 * per file) with `releasablePaths: ["src/"]`. POSITIVE CONTROLS: both the rejected set and the accepted set are asserted non-empty, and the two named fixtures
 * (`src/x.test.ts` is not releasable, `src/x.ts` is) are run through the same reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { measureRepository } from "./dora.ts";
import { isShipped } from "./release-behind-main.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const MERGED = "2026-10-09T03:27:00Z";
const REPOSITORY = { repo: "acme/widgets", release: { kind: "tag" }, releasablePaths: ["src/"] } as Any;

/** How many releasable changes the DORA reading counted for ONE merged pull request, a repository with no release yet. */
function countedFor(pr: { paths: string[] | null, body?: string | null }): number {
  const readers = {
    releases: () => [],
    mergedPrs: () => [{ number: 13, mergedAt: MERGED, mergeCommit: "a".repeat(40), ...pr }],
    regressions: () => [],
    range: () => ({ status: "ahead", commits: [] }),
  } as Any;
  const reading = measureRepository(REPOSITORY, readers, NOW) as Any;
  return JSON.stringify(reading).includes("\"changes\":1") ? 1 : 0;
}

/** Every file under `src/` as `src/<relative path>`; a walk and not `git ls-files`, which is not available (nor scrubbed of GIT_*) wherever the suite runs from. */
function filesUnder(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}
const tracked = filesUnder(import.meta.dirname, "src/");

test("the DORA reading and `isShipped` agree on every tracked file under src/", () => {
  const rejected = tracked.filter((path) => !isShipped(path, ["src/"]));
  const accepted = tracked.filter((path) => isShipped(path, ["src/"]));
  assert.ok(rejected.some((path) => /\.test\.ts$/.test(path)), "positive control: a test file is in the tree and rejected");
  assert.ok(accepted.some((path) => /^src\/[^/]+\.ts$/.test(path) && !/\.test\./.test(path)), "positive control: a non-test src/*.ts is accepted");
  const disagreeing = tracked.filter((path) => (countedFor({ paths: [path] }) === 1) !== isShipped(path, ["src/"]));
  assert.deepEqual(disagreeing, []);
});

test("a test-only merge is not releasable and a source merge is (the fixture of a11ign/documents#13)", () => {
  assert.equal(countedFor({ paths: ["src/x.test.ts"] }), 0);
  assert.equal(countedFor({ paths: ["src/x.ts"] }), 1);
  assert.equal(countedFor({ paths: ["src/x.test.ts", ".changeset/empty.md"] }), 0);
});

test("a `no-release:` reason in the body is not releasable; a placeholder is; a truncated list still counts", () => {
  assert.equal(countedFor({ paths: ["src/x.ts"], body: "text\nno-release: internal rename" }), 0);
  assert.equal(countedFor({ paths: ["src/x.ts"], body: "no-release: <reason>" }), 1);
  assert.equal(countedFor({ paths: null }), 1);
});
