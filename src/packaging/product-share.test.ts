// no-token: gh -- nothing here reaches `gh`: `decide` is pure and the one reader of local state is handed a temporary directory
/**
 * #3820: THE GATE OFFERS AN ENGINEER A PRODUCT ROW FIRST UNTIL AT LEAST 6 OF THE LAST 10 ENGINEER STARTS WERE PRODUCT ROWS.
 *
 * (a)-(e) are the five cases the row's Done-when 5 names, and each is beside its positive control: a function that
 * returned `org` for everything, or offered everything, satisfies half of them, so every "offers only the product row" has
 * a sibling that offers the org row and every "org" has a sibling that is "product".
 *
 * WHAT A PRODUCT ROW IS comes from the row, not from a label: a Region entry under a `releasablePaths` entry of a `dora`
 * repository other than `a11ign/agent-org`. The declaration below is the project's own, trimmed to what the rule reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, rowKind, productRegionsOf, productShare, offeredByShare, recordEngineerStarts, PRODUCT_SHARE_WINDOW,
  PRODUCT_SHARE_FLOOR, ENGINEER_STARTS_FILE } from "../work-gate.mjs";

const DECLARATION = {
  code: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "lab", repo: "a11ign/lab" }],
  dora: [
    { repo: "a11ign/a11ign", releasablePaths: ["packages/cli/", "packages/evidence/", "packages/judge/", "packages/scorer/"] },
    { repo: "a11ign/agent-org", releasablePaths: ["src/"] },
    { repo: "a11ign/lab", releasablePaths: ["packages/lab/"] },
  ],
};
const PRODUCT_REGIONS = productRegionsOf(DECLARATION);

/**
 * A Ready row whose Region is the given entries, one per line in a fence. It carries the Acceptance and Open-check the claim demands, or
 * `partitionUnclaimed` shelves it as a template defect and the offer under test never sees it. NO entries is a Region section naming no path.
 */
function ready(number: number, ...region: string[]) {
  const regionSection = region.length === 0 ? "## Region\n\nNo file.\n" : `## Region\n\n\`\`\`\n${region.join("\n")}\n\`\`\`\n`;
  const body = `${regionSection}\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`;
  return { number, title: `row ${number}`, labels: [{ name: "ready" }], body };
}
const PRODUCT = ready(30, "packages/judge/src/score.ts");
const ORG = ready(20, "packages/guards/src/rule.ts");

