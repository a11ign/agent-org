// no-token: gh -- B4's two comparisons are pure functions of the lists they are given; nothing here reaches the network (agent-org#464)
/**
 * agent-org#464: B4 DOES NOT SHELVE A ROW ON A SHARED MANIFEST ALONE. `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` at a
 * repository's ROOT join the changesets in the exclusion, on every side: the asking row's Region, the other pull request's files and the
 * claimed-row reservation. Two PRs editing different lines of a manifest merge cleanly; two editing the same line conflict, where the
 * merge queue says so.
 *
 * Each exclusion has its NEGATIVE CONTROL in the same test: the same two sides sharing `src/x.ts` as well ARE refused, naming `src/x.ts`
 * and not the manifest, so the silence is read against a refusal the inputs could have produced. A subdirectory's `package.json` still
 * collides; a `.changeset/` entry behaves as before.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT IS A RECORDED ONE (`claimed-region-overlap.test.ts`'s preamble): the host file is set FIRST and the tool imported AFTER it.
const SCRATCH = mkdtempSync(join(tmpdir(), "shared-manifest-overlap-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
process.chdir(PROJECT);

const { fileOverlapReason, claimedRegionOverlapReason } = await import("./row-claim/file-overlap-rule.ts");

/** An open pull request of the first repository whose file list is complete. */
const pr = (number: number, files: string[]) => ({ number, files, changedFiles: files.length });
const claimed = (number: number, files: string[]) => ({ number, files });

for (const manifest of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  test(`(1) a pull request sharing only the root ${manifest} is not an overlap; sharing src/x.ts as well is, naming src/x.ts`, () => {
    const alone = fileOverlapReason([manifest, "src/a.ts"], [pr(7, [manifest, "src/b.ts"])]);
    assert.equal(alone.reason, null);
    const withFile = fileOverlapReason([manifest, "src/x.ts"], [pr(7, [manifest, "src/x.ts"])]).reason;
    assert.match(withFile ?? "", /already touches: src\/x\.ts\b/);
    assert.doesNotMatch(withFile ?? "", new RegExp(manifest.replace(".", "\\.")));
  });

  test(`(2) a claimed row sharing only the root ${manifest} is not an overlap; sharing src/x.ts as well is, naming src/x.ts`, () => {
    assert.equal(claimedRegionOverlapReason([manifest, "src/a.ts"], [claimed(9, [manifest, "src/b.ts"])]), null);
    const withFile = claimedRegionOverlapReason([manifest, "src/x.ts"], [claimed(9, [manifest, "src/x.ts"])]);
    assert.match(withFile ?? "", /which declares: src\/x\.ts\./);
    assert.doesNotMatch(withFile ?? "", new RegExp(manifest.replace(".", "\\.")));
  });
}

test("(3) a row whose Region is ONLY the manifests asks nothing of a pull request and is not refused as empty", () => {
  const onlyManifests = ["package.json", "pnpm-lock.yaml"];
  assert.deepEqual(fileOverlapReason(onlyManifests, [pr(7, ["package.json", "pnpm-lock.yaml"])]), { reason: null, emptyOtherPrs: [] });
  assert.equal(claimedRegionOverlapReason(onlyManifests, [claimed(9, onlyManifests)]), null);
});

test("(4) packages/x/package.json is not the root: the same subdirectory manifest on both sides IS refused, as a PR and as a claimed row", () => {
  const prReason = fileOverlapReason(["packages/x/package.json"], [pr(7, ["packages/x/package.json"])]).reason;
  assert.match(prReason ?? "", /already touches: packages\/x\/package\.json/);
  const rowReason = claimedRegionOverlapReason(["packages/x/package.json"], [claimed(9, ["packages/x/package.json"])]);
  assert.match(rowReason ?? "", /which declares: packages\/x\/package\.json/);
  // control: the root manifest of the very same pull request is the silent one
  assert.equal(fileOverlapReason(["package.json"], [pr(7, ["packages/x/package.json", "package.json"])]).reason, null);
});

test("(5) a `<key>:package.json` entry is another repository's root manifest: against a bare `package.json` it is no match, either way round", () => {
  assert.equal(claimedRegionOverlapReason(["agent-org:package.json", "src/a.ts"], [claimed(9, ["package.json", "src/b.ts"])]), null);
  assert.equal(claimedRegionOverlapReason(["package.json", "src/a.ts"], [claimed(9, ["agent-org:package.json", "src/b.ts"])]), null);
  assert.equal(fileOverlapReason(["agent-org:package.json"], [pr(7, ["package.json"])]).reason, null);
  // control: the same key on both sides with a real shared file IS a match, so the silence above is not a keyed-entry blind spot
  const shared = claimedRegionOverlapReason(["agent-org:package.json", "agent-org:src/x.ts"], [claimed(9, ["agent-org:package.json", "agent-org:src/x.ts"])]);
  assert.match(shared ?? "", /which declares: agent-org:src\/x\.ts\./);
});

test("(6) a directory entry covering a manifest still meets the other row's entry as before", () => {
  const dirVsFile = claimedRegionOverlapReason(["packages/x/"], [claimed(9, ["packages/x/package.json"])]);
  assert.match(dirVsFile ?? "", /which declares: packages\/x\/package\.json/);
  const prDir = fileOverlapReason(["packages/x/"], [pr(7, ["packages/x/package.json"])]).reason;
  assert.match(prDir ?? "", /already touches: packages\/x\/package\.json/);
});

test("(7) `.changeset/` behaves as before: excluded on both sides, and a shared source file beside it is still the named overlap", () => {
  assert.equal(fileOverlapReason([".changeset/a.md", "src/a.ts"], [pr(7, [".changeset/a.md", "src/b.ts"])]).reason, null);
  assert.equal(claimedRegionOverlapReason([".changeset/a.md", "src/a.ts"], [claimed(9, [".changeset/a.md", "src/b.ts"])]), null);
  const withFile = fileOverlapReason([".changeset/a.md", "src/x.ts"], [pr(7, [".changeset/a.md", "src/x.ts"])]).reason;
  assert.match(withFile ?? "", /already touches: src\/x\.ts\b/);
});
