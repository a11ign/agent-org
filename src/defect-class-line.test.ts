// no-token: gh -- `defect-class-line.mjs` reads a row's labels only through the reader it is given, `pr-open`'s `main` and `row-file`'s `createIssue` take `git`, `gh` and the label reader as seams, and every one here is a fake; nothing reaches GitHub
// #4123 (child A of #4122): a pull request that closes a `defect` row carries exactly one `Class:` line, and `row-file --kind defect` is what puts the label on the row.
//
// EVERY REFUSAL HAS ITS ACCEPTING TWIN differing by ONE fact, so a check that always refuses is red in the twin and one that never refuses is red in the first.
// `defectBody` is the control for every "refused" below: the same body with a well-formed line is accepted, so a refusal is the line's doing and not the fixture's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_BODY_REPORTS, rowLabelsFromEnv, runCiBodyReports } from "./acceptance-commands.ts";
import { DEFECT_LABEL, classLinesIn, defectClassReport } from "./defect-class-line.ts";
import { main as prOpen, EXIT_NOTHING_SENT } from "./pr-open.ts";
import { createIssue, kindRefusal, withKindLabel } from "./row-file.ts";

const EM = "—";
const GOOD = `Class: stale-reading ${EM} any reader that caches a label it is asked for later; guard: #4122 child B's class-repeat reading`;
const NONE = `Class: none ${EM} a one-off typo in a doc, no mechanism behind it`;

/** @param {string[]} lines */
const bodyWith = (...lines: string[]) => `## Acceptance\n\nnode -e "process.exit(0)"\n\nCloses #4107\n${lines.join("\n")}\n`;
const LABELS = { "a11ign/a11ign#4107": ["defect", "ready"], "a11ign/a11ign#4108": ["ready"] };
/** The reader `pr-open` is handed: `(number, repo)`. */
const rowLabels = (number: number, repo: string) => {
  const labels = LABELS[`${repo}#${number}`];
  if (!labels) throw new Error(`HTTP 403 reading ${repo}#${number}`);
  return labels;
};

/** `pr-open create`, nothing sent anywhere; returns the exit code, what it said and whether it went to `gh`. */
function openPr(body, deps = { rowLabels }) {
  const sent = [];
  const err = [];
  const out = [];
  const code = prOpen(["create", "--draft", "--body", body], {
    run: (a) => { sent.push(a); }, git: () => "x", prHead: () => ({ ref: "x", oid: "x" }),
    runAcceptance: () => 0, runMutation: () => 0, owner: () => null, out: (l) => { out.push(l); }, err: (l) => { err.push(l); },
    ...deps,
  });
  return { code, sent, said: [...out, ...err].join("") };
}

/** The CI parse over the same body: what the acceptance job prints, with the label reader CI is given. */
const ciParse = (body, labelsOf = (row) => rowLabels(row.number, row.repo ?? "a11ign/a11ign")) =>
  runCiBodyReports({ body, run: () => 0, diff: { ok: true, files: [] }, rowLabels: labelsOf }, CI_BODY_REPORTS.filter((r) => r.name === "class"));

test("the parser reads both shapes and keeps what it cannot read (positive control for every refusal below)", () => {
  assert.deepEqual(classLinesIn(GOOD).declared, [{ id: "stale-reading", where: "any reader that caches a label it is asked for later", guard: "#4122 child B's class-repeat reading" }]);
  assert.deepEqual(classLinesIn(NONE).declared, [{ id: "none", reason: "a one-off typo in a doc, no mechanism behind it" }]);
  assert.deepEqual(classLinesIn(`**Class:** stale-reading ${EM} where; guard: g`).malformed, [], "bold and bulleted spellings are read, as Hand-fix: is");
  assert.deepEqual(classLinesIn("the Class: word mid-line is prose"), { declared: [], malformed: [] });
});

test("a body that closes a defect row without the Class line is REFUSED by pr-open and by the CI parse", () => {
  const body = bodyWith();
  const opened = openPr(body);
  assert.equal(opened.code, EXIT_NOTHING_SENT);
  assert.deepEqual(opened.sent, [], "nothing was sent to GitHub");
  assert.match(opened.said, /closes a defect row without the Class line/);
  const ci = ciParse(body);
  assert.equal(ci.ok, false);
  assert.match(ci.lines.join("\n"), /closes a defect row without the Class line/);
});

