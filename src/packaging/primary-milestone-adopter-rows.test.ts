// no-token: gh
//
// #4378 (of #4084): THE PRIMARY MILESTONE HOLDS ADOPTER-FACING ROWS ONLY. `row-file` refuses an ORG row for the milestone whose description carries
// `Primary: yes`, and `milestoneClockFact` counts only the rows that read as adopter-facing. One rule serves both (`adopterRowKind`): #3820's `rowKind`
// over the `dora` repositories not declared `adopterFacing: false`.
//
// THE FIXTURES ARE REAL ROWS: each `REGION` below is the `## Region` block of the row it names, as read from the tracker on 2026-10-09 (07:00Z, not the
// 05:00Z the row quotes: #4348 had closed and #4343's body is the one then current). The negative control is the incident, so every one of the six org
// rows is refused here by its own Region and not by a stand-in. Two of the six (#4344, #4357) and #4369 are the unreadable kind, and a stub that called an
// unreadable Region "product" would pass the three others and fail those.
//
// POSITIVE CONTROLS, NAMED: `packages/cli/` (a), #4356 (b), a different milestone, out of the release, and the same six rows with NO `adopterFacing` key anywhere.
// Each file case asserts the number of creates (the refusals ZERO), so a refusal is read against a tool that does file.
//
// A FINDING THE ROW DID NOT KNOW (case "F"): the live declaration lists no `docs/` path as releasable, so #4356 reads ORG against it. The rule is
// DORMANT until a `dora` entry names `adopterFacing`, which is why this change cannot raise a false alarm on its own. `ceo` ruled (#4378, 2026-10-09)
// that #4356 COUNTS, and how: by declaring the ONE path an outside adopter reads (its findings doc) releasable for `a11ign/a11ign`, NOT by widening the
// lab's `releasablePaths` (that would make every lab script "product" in #3820's share). `NO_KEY` below carries that path, the lab keeps `src/` only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFiledBy, createIssue, primaryMilestoneRefusal, primaryMilestoneTitles } from "../row-file.ts";
import { adopterRowKind, adopterFacingDeclared, milestoneClockFact } from "../work-gate/org-health.mjs";
import { milestoneClockReading } from "../org-health.ts";
import { parseProjectDeclaration } from "../project-config.ts";
import { declaredRegionFiles } from "../region-paths.ts";

const PRIMARY = "v3 — Ready for a first outside adopter";
const SESSION = "product-manager";
const ROOT_FILES = new Set(["package.json", "pnpm-lock.yaml", "layers.json"]);

const CODE = [
  { key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "control", repo: "a11ign/control" },
  { key: "lab", repo: "a11ign/lab" }, { key: "toolchain", repo: "a11ign/toolchain" },
];
const A11IGN = { repo: "a11ign/a11ign", releasablePaths: ["packages/cli/", "packages/evidence/", "packages/judge/", "packages/scorer/"] };
const DORA_AS_LIVE = [
  A11IGN, { repo: "a11ign/agent-org", releasablePaths: ["src/"] }, { repo: "a11ign/lab", releasablePaths: ["src/"] },
  { repo: "a11ign/control", releasablePaths: ["src/"] }, { repo: "a11ign/toolchain", releasablePaths: ["src/"] },
];
const TRACKERS = [{ key: "", repo: "a11ign/a11ign", board: { owner: "a11ign", number: 2 } }];
const declare = (dora: object[]) => ({ tracker: TRACKERS, code: CODE, dora }) as never;

/** The path an outside adopter reads, which is what lets #4356 count (see "F"). The lab's `releasablePaths` stay `["src/"]`: `ceo` forbade widening them. */
const FINDINGS_DOC = "docs/unfamiliar-ui-findings.md";
/** No key anywhere: the declaration as it stands today, plus the findings doc as releasable for `a11ign/a11ign` (#4396's declaration). */
const NO_KEY = declare(DORA_AS_LIVE.map((entry) => (entry.repo === "a11ign/a11ign" ? { ...entry, releasablePaths: [...entry.releasablePaths, FINDINGS_DOC] } : entry)));
/** The follow-on's declaration, less the lab: `toolchain` and `control` are the org's own tooling. */
const TOOLING_FALSE = declare((NO_KEY as { dora: { repo: string }[] }).dora.map((entry) => (["a11ign/toolchain", "a11ign/control"].includes(entry.repo) ? { ...entry, adopterFacing: false } : entry)));
/** ...and the lab declared not adopter-facing too (Done-when 4's call). */
const LAB_FALSE = declare((TOOLING_FALSE as { dora: { repo: string }[] }).dora.map((entry) => (entry.repo === "a11ign/lab" ? { ...entry, adopterFacing: false } : entry)));

