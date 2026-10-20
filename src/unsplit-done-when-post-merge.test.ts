// no-token: gh
//
// a11ign/agent-org#751 (class `row-not-finishable`; the chairman, a11ign#4437, 2026-10-10): the FOURTH refusal of `unfinishableItems`, `post-merge-act`. An act that can
// only happen AFTER the merge, with no time, seat or row named, passed `row-file` as `[]` twice (agent-org#475 and #560) and each held a worker for hours after its pull
// request merged with `Closes: none`.
//
// NO NETWORK: the bodies, the labels, the blocked-by list and the clock are fixtures. The two fixture Done-when sections are the live bodies of #475 and #560 as read
// 2026-10-10T20:02Z, copied whole, so the classifier is shown the row as it was filed and not a sentence shaped to pass.
//
// POSITIVE CONTROLS, NAMED (an emptiness assertion points at where its population is): case 1 is the non-empty population, the two rows that read `[]` before this;
// every `not flagged` case is paired with the SAME words made an act (cases 3 and 5), so a classifier that never fires fails case 1 and one that always fires fails 2-5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIssue } from "./row-file/roadmap-and-milestone-checks.ts";
import { liveCheckItems, unfinishableItems, unsplitDoneWhenRefusal } from "./unsplit-done-when.ts";
import { testEach } from "./lib/test-each.ts";

const NOW = new Date("2026-10-10T20:40:00Z");
const HEAD = "## Region\n\nscripts/foo.ts\n\n## Acceptance\n\n```\nnpx tsx --test src/foo.test.ts\n```\n\n## Open-check\n\n```\ngit grep -n foo origin/main | wc -l\n0\n```\n\n";
const bodyWith = (doneWhen: string, extra = "") => `${HEAD}## Done-when\n\n${doneWhen}\n\n${extra}`;
const findings = (body: string, declared = {}) => unfinishableItems(body, { now: NOW, declared });
const kindsOf = (body: string, declared = {}) => findings(body, declared).map((item) => item.kind);

// agent-org#475, filed 2026-10-09T10:52Z, whole Done-when section. Item 2 is the act; item 3 is the reading of what item 2 did.
const ROW_475 = "1. The Acceptance passes and the PR is merged.\n"
  + "2. `compact-store --dry-run` is run on the host against the live store and its counts are quoted on the PR; then `compact-store` is run, and the quote shows lines equal to "
  + "distinct ids and the backup's name. (The host run is the one-off de-dup of the existing store; do it with the receiver's current state named in the quote.)\n"
  + "3. `jq -r .id ~/.cache/a11ign/trace/events.ndjson | sort | uniq -d | wc -l` prints `0` after the run, pasted.";
// agent-org#560, filed 2026-10-09T21:25Z, whole Done-when section.
const ROW_560 = "1. The Acceptance passes and the pull request is merged.\n2. `a11ign#4623` is told on its row that the fix is in force, with the merge commit.";

const FAILING_ROWS = [
  { name: "#475", row: ROW_475, text: /^`compact-store --dry-run` is run on the host against the live store/, evidence: /run on the host/ },
  { name: "#560", row: ROW_560, text: /^`a11ign#4623` is told on its row that the fix is in force/, evidence: /told on its row that the fix is in force/ },
];

testEach("1. THE FAILING CASE: the Done-when of #475 and of #560 each name a `post-merge-act` (both read `[]` before), and ONLY that item", FAILING_ROWS, (c) => {
  const found = findings(bodyWith(c.row));
  assert.deepEqual(found.map((item) => item.kind), ["post-merge-act"]);
  assert.match(found[0].text, c.text);
  assert.match(found[0].evidence, c.evidence);
  for (const item of found) assert.deepEqual(item.rows, [], "an act names no row whose outcome it waits for");
});

test("2. NEGATIVE: the row's own first item and a lint item are not flagged, alone or beside a flagged one", () => {
  const NOT_FLAGGED = ["1. The Acceptance passes and the pull request is merged.", "1. The Acceptance passes and the PR is merged.", "1. `pnpm run lint` prints no errors",
    "1. `pnpm run lint` prints no errors.", "1. The tests pass and the change is in the pull request.", "1. The README names the flag."];
  for (const item of NOT_FLAGGED) assert.deepEqual(kindsOf(bodyWith(item)), [], item);
  assert.deepEqual(findings(bodyWith(`${ROW_560}\n3. \`pnpm run lint\` prints no errors`)).map((item) => item.text.slice(0, 20)), ["`a11ign#4623` is tol"], "only the act is named");
});