const starts = (product: number, org: number) => [
  ...Array.from({ length: org }, (_, i) => ({ at: i, kind: "org" })),
  ...Array.from({ length: product }, (_, i) => ({ at: org + i, kind: "product" })),
];
const offered = (rows: unknown[], engineerStarts: { at: number; kind: string }[]) => {
  const lines: string[] = [];
  const orders = decide({ prs: [], readyRows: rows, engineerStarts, projectDeclaration: DECLARATION, shareLog: (line: string) => lines.push(line) });
  return { subjects: orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed").map((o: { subject: string }) => o.subject), lines };
};

test("(a) a Region under packages/judge/ is a product row", () => {
  assert.equal(rowKind(["packages/judge/src/score.ts"], PRODUCT_REGIONS).kind, "product");
  assert.equal(rowKind(["packages/judge/"], PRODUCT_REGIONS).kind, "product", "a directory entry lies under it too");
  assert.equal(rowKind(["docs/x.md", "packages/cli/src/a.ts"], PRODUCT_REGIONS).kind, "product", "ONE entry is enough");
});

test("(b) a Region under packages/guards/ only is an org row", () => {
  assert.equal(rowKind(["packages/guards/src/rule.ts"], PRODUCT_REGIONS).kind, "org");
  assert.equal(rowKind(["agent-org:src/work-gate.mjs"], PRODUCT_REGIONS).kind, "org", "agent-org's src/ is releasable and still not product");
  assert.equal(rowKind(["packages/judgement/x.ts"], PRODUCT_REGIONS).kind, "org", "a prefix is a directory, not a spelling");
  assert.equal(rowKind(["lab:packages/lab/src/x.ts"], PRODUCT_REGIONS).kind, "product", "a keyed entry reads against ITS repository's paths");
  assert.equal(rowKind(["packages/lab/src/x.ts"], PRODUCT_REGIONS).kind, "org", "and a bare one against the first repository's, which does not release packages/lab/");
});

test("(c) nine of ten starts org and a product row offerable: only the product row is offered", () => {
  const { subjects, lines } = offered([ORG, PRODUCT], starts(1, 9));
  assert.deepEqual(subjects, ["row-30"]);
  assert.deepEqual(lines, [], "a product row was on offer, so there is nothing to say");
});

test("(d) the same with no product row offerable: the org row is offered and ONE line says so", () => {
  const { subjects, lines } = offered([ORG], starts(1, 9));
  assert.deepEqual(subjects, ["row-20"], "an engineer is never left idle to hold a ratio");
  assert.deepEqual(lines, ["NO PRODUCT ROW OFFERABLE (share 1/10)\n"]);
});

test("(e) six of ten starts product: the unrestricted order, oldest first", () => {
  const { subjects, lines } = offered([ORG, PRODUCT], starts(6, 4));
  assert.deepEqual(subjects, ["row-20", "row-30"]);
  assert.deepEqual(lines, []);
  assert.equal(PRODUCT_SHARE_FLOOR, 6);
  assert.equal(PRODUCT_SHARE_WINDOW, 10);
});

test("the window is the last ten starts, newest by `at`, and the product count is over those", () => {
  const old = Array.from({ length: 5 }, (_, i) => ({ at: i - 100, kind: "product" }));
  assert.deepEqual(productShare([...old, ...starts(0, 10)]), { product: 0, of: 10 }, "five older product starts have left the window");
  assert.deepEqual(productShare(starts(10, 0).reverse()), { product: 10, of: 10 }, "order of the array is not the order of the starts");
  assert.deepEqual(productShare([]), { product: 0, of: 10 }, "no history reads as none of ten, which offers product first");
});

test("a row with no Region, or an empty one, is org and is NAMED in the line, never guessed", () => {
  assert.equal(rowKind(null, PRODUCT_REGIONS).kind, "org");
  assert.equal(rowKind([], PRODUCT_REGIONS).kind, "org");
  const { subjects, lines } = offered([ready(40), ORG], starts(0, 10));
  assert.deepEqual(subjects, ["row-20", "row-40"]);
  assert.deepEqual(lines, ["NO PRODUCT ROW OFFERABLE (share 0/10); counted org, Region unreadable or empty: 40\n"]);
});

test("a gate not given the starts or the declaration offers as it always did", () => {
  const lines: string[] = [];
  const orders = decide({ prs: [], readyRows: [ORG, PRODUCT] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-20", "row-30"]);
  assert.deepEqual(offeredByShare([ORG, PRODUCT], { shareLog: (l: string) => lines.push(l) }).map((r: { number: number }) => r.number), [20, 30]);
  assert.deepEqual(lines, []);
});

test("recording starts: a worker's in-progress row once, never a seat's, and only the last ten kept", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "product-share-"));
  try {
    const claimed = (n: number, session: string, region: string) => ({ ...ready(n, region), labels: [{ name: "in-progress" }, { name: `session:${session}` }] });
    const open = [claimed(1, "worker-1", "packages/judge/a.ts"), claimed(2, "worker-2", "packages/guards/a.ts"), claimed(3, "ceo", "packages/judge/b.ts"), ready(4, "packages/judge/c.ts"), { ...ready(5, "packages/judge/d.ts"), labels: [{ name: "session:worker-5" }] }];
    const log = () => undefined;
    const first = recordEngineerStarts(open, { stateDir, declaration: DECLARATION, now: 1000, log });
    assert.deepEqual(first.map((s: { row: string; kind: string }) => [s.row, s.kind]), [["1", "product"], ["2", "org"]], "ceo holds a row and starts nothing; an unclaimed row is not a start, even one still carrying a worker label");
    const again = recordEngineerStarts(open, { stateDir, declaration: DECLARATION, now: 2000, log });
    assert.deepEqual(again, first, "a row already recorded is not a second start, and keeps its first time");
    const many = Array.from({ length: 12 }, (_, i) => claimed(10 + i, `worker-${10 + i}`, "packages/cli/a.ts"));
    const last = recordEngineerStarts([...open, ...many], { stateDir, declaration: DECLARATION, now: 3000, log });
    assert.equal(last.length, PRODUCT_SHARE_WINDOW);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(stateDir, ENGINEER_STARTS_FILE), "utf8"))).length, PRODUCT_SHARE_WINDOW, "and what is kept on disk is the same ten");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recording starts never throws: an unwritable directory says so and reads as no history", () => {
  const dir = mkdtempSync(join(tmpdir(), "product-share-"));
  try {
    // A directory that is a FILE: the write fails at once with ENOTDIR, where a path under /proc hangs `mkdir -p`.
    writeFileSync(join(dir, "not-a-directory"), "");
    const lines: string[] = [];
    const claimed = { ...ready(1, "packages/judge/a.ts"), labels: [{ name: "in-progress" }, { name: "session:worker-1" }] };
    const read = recordEngineerStarts([claimed], { stateDir: join(dir, "not-a-directory"), declaration: DECLARATION, now: 1, log: (l: string) => lines.push(l) });
    assert.deepEqual(read, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^engineer-starts: could not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
