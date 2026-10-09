// no-token: gh -- nothing here reaches `gh`: `decide` is pure and the one reader of local state is handed a temporary directory
/**
 * #4399: THE 60% PRODUCT SHARE FOLLOWS `adopterFacing` (`ceo` on #4378: "yes, the share follows adopterFacing").
 *
 * #3820's share counted a Region under any `dora` repository but the tool's as PRODUCT, so a sweep of `toolchain`, `control` or `lab` `src/` met a
 * floor meant for what an outside adopter gets. `productRegionsOf` is now the ONE place the key is read for the share: a repository declared
 * `adopterFacing: false` contributes no product path. A row with ANY entry under an adopter-facing repository stays product (`rowKind` reads `some`),
 * and an entry that omits the key is adopter-facing, as it always was.
 *
 * POSITIVE CONTROLS, NAMED: the same Region under the same repository with the key ABSENT is `product` (so "org" is the key's doing, not the
 * Region's), and `packages/judge/` is `product` in every fixture (so a rule that read everything as org would fail it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, rowKind, productRegionsOf, offeredByShare, recordEngineerStarts } from "../work-gate.ts";
import { adopterRowKind } from "../work-gate/org-health.mjs";

const CODE = [
  { key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "documents", repo: "a11ign/documents" },
  { key: "control", repo: "a11ign/control" }, { key: "lab", repo: "a11ign/lab" }, { key: "toolchain", repo: "a11ign/toolchain" },
];
const dora = (tooling: { adopterFacing?: boolean }) => [
  { repo: "a11ign/a11ign", releasablePaths: ["packages/cli/", "packages/judge/"] },
  { repo: "a11ign/agent-org", releasablePaths: ["src/"] },
  { repo: "a11ign/documents", releasablePaths: ["src/"], adopterFacing: true },
  { repo: "a11ign/control", releasablePaths: ["src/"], ...tooling },
  { repo: "a11ign/lab", releasablePaths: ["src/"], ...tooling },
  { repo: "a11ign/toolchain", releasablePaths: ["src/"], ...tooling },
];
/** The project's own shape since #4396: the three tooling repositories declare `adopterFacing: false`. */
const DECLARED = { code: CODE, dora: dora({ adopterFacing: false }) };
/** The same declaration with the key ABSENT on those three: the positive control. */
const UNDECLARED = { code: CODE, dora: dora({}) };

const TOOLING_ENTRIES = ["toolchain:src/js-to-ts.ts", "control:src/fleet.ts", "lab:src/gate.ts"];

test("a Region whose every entry sits under a repository declared adopterFacing: false is org", () => {
  const regions = productRegionsOf(DECLARED);
  for (const entry of TOOLING_ENTRIES) assert.equal(rowKind([entry], regions).kind, "org", entry);
  assert.equal(rowKind(TOOLING_ENTRIES, regions).kind, "org", "all three together");
  assert.deepEqual(regions.map((region) => region.key).sort(), ["", "documents"], "the tooling keys contribute no paths, and the tool's own never did");
});

test("(positive control) the same entries with NO adopterFacing key are product, as before", () => {
  const regions = productRegionsOf(UNDECLARED);
  for (const entry of TOOLING_ENTRIES) assert.equal(rowKind([entry], regions).kind, "product", entry);
  assert.equal(rowKind(["packages/judge/src/score.ts"], productRegionsOf(DECLARED)).kind, "product", "and the primary repository is product in the declared shape too");
});

test("a Region with ONE entry under an adopter-facing repository stays product, among tooling entries", () => {
  const regions = productRegionsOf(DECLARED);
  assert.equal(rowKind(["toolchain:src/js-to-ts.ts", "packages/judge/src/score.ts"], regions).kind, "product");
  assert.equal(rowKind(["control:src/fleet.ts", "documents:src/parse.ts"], regions).kind, "product", "an explicit adopterFacing: true is the same as the key absent");
  assert.equal(rowKind(["toolchain:src/js-to-ts.ts", "docs/x.md"], regions).kind, "org", "an entry under no releasable path adds nothing");
});

test("an explicit adopterFacing: true reads exactly as the key absent", () => {
  assert.deepEqual(productRegionsOf({ code: CODE, dora: dora({ adopterFacing: true }) }), productRegionsOf(UNDECLARED));
});

test("the gate offers a tooling row as ORG: with the share below the floor the product row is offered alone, and with none the shelf-empty line prints", () => {
  const ready = (number: number, region: string) => ({ number, title: `row ${number}`, labels: [{ name: "ready" }], body: `## Region\n\n\`\`\`\n${region}\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n` });
  const SWEEP = ready(20, "toolchain:src/js-to-ts.ts");
  const PRODUCT = ready(30, "packages/judge/src/score.ts");
  const starts = Array.from({ length: 10 }, (_, at) => ({ at, kind: "org" }));
  const run = (rows: unknown[], declaration: typeof DECLARED) => {
    const lines: string[] = [];
    const orders = decide({ prs: [], readyRows: rows, engineerStarts: starts, projectDeclaration: declaration, shareLog: (line: string) => lines.push(line) });
    return { subjects: orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed").map((o: { subject: string }) => o.subject), lines };
  };
  assert.deepEqual(run([SWEEP, PRODUCT], DECLARED).subjects, ["row-30"], "declared: the sweep is org, so only the product row is offered");
  assert.deepEqual(run([SWEEP, PRODUCT], UNDECLARED).subjects, ["row-20", "row-30"], "(control) undeclared: the sweep counted as product, so nothing was held back");
  const empty = run([SWEEP], DECLARED);
  assert.deepEqual(empty.subjects, ["row-20"], "an engineer is never left idle to hold a ratio");
  assert.deepEqual(empty.lines, ["NO PRODUCT ROW OFFERABLE (share 0/10)\n"], "and product-manager is told the shelf is empty");
  assert.deepEqual(run([SWEEP], UNDECLARED).lines, [], "(control) undeclared: the sweep was product, so the shelf was never empty");
  assert.deepEqual(offeredByShare([SWEEP, PRODUCT], { starts, declaration: DECLARED, shareLog: () => undefined }).map((r: { number: number }) => r.number), [30]);
});

test("a start on a tooling row is RECORDED as org, so it no longer counts toward the floor", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "product-share-adopter-"));
  try {
    const claimed = { number: 7, labels: [{ name: "in-progress" }, { name: "session:worker-7" }], body: "## Region\n\n```\ntoolchain:src/js-to-ts.ts\n```\n" };
    const kinds = (declaration: typeof DECLARED, name: string) => recordEngineerStarts([claimed], { stateDir: join(stateDir, name), declaration, now: 1, log: () => undefined }).map((s: { kind: string }) => s.kind);
    assert.deepEqual(kinds(DECLARED, "declared"), ["org"]);
    assert.deepEqual(kinds(UNDECLARED, "undeclared"), ["product"], "(control) the key absent: the same start was product");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the share and #4378's milestone rule agree on every entry, because the share's `productRegionsOf` is the only place that reads the key", () => {
  const entries = [...TOOLING_ENTRIES, "packages/judge/src/score.ts", "documents:src/parse.ts", "agent-org:src/work-gate.ts", "docs/x.md"];
  for (const declaration of [DECLARED, UNDECLARED]) {
    for (const entry of entries) {
      const share = rowKind([entry], productRegionsOf(declaration)).kind === "product";
      assert.equal(adopterRowKind([entry], declaration).kind === "adopter", share, entry);
    }
  }
});
