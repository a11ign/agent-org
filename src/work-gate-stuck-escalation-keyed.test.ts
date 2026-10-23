// no-token: none -- the rows `escalateStuck` reads, files and labels are the fake code host's (A11-160, step 7), and the repository declaration is injected as `repoOf`; nothing imported reaches `gh`
/**
 * #3086: A STUCK `trunk-red` ORDER FOR A DECLARED CODE REPOSITORY (agent-org) WAS NEVER ESCALATED.
 *
 * `trunkRedOrders` (#3079) subjects agent-org's red `pr-agent-org#<n>`, or `trunk-agent-org-<sha8>` when no merged pull request is
 * known, and `stuckRowOf` deliberately reads neither as a row: `pr-56` would label a11ign's own #56. So the cause reached
 * `MAX_DELIVERIES`, went silent, and nobody was told. It now FILES an `answer:ceo` row in the primary's tracker, which
 * `rowsOwingAnswers` reads as an open row. (The subjects are written out here, not produced by `trunkRedOrders`, so this holds whether
 * or not #3079's producer has merged.)
 *
 * THE THREE CLAIMS, EACH WITH ITS CONTROL IN THE SAME FIXTURE: the keyed red reaches a place `ceo` reads (the filed row is fed to the
 * reader); the primary's red with the same number still labels the primary's row; and the keyed subject makes no `issue edit` at all,
 * so it can never label a row of the primary. Mutate `escalationTargetOf` to hand a keyed subject the primary's branch and the third goes
 * red; make it return `null` for a keyed subject and the first does.
 */
import { afterEach, test } from "node:test";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import assert from "node:assert/strict";
import { escalateStuck, stuckRowOf, stuckSubjectOf, ESCALATION_LABEL } from "./wake/merge-queue-wait.ts";
import { MAX_DELIVERIES } from "./wake/fyi-delivery-and-limits.ts";
import { answerOrders, rowsOwingAnswers } from "./work-gate/causes/rows-answers.ts";

const SHA = "0123abcd";
const MERGED = `worker-3075/trunk-red/pr-agent-org#56/${SHA}`;
const UNKNOWN_MERGE = `worker-3075/trunk-red/trunk-agent-org-${SHA}/${SHA}`;
const PRIMARY = `worker-3075/trunk-red/pr-56/${SHA}`;
const FILED = 3101;
/** The rows of the primary's tracker a stuck subject names, which the fake holds open and unlabelled: the primary's #56, the epics. */
const NAMED_ROWS = [56, 1317];

afterEach(() => forgetActivation());
/** The `run` the tick is handed: the rows are the fake's, so nothing may reach it. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host answers every read; nothing may run ${args.join(" ")}`); };

const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

/** A fake code host holding the named rows open and unlabelled, and `open` as the rows already waiting on ceo; the next row it files is #3101. */
function hostHolding(open: { number: number, title: string }[] = []) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.nextNumber = FILED;
  for (const number of NAMED_ROWS) world.rows.set(number, fakeRow(world, number));
  for (const held of open) world.rows.set(held.number, fakeRow(world, held.number, { title: held.title, labels: [ESCALATION_LABEL] }));
  substituteCodeHost(host);
  return { world, held: new Set([...NAMED_ROWS, ...open.map((row) => row.number)]) };
}

/**
 * One escalation. `edits` are the rows that were already there and now wait on ceo (the label edits), `filed` the rows it created (their title, body and labels, in the order they were written),
 * and `written` whether it wrote anything at all. `open` are the rows already waiting on ceo.
 */
function escalate(keys: string[], { open = [] as { number: number, title: string }[], repoOf = declared } = {}) {
  const { world, held } = hostHolding(open);
  const before = JSON.stringify([...world.rows.values()]);
  const log: string[] = [];
  const labelled = escalateStuck(keys.map((k) => `${k}: delivered ${MAX_DELIVERIES} times`), noRun, (l: string) => log.push(l), { repoOf });
  const edits = NAMED_ROWS.filter((number) => world.rows.get(number)!.labels.includes(ESCALATION_LABEL));
  const filed = [...world.rows.values()].filter((row) => !held.has(row.number));
  return { world, filed, edits, written: JSON.stringify([...world.rows.values()]) !== before, log: log.join(""), labelled };
}