test("the same body is ACCEPTED with `Class: none -- <reason>` and with `Class: <id> -- ...; guard: ...`, by both readers", () => {
  for (const line of [NONE, GOOD]) {
    const opened = openPr(bodyWith(line));
    assert.equal(opened.code, 0, `${line}: ${opened.said}`);
    assert.ok(opened.sent.some((a) => a[0] === "pr" && a[1] === "create"), "the PR was created");
    assert.equal(ciParse(bodyWith(line)).ok, true, line);
  }
});

test("a reasonless none, a line with no guard half, no em dash, an unkebab id and two lines are each MALFORMED and refused", () => {
  const malformed = [
    "Class: none",
    `Class: none ${EM}`,
    `Class: stale-reading ${EM} where else it can occur`,
    `Class: stale-reading ${EM} where else; guard:`,
    `Class: stale-reading ${EM} ; guard: g`,
    "Class: stale-reading - where else it can occur; guard: g",
    `Class: Stale_Reading ${EM} where; guard: g`,
  ];
  for (const line of malformed) {
    const opened = openPr(bodyWith(line));
    assert.equal(opened.code, EXIT_NOTHING_SENT, line);
    assert.match(opened.said, /CLASS: MALFORMED/, line);
    assert.ok(opened.said.includes(line), `${line}: the offending line is quoted`);
    assert.equal(ciParse(bodyWith(line)).ok, false, line);
  }
  const twice = bodyWith(GOOD, NONE);
  assert.equal(openPr(twice).code, EXIT_NOTHING_SENT, "two well-formed lines are a duplicate, as two Acceptance: lines are");
  assert.match(ciParse(twice).lines.join("\n"), /2 `Class:` lines/);
  assert.equal(ciParse(bodyWith(GOOD, "Class: none")).ok, false, "one good and one malformed is not one line");
});

test("a body that closes a row WITHOUT the defect label needs no line, and a body that closes no row needs none", () => {
  const plain = bodyWith().replace("#4107", "#4108");
  assert.equal(openPr(plain).code, 0);
  assert.match(ciParse(plain).lines.join(""), /not required/);
  const none = "## Acceptance\n\nnode -e \"process.exit(0)\"\n\nCloses: none -- a docs change\n".replace("--", EM);
  assert.equal(openPr(none).code, 0);
  assert.match(ciParse(none).lines.join(""), /not required -- the body closes no row/);
});

