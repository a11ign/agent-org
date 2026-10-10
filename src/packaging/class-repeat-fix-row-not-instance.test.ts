// no-token: gh -- every `gh` call in this file is an injected fake tracker; nothing is read or filed (a11ign/agent-org#570)
// #570: A FAILURE-CLASS REPEAT ROW IS THE FIX FOR ITS CLASS, NOT AN INSTANCE OF IT. `classRowArgv` filed it with `--label class:<id>` and `rowOf` counted every closed
// row carrying one, so the row that answered a repeat became the next instance when it closed, was the newest, and offered `class-repeat` again (`hold-on-idle-row`, 2026-10-09:
// #4674 closed at 22:43:55Z and the class "first tripped" at 22:43:55Z, quoting it as the third occurrence).
//
// POSITIVE CONTROLS: every "does not count" case has a twin over the same tracker that DOES count, so a reader that drops every row, or one that counts every row, is red.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASS_ROW_MILESTONE, groupByClass, classRowArgv, readClassRepeat, type ClassGroup, type ClassRepeatFact } from "../class-repeat.ts";
import { classRepeatReadings } from "../org-health.ts";

const NOW = Date.parse("2026-10-09T23:00:00Z");
const MINUTE = 60_000;
const REPO = "a11ign/a11ign";
const INDEX = JSON.stringify({ classes: [{ id: "x", name: "the x failure", guard: "the x detector in CI", guardNote: null }] });
const REPEAT_TITLE = "Failure class x repeated: make its guard stop it everywhere";

const closed = (number: number, labels: string[], agoMs: number, title = `row ${number}`) =>
  ({ number, state: "closed", closed_at: new Date(NOW - agoMs).toISOString(), pull_request: false, labels, title });
const real = (number: number, agoMs: number) => closed(number, ["defect", "class:x"], agoMs);
/** the repeat row as it can reach the listing: labelled by the classifier (#4633) or by hand, though `classRowArgv` no longer labels it */
const repeatRow = (number: number, agoMs: number, title = REPEAT_TITLE) => closed(number, ["defect", "class:x"], agoMs, title);

/** A tracker that answers the issue listing as GitHub does for `state` and `labels`, and refuses any other call. */
function tracker(issues: object[]) {
  return (args: string[]) => {
    assert.equal(args[0], "api");
    const param = (name: string) => args.flatMap((a, i) => (args[i - 1] === "-f" && a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []))[0];
    let rows = issues;
    if (param("state")) rows = rows.filter((r) => (r as any).state === param("state"));
    if (param("labels")) rows = rows.filter((r) => (r as any).labels.includes(param("labels")));
    return JSON.stringify(rows.slice(0, Number(param("per_page"))));
  };
}

const factOf = (issues: object[]): ClassRepeatFact => readClassRepeat(tracker(issues), REPO, { root: "/project", read: () => INDEX, now: NOW });
const groupsOf = (fact: ClassRepeatFact): ClassGroup[] => {
  assert.ok(!("unreadable" in fact), "the fake tracker is readable");
  return groupByClass(fact.index, fact.rows);
};
/** how many instances the gate counts for class x */
const countOf = (issues: object[]): number => groupsOf(factOf(issues)).find((g) => g.id === "x")?.rows.length ?? 0;
const readingOf = (issues: object[]) => classRepeatReadings({ now: NOW, classRepeat: factOf(issues) })[0];

test("the class row is filed with no `class:` label (CONTROL: it is still a defect in the self-healing milestone)", () => {
  const [group] = groupsOf(factOf([real(10, 5 * MINUTE), real(11, MINUTE)]));
  const argv = classRowArgv(group);
  const labels = argv.flatMap((a, i) => (argv[i - 1] === "--label" ? [a] : []));
  assert.deepEqual(labels.filter((l) => l.startsWith("class:")), [], "the label marks an occurrence and this row is the fix");
  assert.equal(argv[argv.indexOf("--kind") + 1], "defect", "control: the argv is still the class row's");
  assert.equal(argv[argv.indexOf("--milestone") + 1], CLASS_ROW_MILESTONE, "control: and still in its milestone");
});

test("a closed repeat row that carries the class label is not a third instance (CONTROL: two real rows count 2, three real rows count 3)", () => {
  const two = [real(10, 20 * MINUTE), real(11, 10 * MINUTE)];
  assert.equal(countOf([...two, repeatRow(12, MINUTE)]), 2, "the fix row is not an occurrence");
  assert.equal(countOf(two), 2, "control: the same listing without the repeat row");
  assert.equal(countOf([...two, real(13, MINUTE)]), 3, "control: a third REAL row still counts, so the filter does not just lower every count");
});

test("the repeat row is not the newest instance either: the offer is discriminated by the last real row, so closing the fix row cannot make a new one", () => {
  const two = [real(10, 20 * MINUTE), real(11, 10 * MINUTE)];
  const [withFix] = groupsOf(factOf([...two, repeatRow(12, MINUTE)]));
  const [withoutFix] = groupsOf(factOf(two));
  assert.deepEqual(withFix.rows.map((r) => r.number), withoutFix.rows.map((r) => r.number));
  assert.equal(readingOf([...two, repeatRow(12, MINUTE)]).discriminator, readingOf(two).discriminator);
  assert.equal(readingOf(two).status, "tripped", "control: the two real rows are a repeat");
});

test("a repeat row alone under a class is not a repeat, and one real row beside it is still one occurrence (CONTROL: two real rows ARE a repeat)", () => {
  assert.notEqual(readingOf([repeatRow(12, MINUTE)]).status, "tripped", "closing a repeat row cannot be the thing that trips the next one");
  assert.deepEqual(groupsOf(factOf([repeatRow(12, MINUTE)])), [], "no instance, so no group and nothing to offer");
  assert.notEqual(readingOf([real(10, 10 * MINUTE), repeatRow(12, MINUTE)]).status, "tripped", "one occurrence and the row filed for it");
  assert.equal(readingOf([real(10, 10 * MINUTE), real(11, 5 * MINUTE)]).status, "tripped", "control: a second real row does trip it");
});

test("the title is what makes it a fix row: another id, and a title cut at the length limit, are fix rows; a real row that merely mentions the phrase is not", () => {
  const two = [real(10, 20 * MINUTE), real(11, 10 * MINUTE)];
  assert.equal(countOf([...two, repeatRow(12, MINUTE, "Failure class hold-on-idle-row repeated: make its guard stop it everywhere")]), 2, "any class id");
  const longId = "a-very-long-class-id-".repeat(6);
  const cut = `Failure class ${longId} repeated: make its guard stop it everywhere`.slice(0, 120);
  assert.equal(cut.length, 120);
  assert.equal(countOf([...two, repeatRow(12, MINUTE, cut)]), 2, "`classRowTitle` slices at 120 and the cut title is still the fix row");
  assert.equal(countOf([...two, closed(13, ["defect", "class:x"], MINUTE, "Failure class x repeated in the board export")]), 3, "control: a genuine occurrence with a nearby title counts");
  assert.equal(countOf([...two, closed(14, ["defect", "class:x"], MINUTE, "A failure class x repeated: make its guard stop it everywhere")]), 3, "control: the phrase must start the title");
});
