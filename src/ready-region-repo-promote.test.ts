// no-token: row-file.ts -- this file calls only promoteRefusalReason with injected seams (`code`, `checkoutOf`, `hasTopLevel`, `present`) and
// regionPathTokens; no gh-using function of row-file.ts is reached, so it needs no token.
// #877: promoting a backlog row to Ready asks the question `--ready` filing asks (#855): does the repository have the Region's directory?
// Every read is injected, so no test spawns git or reads a host declaration beyond the recorded fixture below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

// `project-config.ts` resolves the home checkout from `$AGENT_ORG_HOST` AT IMPORT, so it is named before `row-file.ts` is imported.
const SETUP = tmpDirForFile("ready-region-repo-promote-877-");
const FIXTURE = fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url));
const host = JSON.parse(readFileSync(fileURLToPath(new URL("./packaging/fixtures/host-units/host.json", import.meta.url)), "utf8"));
writeFileSync(join(SETUP, "host.json"), JSON.stringify({ ...host, projects: [{ id: "fixture", checkout: FIXTURE }] }));
process.env.AGENT_ORG_HOST ??= join(SETUP, "host.json");
const { promoteRefusalReason } = await import("./row-file/roadmap-and-milestone-checks.ts");
const { regionPathTokens } = await import("./region-paths.ts");

const CODE = [
  { key: "", repo: "a11ign/agent-org" },
  { key: "nvda-worker", repo: "a11ign/nvda-worker" },
];
const TREES: Record<string, string[]> = { primary: ["src", "docs"], "clone:nvda-worker": ["src", "packages"] };
const deps: Parameters<typeof promoteRefusalReason>[2] & { checkoutOf: (key: string) => string | null } = {
  code: CODE,
  trackerRepo: "a11ign/agent-org",
  checkoutOf: (key: string) => (key === "" ? "primary" : `clone:${key}`),
  hasTopLevel: (checkout: string, top: string): boolean | null => (TREES[checkout] === undefined ? null : TREES[checkout].includes(top)),
  present: () => true,
};

const row = (region: string) => `## Region\n\n${region}\n\n## Acceptance\n\n\`\`\`\nnpx tsx --test x\n\`\`\`\n\n## Open-check\n\n\`\`\`\ngh issue view 735 --json state\n\`\`\`\n`;
const promote = (region: string, over: Partial<typeof deps> = {}) => promoteRefusalReason(row(region), 877, { ...deps, ...over });

test("POSITIVE CONTROL: promoting a row whose Region directory the repository lacks is refused, naming the directory and the holder", () => {
  // MUTATION TARGET: with the directory read skipped (`hasTopLevel` never consulted) this is null and the test is red.
  const reason = promote("```\npackages/guards/src/x.test.ts\n```", { checkoutOf: (key) => (key === "" ? "primary" : `clone:${key}`) });
  assert.ok(reason !== null, "an absent-directory Region must be refused at promotion");
  assert.match(reason, /REFUSING to promote/);
  assert.match(reason, /`packages\/`/);
  assert.match(reason, /a11ign\/agent-org/);
  assert.match(reason, /a11ign\/nvda-worker has `packages\/`/, "names the repository that holds the directory");
});

test("a path under a directory the repository has is accepted", () => {
  assert.equal(promote("```\nsrc/new-file.test.ts\n```"), null);
});

test("a keyed token is read by region-paths.ts, which the filing reader and the promotion reader share", () => {
  assert.deepEqual(regionPathTokens(row("```\nnvda-worker:packages/x.ts\nsrc/y.ts\n```")), ["nvda-worker:packages/x.ts", "src/y.ts"]);
  assert.equal(promote("```\nnvda-worker:packages/x.ts\n```"), null, "its own clone has packages/");
  assert.match(String(promote("```\nnvda-worker:docs/x.md\n```")), /REFUSING to promote.*nvda-worker:docs\/x\.md/s);
});

test("a keyed entry whose clone is not declared on this host is not checked", () => {
  assert.equal(promote("```\nnvda-worker:packages/x.ts\n```", { checkoutOf: (key) => (key === "" ? "primary" : null) }), null);
});

test("an unreadable origin/main is refused at promotion, never read as a pass", () => {
  assert.match(String(promote("```\nsrc/x.ts\n```", { hasTopLevel: () => null })), /REFUSING to promote -- could not read origin\/main/);
});