/** Each row's `## Region` block, verbatim. The line after the fence is part of the block where the row has one. */
const REGION = {
  4343: "```\npackage.json\npnpm-lock.yaml\nlayers.json\npackages/guards/src/screenreader-worker-extraction.test.ts\npackages/guards/layer-edges.baseline.json\npackages/guards/src/control-delete.test.ts\npackages/guards/src/tracked-source-leak-guard.test.ts\n.changeset/the-core-runs-control-as-typescript.md\n```\n",
  4344: "```\n```\n\nRegion: none -- its deliverable is not a commit: it is a reading posted as a comment on this row, and the row closes on that comment.\n",
  4348: "```\ntoolchain:src/js-to-ts.ts\ntoolchain:src/js-to-ts.test.ts\ntoolchain:README.md\ntoolchain:package.json\ntoolchain:.changeset/js-to-ts-finds-typescript.md\n```\n",
  4357: "```\nits deliverable is not a commit: a ruling (and, for option 1, a repository setting); the follow-up row names its own files\n```\n",
  4360: "```\nagent-org:src/wake.ts\nagent-org:src/work-gate-stuck-escalation-keyed.test.ts\nagent-org:.changeset/stuck-row-names-its-cause.md\n```\n\nPaths are relative to `a11ign/agent-org`'s root. The tracker is here (agent-org's rows stay tracked here, per the CLAUDE.md routing table).\n",
  4369: "Region: its deliverable is not a commit (it writes one file and one variable on `a11ign-labs/a11ign-consumer-check`, outside this repository)\n",
  4356: "```\ndocs/unfamiliar-ui-findings.md\nlab:scripts/cantell-by-page-shape.mjs\n```\n\nThe script is named so the Acceptance can run it; it is read, not changed. The capture, the sweep and the script run happen on the control plane and the lab; the only tracked file is the doc.\n",
  cli: "```\npackages/cli/src/run.ts\n```\n",
} as const;
/** An epic names no file; `row-file` wants the sentence that says so on purpose (#989). Only the CLOCK fixtures use it: an epic is labelled after filing, so `row-file` never sees one. */
const CONTAINER = "its deliverable is not a commit: the epic is a container for its rows\n";
const ORG_ROWS = [4343, 4344, 4348, 4357, 4360, 4369] as const;
const UNREADABLE_ROWS = [4344, 4357, 4369] as const;

const bodyOf = (region: string) => `## Region\n\n${region}\n## Acceptance\n\n\`\`\`\nnpx tsx --test x\n\`\`\`\n\n## Open-check\n\n\`\`\`\ngh issue view 735 --json state\n\`\`\`\n`;

/** A stub that records creates and answers `gh api …/milestones` through `primaryMilestones`. `titles: null` is a milestone list that cannot be read. */
function filing(argv: string[], declaration: never, { titles = [PRIMARY] as string[] | null } = {}) {
  let creates = 0;
  let stderr = "";
  const filed = { body: "", milestone: "" };
  const deps = {
    spawnGh: (sent: string[]) => {
      creates += 1;
      filed.body = sent[sent.indexOf("--body") + 1];
      filed.milestone = sent[sent.indexOf("--milestone") + 1] ?? "";
      return `https://github.com/a11ign/a11ign/issues/${5000 + creates}`;
    },
    // the read-back asks for the body (Filed-by) and the milestone of the row it just made
    run: (_cmd: string, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return "[]";
      if (args.includes("milestone")) return filed.milestone;
      return args.includes("body") ? appendFiledBy(filed.body, SESSION) : "";
    },
    milestones: () => [PRIMARY, "Out of release", "CI reset"], primaryMilestones: () => titles, declaration,
    loadLanesConfig: () => ({ lanes: [] }), ensureLabels: () => {}, fetchBoardStatus: () => "Backlog",
    fetchLabels: () => ({ number: 0, title: "", labels: ["backlog", "lane:any", ...(filed.milestone === "Out of release" ? ["out-of-release"] : [])] }), moveStatus: () => ({ moved: true as const }),
  };
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, deps as never);
    return { code, stderr, creates };
  } finally {
    process.stderr.write = original;
  }
}
const argvFor = (region: string, ...extra: string[]) => ["--title", `row for ${region.length}`, "--body", bodyOf(region), `--session=${SESSION}`, ...extra];
const intoPrimary = (region: string, ...extra: string[]) => argvFor(region, "--milestone", PRIMARY, ...extra);

