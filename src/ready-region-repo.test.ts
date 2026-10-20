// no-token: row-file.ts -- this file calls only absentRegionTopDirReason; every read it makes is an injected seam or the recorded host fixture, and no gh-using function of row-file.ts (readBlocker, ~line 866) is reached; 10/10 pass with gh off PATH and no token
// #855: a `--ready` row whose `## Region` names a top-level directory its repository does not have is refused at filing.
//
// Every read is injected (`code`, `checkoutOf`, `hasTopLevel`, `trackerRepo`), so no test spawns git or reads a host declaration.
// The fakes below answer from a table: which checkout holds which top-level directories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

// `project-config.ts` resolves the home checkout from `$AGENT_ORG_HOST` AT IMPORT, so the host file is named before `row-file.ts` is imported
// (the `gh-identity.test.ts` pattern). Both are recorded fixtures: the host-units host, pointed at the `row-claim-file-overlap-rule` project, read
// only -- every read this file makes is injected, so it never touches the checkout.
const SETUP = tmpDirForFile("ready-region-repo-855-");
const FIXTURE = fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url));
const host = JSON.parse(readFileSync(fileURLToPath(new URL("./packaging/fixtures/host-units/host.json", import.meta.url)), "utf8"));
writeFileSync(join(SETUP, "host.json"), JSON.stringify({ ...host, projects: [{ id: "fixture", checkout: FIXTURE }] }));
process.env.AGENT_ORG_HOST ??= join(SETUP, "host.json");
const { absentRegionTopDirReason } = await import("./row-file/issue-body-and-region-checks.ts");

const CODE = [
  { key: "", repo: "a11ign/agent-org" },
  { key: "nvda-worker", repo: "a11ign/nvda-worker" },
];

// checkout name -> the top-level directories origin/main has. A checkout absent from the table is unreadable (`null`).
const TREES: Record<string, string[]> = {
  primary: ["src", "docs", "README.md"],
  "clone:nvda-worker": ["src", "packages"],
};

const checkoutOf = (key: string) => (key === "" ? "primary" : `clone:${key}`);
const hasTopLevel = (checkout: string, top: string): boolean | null =>
  TREES[checkout] === undefined ? null : TREES[checkout].includes(top);

const body = (region: string) => `## Repository\n\nThe repository is \`a11ign/agent-org\`.\n\n## Region\n\n${region}\n\n## Acceptance\n\n\`\`\`\nx\n\`\`\`\n`;
const check = (region: string, deps: Partial<Parameters<typeof absentRegionTopDirReason>[1]> = {}) =>
  absentRegionTopDirReason(body(region), { code: CODE, trackerRepo: "a11ign/agent-org", checkoutOf, hasTopLevel, present: () => true, ...deps });

test("POSITIVE CONTROL: a bare Region path into a directory the repository lacks is refused, naming the path, the tracker and the holder", () => {
  // packages/ exists only in the nvda-worker clone, so the refusal must name that repository as the holder.
  const reason = check("`packages/guards/src/x.test.ts`");
  assert.ok(reason !== null, "a bare absent-directory path must be refused");
  assert.match(reason, /packages\/guards\/src\/x\.test\.ts/);
  assert.match(reason, /packages\//);
  assert.match(reason, /a11ign\/agent-org/, "names the repository the entry builds in");
  assert.match(reason, /The tracker is a11ign\/agent-org/);
  assert.match(reason, /a11ign\/nvda-worker has `packages\/`/, "names the repository that does have the directory");
});

test("a new file in a directory the repository has is accepted", () => {
  assert.equal(check("`src/new-file.test.ts`"), null);
});

test("a single new file at the root is not a directory and is never read", () => {
  assert.equal(check("`CHANGELOG.md`"), null);
});

test("a keyed row is checked against its own clone: the clone has packages/, so the primary's lack of it does not refuse", () => {
  // MUTATION TARGET. A check that reads only the primary clone sees no `packages/` and refuses this row; the keyed case must stay green.
  assert.equal(check("nvda-worker:packages/guards/src/x.test.ts"), null);
});

test("a keyed row is refused when its own clone lacks the directory, and names the holder that does have it", () => {
  const reason = check("nvda-worker:docs/guide.md");
  assert.ok(reason !== null);
  assert.match(reason, /a11ign\/nvda-worker/);
  assert.match(reason, /a11ign\/agent-org has `docs\/`/, "the primary holds docs/, so the message names it as the holder");
});

test("a keyed entry whose clone is not declared on this host is not checked, so the filing is not refused (#2623)", () => {
  // The host has no clones.nvda-worker yet: the entry cannot be read, and refusing would stop every such row filing as it does today.
  assert.equal(check("nvda-worker:packages/x.ts", { checkoutOf: (key) => (key === "" ? "primary" : null) }), null);
});

test("a checkout that is not on this disk is skipped, not refused: the CI runner has no ~/repos/agent-org and the board suite files rows against it", () => {
  // The primary is named but absent: nothing can be read, so nothing is refused. An unreadable checkout that IS present is still refused (below).
  assert.equal(check("`packages/guards/src/x.test.ts`", { present: () => false }), null);
});

test("an unreadable origin/main is refused, never read as a pass", () => {
  const reason = check("`packages/guards/src/x.test.ts`", { hasTopLevel: () => null });
  assert.match(reason ?? "", /could not read origin\/main of a11ign\/agent-org/);
});

test("a path that no declared repository has is refused as wrong, not as living elsewhere", () => {
  const reason = check("`nothere/x.ts`");
  assert.match(reason ?? "", /No declared repository has `nothere\/`/);
});

test("a Region with no path-shaped token passes", () => {
  assert.equal(check("the change is a settings flip, no file"), null);
});

test("a body without a Region section passes", () => {
  assert.equal(absentRegionTopDirReason("## Acceptance\n\nx\n", { code: CODE, checkoutOf, hasTopLevel }), null);
});