test("3. CONTROL: the same words are not an act when the item is a test's assertion, a quotation, or says the act is another row's", () => {
  const NOT_AN_ACT = [
    "1. The test runs the command against a fake host and the file bytes are equal before and after the run.",
    "1. `compact-store` is run on a copy of the store in the test, and the counts equal the fixture's.",
    '1. A test closes a row whose Done-when 2 reads "`x` is told on its row that the fix is in force, with the merge commit".',
    "1. The refusal names the merge commit of the base it was checked against.",
    // #476's own item, verbatim: it SAYS the host acts are a verify row's, so it asks nothing of this row (measured in the live sweep; the first draft flagged it)
    "1. The Acceptance passes and the PR is merged.\n\nThe two host readings (`trace.ts duplicates` run once on the host with its count quoted, and the first daily ingest's "
      + "`duplicate ids` line) are acts after the merge, so they are their own VERIFY row, filed by `product-manager` at the merge. This row closes on the merge.",
    "1. The live run on the host is NOT this row's item: it is the verify row's.",
  ];
  for (const item of NOT_AN_ACT) assert.deepEqual(kindsOf(bodyWith(item)), [], item);
  // and the same act, with nothing that disowns it, IS flagged: the guard is the only difference
  assert.deepEqual(kindsOf(bodyWith("1. The two host readings (`trace.ts duplicates` run once on the host with its count quoted) are taken.")), ["post-merge-act"]);
});

test("4. CONTROL: a reading (a `live-check`) is still not refused, and an item matching BOTH is refused at filing yet still read by the verify row's reader", () => {
  const READINGS = ["1. One record per use is quoted on #4627.", "1. The `trunk` log line names the verify row after the merge.", "1. The switch reads on in the field.",
    "1. Use 1 is live in a11ign.", "1. The published version carries the fix.", "1. Version 1.4.2 is published.", "1. The count is correct in production.",
    "1. The live gh call is mocked in the test.", "1. The acceptance command's output is quoted in the pull request."];
  for (const item of READINGS) assert.deepEqual(kindsOf(bodyWith(item)), [], item);
  const both = "1. After the merge, `compact-store` is run on the host.";
  assert.deepEqual(kindsOf(bodyWith(both)), ["post-merge-act"], "an act is refused at filing even when it also reads as a live check");
  assert.equal(liveCheckItems(bodyWith(both), { now: NOW }).length, 1, "a row filed before this still gets its verify row at close: that reader is unchanged");
});

test("5. each phrase the row names is an act, and each has its own control (the same noun with no act on the merged result)", () => {
  const ACTS = [
    "1. `compact-store` is run on the host.", "1. `sweep --apply` is applied against the live store.", "1. On the host, the migration is run once.", "1. A live run of the backfill is quoted.",
    "1. #4623 is told that the fix is in force.", "1. A comment on #4623 says that the guard is live.", "1. The row is updated with the merge commit.",
    "1. `refresh-outsider-pin` is run once installed.", "1. After the release, the row is commented.", "1. The count is posted once it is deployed.",
  ];
  const CONTROLS = [
    "1. `compact-store` is run in the test.", "1. `sweep --apply` is covered by a test on a temp directory.", "1. The migration is run once per fixture.", "1. A dry run of the backfill is quoted.",
    "1. #4623 is cited in the body.", "1. A comment on #4623 explains the guard.", "1. The row names the branch it was built on.",
    "1. `refresh-outsider-pin` is covered by the test.", "1. After the refactor, the row is unchanged.", "1. The count is posted in the pull request.",
  ];
  ACTS.forEach((item, i) => {
    assert.deepEqual(kindsOf(bodyWith(item)), ["post-merge-act"], item);
    assert.deepEqual(kindsOf(bodyWith(CONTROLS[i])), [], `its control: ${CONTROLS[i]}`);
  });
});