test("(negative control, the incident) each of the six org rows is REFUSED for the primary milestone, with zero creates, naming the remedy", () => {
  for (const number of ORG_ROWS) {
    const result = filing(intoPrimary(REGION[number]), TOOLING_FALSE);
    assert.equal(result.code, 1, `#${number} is refused: ${result.stderr}`);
    assert.equal(result.creates, 0, `#${number}: nothing was sent to GitHub`);
    assert.match(result.stderr, /REFUSING to file an org row into the primary milestone "v3 — Ready for a first outside adopter"/);
    assert.match(result.stderr, /--milestone "Out of release" --label out-of-release/);
  }
});

test("(negative control) #4348 is refused BECAUSE toolchain is declared adopterFacing: false, and accepted when the key is absent -- the rule refuses it, not the rest", () => {
  const refused = filing(intoPrimary(REGION[4348]), TOOLING_FALSE);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /`toolchain:src\/js-to-ts\.ts` lies under a releasable path of a11ign\/toolchain, which is declared `adopterFacing: false`/);
  // The key absent on toolchain, present on control: the rule is ACTIVE (a key is declared) and still accepts the row.
  const controlOnly = declare((NO_KEY as { dora: { repo: string }[] }).dora.map((entry) => (entry.repo === "a11ign/control" ? { ...entry, adopterFacing: false } : entry)));
  const accepted = filing(intoPrimary(REGION[4348]), controlOnly);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(accepted.creates, 1);
});

test("(unreadable) a Region that names no path is refused at filing, SAYING it could not be read; the three real ones parse as no path", () => {
  for (const number of UNREADABLE_ROWS) {
    assert.deepEqual(declaredRegionFiles(bodyOf(REGION[number]), { rootFiles: ROOT_FILES }), [], `#${number}'s Region reads as no path`);
    const result = filing(intoPrimary(REGION[number]), TOOLING_FALSE);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /its Region names no path, so it cannot be read as adopter-facing/);
  }
  assert.equal(adopterRowKind(null, TOOLING_FALSE).unreadable, true, "no Region section at all is unreadable too");
});

test("(positive control) a packages/cli/ row and #4356 are accepted into the primary milestone", () => {
  for (const region of [REGION.cli, REGION[4356]]) {
    const result = filing(intoPrimary(region), TOOLING_FALSE);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.creates, 1);
  }
});

test("(positive controls) the same org rows file into a milestone that is NOT primary, or out of the release", () => {
  for (const number of ORG_ROWS) {
    const result = filing(argvFor(REGION[number], "--milestone", "CI reset"), TOOLING_FALSE);
    assert.equal(result.code, 0, `#${number}: ${result.stderr}`);
  }
  const outOfRelease = filing(argvFor(REGION[4360], "--milestone", "Out of release", "--label", "out-of-release"), TOOLING_FALSE);
  assert.equal(outOfRelease.code, 0, outOfRelease.stderr);
});

test("(dormant) with NO adopterFacing key anywhere every row files exactly as before, and the rule says it is not asked", () => {
  assert.equal(adopterFacingDeclared(NO_KEY), false);
  assert.equal(adopterFacingDeclared(TOOLING_FALSE), true);
  for (const number of ORG_ROWS) assert.equal(filing(intoPrimary(REGION[number]), NO_KEY).code, 0, `#${number}`);
  assert.equal(filing(intoPrimary(REGION[4344]), NO_KEY, { titles: null }).code, 0);
});