test("a stuck red of a declared code repository is FILED as an answer:ceo row, whichever subject it carries", () => {
  for (const key of [MERGED, UNKNOWN_MERGE]) {
    const { filed, labelled, log } = escalate([key]);
    assert.equal(filed.length, 1, `${key}: one row filed`);
    assert.deepEqual(labelled, [FILED], "the filed row's number comes back, as a labelled row's does");
    assert.equal(filed[0].labels[0], ESCALATION_LABEL);
    assert.match(filed[0].title, /a11ign\/agent-org/, "the title names the repository, since the tracker's own rows do not");
    assert.match(log, /ESCALATED agent-org[#@]/);
  }
  assert.match(escalate([MERGED]).filed[0].title, /agent-org#56/);
  assert.match(escalate([UNKNOWN_MERGE]).filed[0].title, new RegExp(`agent-org@${SHA}`));
});

test("the filed row reaches ceo as an answer-owed order (the reader side)", () => {
  const [filed] = escalate([MERGED]).filed;
  const row = { number: 3101, state: "OPEN", labels: [{ name: filed.labels[0] }], title: filed.title };
  const orders = answerOrders(rowsOwingAnswers({ openRows: [row], openPrs: [], closedRows: [] })) as { session: string, causeKey: string }[];
  assert.deepEqual(orders.map((o) => [o.session, o.causeKey]), [["ceo", "ceo/answer-owed/row-3101"]]);

  const unlabelled = { ...row, labels: [] };
  assert.deepEqual(answerOrders(rowsOwingAnswers({ openRows: [unlabelled], openPrs: [], closedRows: [] })), [],
    "CONTROL: the same row without the label owes nobody an answer");
});

test("the primary's red of the SAME number still labels the primary's row, and files nothing", () => {
  const { edits, filed, labelled } = escalate([PRIMARY]);
  assert.deepEqual([edits, filed], [[56], []]);
  assert.deepEqual(labelled, [56]);
  assert.equal(stuckRowOf(PRIMARY), 56, "POSITIVE CONTROL for the null below: the primary's subject IS read as row 56");
});

test("a keyed subject never labels a row of the primary, with the primary's beside it as the control", () => {
  const { edits, filed } = escalate([MERGED, UNKNOWN_MERGE, PRIMARY]);
  assert.deepEqual(edits, [56], "only the primary's own subject edits a row, and it edits #56 once");
  assert.equal(filed.length, 2, "CONTROL: both keyed subjects were escalated, by filing");
  assert.equal(stuckRowOf(MERGED), null);
  assert.equal(stuckRowOf(UNKNOWN_MERGE), null);
});

test("a key the declaration does not list is reported, not filed and not labelled", () => {
  const { written, log } = escalate([MERGED], { repoOf: () => null });
  assert.equal(written, false);
  assert.match(log, /STUCK .*names no row of a repository this project declares/);
  assert.equal(escalate([MERGED]).written, true, "CONTROL: the same key IS escalated when declared");
});

test("an open row already titled for the red is the escalation: a second is not filed", () => {
  const first = escalate([MERGED]);
  const { title } = first.filed[0];
  const again = escalate([MERGED], { open: [{ number: 3100, title }] });
  assert.equal(again.filed.length, 0);
  assert.deepEqual(again.labelled, [3100]);
  const other = escalate([MERGED], { open: [{ number: 3100, title: "a different red" }] });
  assert.equal(other.filed.length, 1, "CONTROL: an open row for something else does not stand in");
});

test("a refused read is reported and NOT recorded, so the next tick tries again", () => {
  const recorded: string[] = [];
  const log: string[] = [];
  hostHolding().world.failures.set("readRowsByLabel", new Error("HTTP 502"));
  escalateStuck([`${MERGED}: x`], noRun, (l: string) => log.push(l), { repoOf: declared, record: (k: string) => recorded.push(k) });
  assert.match(log.join(""), /COULD NOT ESCALATE agent-org#56: HTTP 502/);
  assert.deepEqual<string[]>(recorded, []); // typed, or the assertion narrows `recorded` to `never[]` for the push that follows
  hostHolding();
  escalateStuck([`${MERGED}: x`], noRun, () => {}, { repoOf: declared, record: (k: string) => recorded.push(k) });
  assert.deepEqual(recorded, [MERGED], "CONTROL: a code host that answers records the key");
});

test("stuckSubjectOf reads each shape, and a hex primary subject is not mistaken for a keyed one", () => {
  assert.deepEqual(stuckSubjectOf(MERGED), { repoKey: "agent-org", number: 56, sha8: null });
  assert.deepEqual(stuckSubjectOf(UNKNOWN_MERGE), { repoKey: "agent-org", number: null, sha8: SHA });
  assert.deepEqual(stuckSubjectOf(PRIMARY), { repoKey: "", number: 56, sha8: null });
  assert.equal(stuckSubjectOf(`worker-3075/trunk-red/trunk-${SHA}/${SHA}`), null, "the primary's own unknown-merge subject names no row, as before");
  assert.equal(stuckSubjectOf("ceo/chairman-blocked/0"), null);
});

/** #4044: an unanswered `epic-finished` / `epic-unfiled` order carries `epic-<n>` (`subjectRef` writes `epic-<key>#<n>` for a keyed tracker). */
const EPIC_CAUSES = ["epic-finished", "epic-unfiled"];
const epicKey = (cause: string, ref: string) => `product-manager/${cause}/epic-${ref}`;

test("an unanswered epic-finished or epic-unfiled order labels the epic answer:ceo", () => {
  for (const cause of EPIC_CAUSES) {
    const key = epicKey(cause, "1317");
    assert.equal(stuckRowOf(key), 1317, `${cause}: the epic's number is the row to label`);
    const { edits, filed, labelled } = escalate([key]);
    assert.deepEqual([edits, filed], [[1317], []], `${cause}: labelled, nothing filed`);
    assert.deepEqual(labelled, [1317]);
  }
});

test("a keyed epic is read as the keyed repository's, and is never labelled on the primary nor filed as a red", () => {
  for (const cause of EPIC_CAUSES) {
    const key = epicKey(cause, "agent-org#12");
    assert.deepEqual(stuckSubjectOf(key), { repoKey: "agent-org", number: 12, sha8: null });
    assert.equal(stuckRowOf(key), null, "the primary's #12 is another row");
    const { written, log } = escalate([key]);
    assert.equal(written, false, `${cause}: no label, and no 'Stuck trunk-red' row for something that is not a red`);
    assert.match(log, /STUCK .*cannot be escalated/);
  }
});

test("CONTROLS for the epic reading: row-<n> still reads as <n>, and a day-number or count key still reads as null", () => {
  assert.equal(stuckRowOf("product-manager/answer-owed/row-5"), 5);
  assert.equal(stuckRowOf("product-manager/epic-unfiled/epics/16"), null, "the retired day-number form names no row");
  assert.equal(stuckRowOf("product-manager/epic-finished/16"), null);
  assert.equal(stuckRowOf("ceo/chairman-blocked/0"), null);
});

/** #4360: the row is worded for WHAT IS STUCK; a red pull request is not filed as "`main` is red". */
const RED_PR = "worker-4305/pr-checks-failing/pr-lab#39/fe4dce88";
const lab = (key: string): string | null => (key === "lab" ? "a11ign/lab" : null);

test("a stuck red PULL REQUEST is filed as a pull request, not as `main` being red", () => {
  const { title, body } = escalate([RED_PR], { repoOf: lab }).filed[0];
  assert.equal(title, "Stuck pr-checks-failing: lab#39 -- a pull request of a11ign/lab is red and nothing has fixed it");
  assert.doesNotMatch(title, /`main` of/);
  assert.match(body, /whether it is waiting on something.*not whether trunk is red/s);
  assert.doesNotMatch(body, /Fix `main`/);
});

test("CONTROL: a stuck trunk-red cause keeps its title and body", () => {
  const [filed] = escalate([MERGED]).filed;
  assert.equal(filed.title, "Stuck trunk-red: agent-org#56 -- `main` of a11ign/agent-org is red and nothing has fixed it");
  assert.match(filed.body, /^A `trunk-red` order for `a11ign\/agent-org` was offered .*Fix `main` of a11ign\/agent-org, or say why it should stay red\./s);
});

test("any other cause kind is worded by its own name, never as a trunk, and keeps its own title for the dedupe", () => {
  const key = "worker-9/some-new-cause/pr-lab#7/0123abcd";
  const [filed] = escalate([key], { repoOf: lab }).filed;
  const { title } = filed;
  assert.match(title, /^Stuck some-new-cause: lab#7 -- /);
  assert.doesNotMatch(title + filed.body, /`main`|trunk/);
  assert.notEqual(title, escalate([`worker-9/trunk-red/pr-lab#7/0123abcd`], { repoOf: lab }).filed[0].title);
  const again = escalate([key], { repoOf: lab, open: [{ number: 3100, title }] });
  assert.equal(again.filed.length, 0, "the dedupe by title still finds it");
});