test("6. an item already `future-time`, `seat-act` or `row-outcome` KEEPS that kind and is not counted twice", () => {
  const cases: [string, string][] = [
    ["1. Read it on day 3 and `compact-store` is run on the host.", "future-time"],
    ["1. `compact-store` is run on the host after 2026-10-12.", "future-time"],
    ["1. ceo runs `compact-store` on the host.", "seat-act"],
    ["1. Once #4438 merges, `compact-store` is run on the host.", "row-outcome"],
  ];
  for (const [item, kind] of cases) {
    const found = findings(bodyWith(item));
    assert.equal(found.length, 1, `one finding for one item: ${item}`);
    assert.equal(found[0].kind, kind, item);
  }
  assert.deepEqual(kindsOf(bodyWith(`1. Read it on day 3.\n2. ${ROW_560.split("\n")[1].slice(3)}\n3. Once #4438 merges, go.`)), ["future-time", "post-merge-act", "row-outcome"],
    "three items, three kinds, in order");
});

test("7. the act is NOT refused when it already follows something (the verify row IS the split): an edge, a wait, a done-when edge or a `Verifies:` line", () => {
  const act = "1. `compact-store` is run on the host.";
  assert.deepEqual(kindsOf(bodyWith(act)), ["post-merge-act"], "the control: the same body with no data");
  assert.deepEqual(kindsOf(bodyWith(act), { blockedBy: [475] }), []);
  assert.deepEqual(kindsOf(bodyWith(act, "Waiting-for: merged #475\n")), []);
  assert.deepEqual(kindsOf(bodyWith(act, "Waits-on-done-when: 475.1\n")), []);
  assert.deepEqual(kindsOf(bodyWith(act, "Verifies: #475\n\n<!-- verify-row: build #475 -->\n")), [], "what `verify-row.ts` writes");
  assert.deepEqual(kindsOf(bodyWith(act, "Waiting-for: soon\n")), ["post-merge-act"], "an UNREADABLE Waiting-for is not data");
  assert.deepEqual(kindsOf(bodyWith(act, "Not-before: 2026-10-12T19:00:00Z\n")), ["post-merge-act"], "a time alone does not follow the merge");
  assert.deepEqual(kindsOf(bodyWith(act), { labels: ["answer:ceo"] }), ["post-merge-act"], "a seat's label is not a build to follow");
});

test("8. THE REFUSAL names the item and the split: the build row first, the verify row follows it; and nothing is filed", () => {
  const refusal = String(unsplitDoneWhenRefusal(bodyWith(ROW_560), { now: NOW }));
  assert.match(refusal, /REFUSING to file/);
  assert.match(refusal, /\[post-merge-act: `told on its row that the fix is in force`\]/);
  assert.ok(refusal.includes('SECOND ROW\'s Done-when: "`a11ign#4623` is told on its row that the fix is in force, with the merge commit."'), refusal);
  assert.match(refusal, /--blocked-by <the build row>/);
  assert.match(refusal, /file the build row[^]*the verify row follows it/);
  assert.match(refusal, /an act that needs the merged result/, "the preamble names the fourth kind");
  assert.match(refusal, /Nothing was filed/);
  assert.equal(unsplitDoneWhenRefusal(bodyWith(ROW_560.split("\n")[0]), { now: NOW }), null, "the build row without the act is not refused");
});

test("9. WIRED IN: `createIssue` refuses #560's Done-when before anything is filed, and does not refuse the build row without the act", () => {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let creates = 0;
  const attempt = (doneWhen: string) => {
    written.length = 0;
    const status = createIssue(["--title", "t", "--session=product-manager", "--body", bodyWith(doneWhen)], { spawnGh: () => { creates += 1; return ""; }, run: () => "" });
    return { status, said: written.join("") };
  };
  try {
    const unsplit = attempt(ROW_560);
    assert.equal(unsplit.status, 1);
    assert.match(unsplit.said, /post-merge-act/);
    assert.match(unsplit.said, /READY MEANS FINISHABLE/);
    assert.equal(creates, 0, "nothing was filed");
    const split = attempt(ROW_560.split("\n")[0]);
    assert.doesNotMatch(split.said, /READY MEANS FINISHABLE/, "the build row alone is not refused for it");
  } finally {
    process.stderr.write = write;
  }
});