test("(unknown, not refused) a milestone list that cannot be read files the row with a warning that the check did not run", () => {
  const result = filing(intoPrimary(REGION[4360]), TOOLING_FALSE, { titles: null });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /could not read a11ign\/a11ign's milestones, so whether "v3 — Ready for a first outside adopter" is the primary one was not checked/);
});

test("the primary milestone is read from the DESCRIPTION line, and an unreadable list is null, not empty", () => {
  const listing = JSON.stringify([{ title: PRIMARY, description: "Outcome 3.\nPrimary: yes\n" }, { title: "Road to version one", description: "Primary: yes is not this one's line, it says Primary: yes inline" }, { title: "Out of release", description: null }]);
  assert.deepEqual(primaryMilestoneTitles({ run: () => listing, repo: "a11ign/a11ign" }), [PRIMARY]);
  assert.equal(primaryMilestoneTitles({ run: () => { throw new Error("HTTP 502"); } }), null);
  assert.equal(primaryMilestoneRefusal(["--milestone", PRIMARY], bodyOf(REGION[4360]), TRACKERS[0], TOOLING_FALSE as never, { primaryMilestones: () => [PRIMARY], run: () => "" }) !== null, true);
});

// --- the clock ------------------------------------------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-09T09:00:00Z");
const MILESTONE = { number: 8, title: PRIMARY, description: "Primary: yes" };
const openRow = (number: number, region: string, labels: string[] = [], createdAt = "2026-10-09T02:00:00Z") =>
  ({ number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: bodyOf(region), milestone: MILESTONE, createdAt, updatedAt: createdAt });
const EPIC = openRow(4084, CONTAINER, ["epic", "lane:ceo"], "2026-10-08T00:00:00Z");
const EIGHT = [EPIC, ...ORG_ROWS.map((number) => openRow(number, REGION[number], ["ready"])), openRow(4356, REGION[4356], ["ready"], "2026-10-09T03:08:33Z")];
const read = (openRowsRead: unknown[], declaration?: never) => milestoneClockFact({ openRowsRead, prsRead: [], now: NOW, declaration });
const reading = (fact: ReturnType<typeof read>) => milestoneClockReading({ now: NOW, fact: fact === null ? null : { ...fact, endedAt: NOW - 5 * HOUR } });