test("a refused label read is UNKNOWN with a message and never a pass; a half-answered list is unknown for the row that did not answer", () => {
  const opened = openPr(bodyWith(), { rowLabels: () => { throw new Error("HTTP 403 rate limit"); } });
  assert.equal(opened.code, EXIT_NOTHING_SENT);
  assert.match(opened.said, /CLASS: UNKNOWN -- could not read the labels of #4107 \(HTTP 403 rate limit\)/);
  assert.match(opened.said, /a refusal, not a pass/);
  const both = bodyWith().replace("Closes #4107", "Closes #4107, #4108");
  const half = openPr(both, { rowLabels: (number, repo) => { if (number === 4108) throw new Error("HTTP 502"); return rowLabels(number, repo); } });
  assert.match(half.said, /closes a defect row without the Class line/, "a row that answered `defect` decides, whatever the other did");
  const unreadable = { rowLabels: (n: number, repo: string) => { if (n === 4107) return ["ready"]; throw new Error("HTTP 502"); } };
  assert.match(openPr(both, unreadable).said, /CLASS: UNKNOWN -- could not read the labels of #4108/, "one clean row and one unread is still unknown");
});

test("no reader at all is printed as NOT CHECKED, and a well-formed line passes without a label read", () => {
  const unwired = openPr(bodyWith(), {});
  assert.equal(unwired.code, 0, "the test deps of every other pr-open caller wire no reader");
  assert.match(unwired.said, /CLASS: NOT CHECKED -- no reader of #4107's labels here/);
  let reads = 0;
  const report = defectClassReport({ body: bodyWith(GOOD), rows: [{ repo: null, number: 1 }], rowLabels: () => { reads += 1; return []; } });
  assert.deepEqual([report.ok, reads], [true, 0], "a body that already has its line costs no API call");
});

test("CI's acceptance step is GIVEN the labels (it is tracker-less on purpose): a named map is the reader, an unset one is none, a missing key throws", () => {
  assert.equal(rowLabelsFromEnv({}), undefined, "the step has no token and no map: NOT CHECKED, not a pass");
  const reader = rowLabelsFromEnv({ ACCEPTANCE_ROW_LABELS: JSON.stringify({ "a11ign/a11ign#4107": ["defect"] }), GITHUB_REPOSITORY: "a11ign/a11ign" });
  assert.deepEqual(reader?.({ repo: null, number: 4107 }), ["defect"], "a bare #N is the running repository's");
  assert.throws(() => reader?.({ repo: "a11ign/other", number: 1 }), /names no labels for a11ign\/other#1/);
  assert.equal(ciParse(bodyWith(), reader).ok, false, "and the map reaches the same refusal");
});

test("row-file --kind defect adds the defect label to the filing; without it none is added; an unknown kind is refused before anything is filed", () => {
  const argv = ["--title", "t", "--session=worker-1"];
  assert.deepEqual(withKindLabel([...argv, "--kind", "defect"]), [...argv, "--label", DEFECT_LABEL]);
  assert.deepEqual(withKindLabel([...argv, "--kind=defect"]), [...argv, "--label", DEFECT_LABEL]);
  assert.deepEqual(withKindLabel(argv), argv, "no --kind, no label");
  assert.deepEqual(withKindLabel([...argv, "--label", "Defect", "--kind", "defect"]), [...argv, "--label", "Defect"], "a filer's own spelling is not doubled");
  for (const bad of [["--kind", "bug"], ["--kind"], ["--kind="], ["--kind", "constructor"]]) {
    assert.match(kindRefusal([...argv, ...bad]) ?? "", /REFUSING to file -- `--kind /, bad.join(" "));
  }
  assert.equal(kindRefusal([...argv, "--kind", "defect"]), null);
  const filed = fileWith(["--kind", "defect"]);
  assert.equal(filed.code, 0, filed.said);
  assert.deepEqual(filed.created.filter((_, i, all) => all[i - 1] === "--label"), ["defect"], "gh issue create carries --label defect");
  assert.ok(!filed.created.includes("--kind"), "and never --kind, which gh does not know");
  assert.deepEqual(filed.ensured, ["defect"], "the label is made in the repository before gh names it");
  const plain = fileWith([]);
  assert.equal(plain.code, 0, plain.said);
  assert.ok(!plain.created.includes("--label") && plain.ensured.length === 0, "without --kind, no label is added or made");
});

test("row-file does not report a defect row filed when the read-back lacks the label", () => {
  const filed = fileWith(["--kind", "defect"], { labelsOnRow: ["backlog", "lane:any"] });
  assert.equal(filed.code, 2);
  assert.match(filed.said, /missing: the `defect` label/);
});

const FILING_BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n## Acceptance\n\n```\nnpx tsx --test x\n```\n\n## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const FILED_URL = "https://github.com/a11ign/a11ign/issues/900";

/** `createIssue` with every seam a fake, returning what reached `gh issue create` and what was made. */
function fileWith(extra, { labelsOnRow = null } = {}) {
  const created = [];
  const ensured = [];
  const said = [];
  const write = process.stderr.write;
  const writeOut = process.stdout.write;
  process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
  process.stdout.write = () => true;
  try {
    const argv = ["--title", "a defect", "--body", FILING_BODY, "--session=worker-1", "--milestone", "CI reset", ...extra];
    const withKind = extra.length > 0;
    const code = createIssue(argv, {
      spawnGh: (a) => { created.push(...a); return FILED_URL; },
      run: (_cmd, args) => (args[0] === "issue" && args[1] === "list" ? "[]" : args.includes("milestone") ? "CI reset" : args.includes("body") ? `${FILING_BODY}\n\nFiled-by: worker-1\n` : ""),
      fetchBoardStatus: () => "Backlog",
      fetchLabels: () => ({ number: 900, title: "a defect", labels: labelsOnRow ?? ["backlog", "lane:any", ...(withKind ? ["defect"] : [])] }),
      moveStatus: () => ({ moved: true }), milestones: () => ["CI reset"], loadLanesConfig: () => ({ lanes: [] }),
      ensureLabels: (labels) => { if (created.length === 0) ensured.push(...labels); }, // only the labels made BEFORE `gh issue create`; the board and lane labels come after
    });
    return { code, created, ensured, said: said.join("") };
  } finally {
    process.stderr.write = write;
    process.stdout.write = writeOut;
  }
}