test("(clock) with all eight rows in the milestone and none claimed, the reading names ONLY #4356 as the open product row; the epic is a container", () => {
  assert.deepEqual(read(EIGHT)?.rows.map((row) => row.number), [4084, 4343, 4344, 4348, 4357, 4360, 4369, 4356], "BEFORE: every open row counts (no declaration asked)");
  const after = read(EIGHT, TOOLING_FALSE);
  assert.deepEqual(after?.rows.map((row) => row.number).filter((n) => n !== 4344 && n !== 4357 && n !== 4369), [4084, 4356], "AFTER: the org rows are out");
  const readable = read(EIGHT.filter((row) => !UNREADABLE_ROWS.includes(row.number as never)), TOOLING_FALSE);
  assert.deepEqual(readable?.rows.map((row) => row.number), [4084, 4356]);
  const named = reading(readable);
  assert.equal(named.status, "tripped");
  assert.match(String((named as { detail: string }).detail), /The oldest open row is #4356, ready, unclaimed/);
  assert.match(String((named as { detail: string }).detail), /has 2 open row\(s\)/);
});

test("(clock) with only the six org rows in it the clock reads 'no open row', not 'idle with open rows'", () => {
  const orgOnly = ORG_ROWS.filter((number) => !UNREADABLE_ROWS.includes(number as never)).map((number) => openRow(number, REGION[number], ["ready"]));
  const before = reading(read(orgOnly));
  assert.equal(before.status, "tripped", "BEFORE: three org rows read as an idle milestone");
  const after = reading(read(orgOnly, TOOLING_FALSE));
  assert.equal(after.status, "clear");
  assert.match(String((after as { detail: string }).detail), /milestone 8 has no open row/);
});

test("(clock) a CLAIMED org row neither holds the alarm quiet nor makes it fire", () => {
  const claimed = openRow(4360, REGION[4360], ["in-progress", "session:worker-4360"]);
  assert.equal(reading(read([claimed, openRow(4356, REGION[4356], ["ready"])])).status, "clear", "BEFORE: the misfiled claim kept the alarm quiet");
  const after = reading(read([claimed, openRow(4356, REGION[4356], ["ready"])], TOOLING_FALSE));
  assert.equal(after.status, "tripped", "AFTER: only the adopter row is read, and nobody holds it");
  assert.match(String((after as { detail: string }).detail), /#4356/);
});

test("(clock) an unreadable Region is UNKNOWN, never product, and the epic is not judged", () => {
  for (const number of UNREADABLE_ROWS) {
    const alone = reading(read([openRow(number, REGION[number], ["ready"])], TOOLING_FALSE));
    assert.equal(alone.status, "unknown", `#${number} alone`);
  }
  const beside = reading(read([openRow(4356, REGION[4356], ["ready"]), openRow(4344, REGION[4344], ["ready"])], TOOLING_FALSE));
  assert.equal(beside.status, "unknown", "an adopter row beside an unreadable one does not make the reading certain");
  assert.equal(read([EPIC], TOOLING_FALSE)?.rows.length, 1, "the epic counts as it always did");
});

test("(dormant) with no adopterFacing key anywhere, or no declaration at all, every clock fact is byte-identical to the unfiltered one", () => {
  const before = JSON.stringify(read(EIGHT));
  assert.equal(JSON.stringify(read(EIGHT, NO_KEY)), before);
  assert.notEqual(JSON.stringify(read(EIGHT, TOOLING_FALSE)), before, "the filter really does change the fact once a key is declared");
});

test("(F, ceo's ruling) #4356 counts because the findings doc is releasable, NOT because the lab is widened; declared as it stands today it reads ORG", () => {
  const entries = declaredRegionFiles(bodyOf(REGION[4356]), { rootFiles: ROOT_FILES });
  const asLive = declare(DORA_AS_LIVE.map((entry) => (entry.repo === "a11ign/toolchain" ? { ...entry, adopterFacing: false } : entry)));
  const before = adopterRowKind(entries, asLive);
  assert.equal(before.kind, "org", "without the findings doc declared, nothing covers #4356");
  assert.match(String(before.because), /`docs\/unfamiliar-ui-findings\.md` lies under no releasable path of an adopter-facing repository/);
  assert.deepEqual(DORA_AS_LIVE.find((entry) => entry.repo === "a11ign/lab")?.releasablePaths, ["src/"], "the lab is NOT widened in any fixture here");
  assert.equal(adopterRowKind(entries, LAB_FALSE).kind, "adopter", "the findings doc counts it with the lab, control and toolchain all declared false");
  assert.equal(filing(intoPrimary(REGION[4356]), LAB_FALSE).code, 0, "...and row-file accepts it");
  assert.equal(read([openRow(4356, REGION[4356], ["ready"])], LAB_FALSE)?.rows.length, 1, "...and the clock counts it");
  for (const number of ORG_ROWS) assert.equal(adopterRowKind(declaredRegionFiles(bodyOf(REGION[number]), { rootFiles: ROOT_FILES }), LAB_FALSE).kind, "org", `#${number} stays org`);
});

// --- the declaration ------------------------------------------------------------------------------------------------------------------------------

const PROJECT = { schema: 1, tracker: TRACKERS, code: [{ key: "", repo: "a11ign/a11ign" }, { key: "toolchain", repo: "a11ign/toolchain" }] };
const withDora = (extra: object) => JSON.stringify({ ...PROJECT, dora: [{ repo: "a11ign/toolchain", release: { kind: "tag" }, releasablePaths: ["src/"], ...extra }] });

test("(declaration) adopterFacing is read when named, must be a boolean, and an entry that omits it reads exactly as before (no key is added)", () => {
  assert.equal(parseProjectDeclaration(withDora({ adopterFacing: false }), "fixture").dora[0].adopterFacing, false);
  assert.equal(parseProjectDeclaration(withDora({ adopterFacing: true }), "fixture").dora[0].adopterFacing, true);
  assert.equal(Object.hasOwn(parseProjectDeclaration(withDora({}), "fixture").dora[0], "adopterFacing"), false, "absent stays absent: nothing existing changes");
  assert.throws(() => parseProjectDeclaration(withDora({ adopterFacing: "false" }), "fixture"), /dora\[0\]\.adopterFacing.*must be true or false/);
});
