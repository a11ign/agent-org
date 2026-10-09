// no-token: gh -- importing `row-file.ts` reaches `gh`, and this file never lets it run: every write goes through a recording `run`, every fact through a fake reader, and `registryDistTags` is replaced by `readers`
/**
 * #4020: A WAIT THAT CLEARS ON A RELEASE FACT RAISES `needs:chairman` WHEN THE ACT THAT REMAINS IS THE CHAIRMAN'S. #2885 and #2887 sat parked three days after `screenreader-worker` 0.3.0
 * and `screenreader-fleet` 0.5.1 shipped, because "ask the chairman once the packages have real releases" was a sentence and nothing named the condition or the ask.
 *
 * THE FIXTURES COME FROM THE ROWS' TIMELINES (registry `time` map read 2026-10-07, not from memory): `screenreader-fleet` held only `0.0.0-reserved.0` (dist-tag `reserved`) until
 * `0.1.0` at 2026-10-04T23:36Z and is `0.5.1` now; `screenreader-worker` was `0.1.0` from 2026-10-04T10:04Z, `0.2.0` 2026-10-06T00:51Z, `0.3.0` 2026-10-06T05:28Z.
 * NOT KNOWN: whether the placeholder ever sat under `latest` (the registry keeps no history of dist-tags); the `reserved` tag it now carries suggests it was published with `--tag reserved`.
 *
 * #2885, THE HONEST LIMIT: its condition (`published ...@latest`) was TRUE the day it was parked, and `ceo` ruled the ask "not needed now". What it really waited on was a judgement ("a real
 * release"). THE GRAMMAR NOW HAS A FLOOR (`published <pkg>@<dist-tag> >= x.y.z`), so the judgement can be written down; WHICH floor #2885 would have declared is its declarer's call and
 * cannot be derived, so the test pins the capability on both sides of a floor and does not claim #2885's floor.
 *
 * RED/GREEN: on `origin/main` this file does not import (`work-gate/chairman-ask-orders.mjs` does not exist), and its predecessor reading, `splitHeldOnSatisfied` on a PARKED row, held 0 and
 * sent the wait to the generic stale-wait order (#4020's Open-check). MUTATIONS are recorded in the pull request, one per guard and in both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chairmanAskOrders, chairmanAskRefusal, askOf, withoutDeclaration, MARKER, postedBrief } from "../work-gate/chairman-ask-orders.ts";
import { parseWaits, conditionHolds, versionAtLeast, waitItemOf } from "../wait-condition.ts";
import { requestEvent } from "../messaging/sources/requests.ts";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-10-07T21:00:00Z");
const FLEET = "@a11ign/screenreader-fleet";
const LINES = [
  "What is happening: screenreader-fleet and screenreader-worker have real releases on npm.",
  "Ask: please run the first-publish step for the fleet package.",
  "Only you because: the npm token is yours.",
  "Checked: the registry holds latest 0.5.1 (2026-10-07).",
  "How long: two minutes.",
  "Unblocks: the fleet's own release workflow.",
  "Not the chairman's Claude session because: it holds no npm credentials.",
  "Declared: 2026-10-04",
];
const block = (lines = LINES) => ["Then-ask-chairman:", ...lines].join("\n");
const body = (wait: string, lines = LINES) => `## Why\n\nParked.\n\nWaiting-for: ${wait}\n\n${block(lines)}\n\nFiled-by: ceo\n`;
const row = (number: number, text: string, labels: string[] = ["lane:any", "parked"]) => ({ number, title: `row ${number}`, body: text, labels: labels.map((name) => ({ name })), updatedAt: "2026-10-04T00:00:00Z" });
const noItems = () => ({ items: {} });

/** A `gh` that records every write and answers the comment read; `fail` names a subcommand that throws. */
function fakeGh({ comments = [] as { body: string }[], fail = "", unreadable = false } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      if (unreadable) throw new Error("HTTP 502");
      return JSON.stringify({ comments });
    }
    if (`${args[0]} ${args[1]}` === fail) throw new Error("HTTP 403");
    return "";
  };
  const writes = () => calls.filter((a) => a[0] === "issue" && a[1] !== "view");
  return { run, calls, writes };
}

const readers = (distTags: Record<string, string> | null) => ({ distTags: () => distTags, tagExists: () => null });
const tick = (rows: unknown[], dist: Record<string, string> | null, io: ReturnType<typeof fakeGh>, extra = {}) =>
  chairmanAskOrders({ rows, now: NOW }, { run: io.run, repo: () => "a11ign/a11ign", readItemFacts: noItems, limit: 8, readers: readers(dist), log: () => {}, ...extra });

test("#2887 (the whole shape): RED while the registry holds only the placeholder, GREEN once `latest` exists -- the brief is posted, the label put on, the declaration removed, ceo told, ONCE", () => {
  const rows = [row(2887, body(`published ${FLEET}@latest`))];
  const before = fakeGh();
  assert.deepEqual(tick(rows, { reserved: "0.0.0-reserved.0" }, before), [], "the placeholder alone is not `latest`");
  assert.deepEqual(before.writes(), []);

  const after = fakeGh();
  const orders = tick(rows, { reserved: "0.0.0-reserved.0", latest: "0.5.1" }, after);
  const [comment, label, edit] = after.writes();
  assert.deepEqual(after.writes().map((a) => a.slice(0, 3)), [["issue", "comment", "2887"], ["issue", "edit", "2887"], ["issue", "edit", "2887"]]);
  const posted = comment[comment.indexOf("--body") + 1];
  assert.match(posted, /^BRIEF for the chairman\n/, "the comment OPENS with the marker the alert source reads");
  assert.match(posted, /^Condition true at 2026-10-07T21:00:00\.000Z: published @a11ign\/screenreader-fleet@latest \(registry dist-tags \{"reserved":"0\.0\.0-reserved\.0","latest":"0\.5\.1"\}\)$/m);
  assert.match(posted, /Declared 2026-10-04 by the row's author\. The tick re-read only the condition above: NOT that `Checked:` was true/);
  assert.ok(posted.trimEnd().endsWith(MARKER));
  assert.deepEqual(label, ["issue", "edit", "2887", "--add-label", "needs:chairman"]);
  const newBody = edit[edit.indexOf("--body") + 1];
  assert.doesNotMatch(newBody, /Then-ask-chairman|Waiting-for|Declared:|Ask:/, "the declaration it has used is gone, or the row would be ordered twice");
  assert.match(newBody, /## Why\n\nParked\./);
  assert.match(newBody, /Filed-by: ceo/);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "ceo");
  assert.equal(orders[0].causeKey, "ceo/org-health/chairman-ask-raised-order@2887");
  assert.match(orders[0].prompt, /remove `needs:chairman` now/);

  const again = fakeGh();
  assert.deepEqual(tick([row(2887, newBody, ["lane:any", "parked", "needs:chairman"])], { latest: "0.5.1" }, again), [], "the next tick sees a labelled row with no declaration");
  assert.deepEqual(again.calls, []);
});

test("the brief the tick posts is one the REAL alert source sends, with the declared lines in it", () => {
  const ask = askOf(waitItemOf(row(2887, body(`published ${FLEET}@latest`)), "row"));
  assert.equal(ask?.problem, null);
  const facts = { items: {}, releases: { [`npm:${FLEET}`]: { latest: "0.5.1" } } };
  const comment = { body: postedBrief(ask!, facts, NOW), createdAt: "2026-10-07T21:00:00Z", authorAssociation: "MEMBER" };
  const { event, problem } = requestEvent({ repo: "a11ign/a11ign", row: { number: 2887, title: "t", url: "u", comments: [comment] }, now: NOW });
  assert.equal(problem, null);
  assert.match(String(event?.text), /^What is happening: screenreader-fleet/);
  assert.match(String(event?.text), /Not the chairman's Claude session because: it holds no npm credentials\./);
});

test("CONTROLS raise NOTHING: a failed registry read, `latest` absent, the label already on, a block missing `Ask`", () => {
  const declared = body(`published ${FLEET}@latest`);
  const quiet = (rows: unknown[], dist: Record<string, string> | null) => {
    const io = fakeGh();
    const orders = tick(rows, dist, io);
    assert.deepEqual(io.writes(), []);
    return orders;
  };
  assert.deepEqual(quiet([row(1, declared)], null), [], "a failed read is unknown, and an unknown raises nothing");
  assert.deepEqual(quiet([row(1, declared)], { next: "0.6.0" }), [], "no `latest`");
  assert.deepEqual(quiet([row(1, declared, ["parked", "needs:chairman"])], { latest: "0.5.1" }), [], "already asked");
  const noAsk = quiet([row(1, body(`published ${FLEET}@latest`, LINES.filter((l) => !l.startsWith("Ask:"))))], { latest: "0.5.1" });
  assert.equal(noAsk.length, 1, "a malformed block is REPORTED, by name, and not silent");
  assert.equal(noAsk[0].session, "product-manager");
  assert.match(noAsk[0].prompt, /#1 carries a `Then-ask-chairman:` block that cannot send an alert: alert not sent: the newest brief for the chairman has no "Ask:" line/);
});

test("a block with no condition that can come true is malformed, and so is a second block, an inline one, and a block without a date", () => {
  const problemOf = (text: string) => askOf(waitItemOf(row(1, text), "row"))?.problem ?? null;
  assert.match(problemOf(`${block()}\n`) ?? "", /declares no `Waiting-for:` line/);
  assert.match(problemOf(`Waiting-for: manual\n${block()}\n`) ?? "", /cannot read/);
  assert.match(problemOf(`Waiting-for: soon\n${block()}\n`) ?? "", /cannot read/);
  assert.match(problemOf(`Waiting-for: closed #5\n${block()}\n\n${block()}\n`) ?? "", /more than once/);
  assert.match(problemOf(`Waiting-for: closed #5\nThen-ask-chairman: Ask: x\n`) ?? "", /UNDER/);
  assert.match(problemOf(`Waiting-for: closed #5\n${block(LINES.slice(0, -1))}\n`) ?? "", /Declared: YYYY-MM-DD/);
  assert.equal(problemOf(`Waiting-for: closed #5\n${block()}\n`), null, "the control: a sound block is not a problem");
});

test("a body QUOTING the grammar in a fence, or with no block at all, declares nothing", () => {
  assert.equal(askOf(waitItemOf(row(1, `\`\`\`\n${block()}\n\`\`\`\nWaiting-for: closed #5\n`), "row")), null);
  assert.equal(askOf(waitItemOf(row(1, "Waiting-for: closed #5\n"), "row")), null);
  const io = fakeGh();
  assert.deepEqual(tick([row(1, "Waiting-for: closed #5\n"), row(2, "no wait at all")], { latest: "1.0.0" }, io), []);
  assert.deepEqual(io.calls, [], "a quiet org with no declaration pays no call");
});

test("a floor says WHICH release counts (the #2885 case): below it nothing, at or above it the ask, and a version it cannot read is unknown", () => {
  const worker = "@a11ign/screenreader-worker";
  const wait = parseWaits(`Waiting-for: published ${worker}@latest >= 0.2.0`)[0];
  const facts = (latest: string) => ({ items: {}, releases: { [`npm:${worker}`]: { latest } } });
  assert.equal(conditionHolds(wait, facts("0.1.0")), false, "0.1.0 was `latest` from 2026-10-04: the unfloored wait was true the day it was parked");
  assert.equal(conditionHolds(wait, facts("0.2.0")), true);
  assert.equal(conditionHolds(wait, facts("0.3.0")), true);
  assert.equal(conditionHolds(wait, facts("0.2.0-next.1")), false, "a prerelease sorts below its release");
  assert.equal(conditionHolds(wait, facts("banana")), null);
  assert.equal(conditionHolds(parseWaits(`Waiting-for: published ${worker}@latest`)[0], facts("0.1.0")), true, "no floor: any version on the tag, as before");
  assert.equal(versionAtLeast("1.10.0", "1.9.9"), true, "numeric, not lexical");
  assert.equal(versionAtLeast("1.0", "1.0.0"), null);

  const rows = [row(2885, body(`published ${worker}@latest >= 0.2.0`))];
  assert.deepEqual(tick(rows, { latest: "0.1.0" }, fakeGh()), []);
  const io = fakeGh();
  assert.equal(tick(rows, { latest: "0.3.0" }, io).length, 1);
  assert.equal(io.writes().length, 3);
});

test("EVERY condition must be true: one still false, or unread, holds the ask back", () => {
  const text = `Waiting-for: closed #5\nWaiting-for: published ${FLEET}@latest\n\n${block()}\n`;
  const closed = (state: string) => () => ({ items: { "#5": { state, labels: [], resolvedAt: null, changedAt: null } } });
  const rows = [row(7, text)];
  const run = (state: string | null, dist: Record<string, string> | null) => {
    const io = fakeGh();
    const orders = tick(rows, dist, io, { readItemFacts: state === null ? noItems : closed(state) });
    return { orders, writes: io.writes().length };
  };
  assert.deepEqual(run("open", { latest: "0.5.1" }), { orders: [], writes: 0 });
  assert.deepEqual(run(null, { latest: "0.5.1" }), { orders: [], writes: 0 }, "an unread reference is an unknown");
  assert.deepEqual(run("closed", null), { orders: [], writes: 0 });
  const both = run("closed", { latest: "0.5.1" });
  assert.equal(both.orders.length, 1);
  assert.equal(both.writes, 3);
});

test("a failed write is recoverable: no label without a brief, and a posted brief is never posted twice", () => {
  const rows = [row(9, body(`published ${FLEET}@latest`))];
  const commentFails = fakeGh({ fail: "issue comment" });
  assert.deepEqual(tick(rows, { latest: "0.5.1" }, commentFails), [], "ceo is told only when the label went on");
  assert.deepEqual(commentFails.writes().map((a) => a[1]), ["comment"], "the label is NOT applied after a failed comment");

  const labelFails = fakeGh({ fail: "issue edit" });
  assert.deepEqual(tick(rows, { latest: "0.5.1" }, labelFails), []);
  const retry = fakeGh({ comments: [{ body: `BRIEF for the chairman\n...\n${MARKER}` }] });
  assert.equal(tick(rows, { latest: "0.5.1" }, retry).length, 1);
  assert.deepEqual(retry.writes().map((a) => a[1]), ["edit", "edit"], "the posted brief is found by its marker and not posted again");

  const blind = fakeGh({ unreadable: true });
  assert.deepEqual(tick(rows, { latest: "0.5.1" }, blind), []);
  assert.deepEqual(blind.writes(), [], "comments that cannot be read raise nothing");
});

test("a refused list raises nothing, and the cap bounds the raises per tick", () => {
  assert.deepEqual(chairmanAskOrders({ rows: null, now: NOW }, { run: fakeGh().run, repo: () => "x/y", readItemFacts: noItems, limit: 8 }), []);
  const rows = [1, 2, 3].map((n) => row(n, body(`published ${FLEET}@latest`)));
  const io = fakeGh();
  assert.equal(tick(rows, { latest: "0.5.1" }, io, { limit: 2 }).length, 2);
  assert.equal(io.writes().length, 6);
});

test("withoutDeclaration removes the block and the Waiting-for lines and leaves fenced text and the rest alone", () => {
  const text = `Intro\n\n\`\`\`\nWaiting-for: closed #1\n\`\`\`\n\nWaiting-for: closed #5\n\n${block()}\n\nTail\n`;
  assert.equal(withoutDeclaration(text), "Intro\n\n```\nWaiting-for: closed #1\n```\n\n\n\nTail\n");
});

test("row-file refuses a declaration that could never ask him, and files a sound one and a row with none", () => {
  assert.match(chairmanAskRefusal(`${block()}\n`) ?? "", /REFUSING to file .* declares no `Waiting-for:` line/);
  assert.match(chairmanAskRefusal(body("manual", LINES.slice(1))) ?? "", /no "Ask:"|Ask/);
  assert.equal(chairmanAskRefusal(body(`published ${FLEET}@latest`)), null);
  assert.equal(chairmanAskRefusal("## Why\n\nNothing declared.\n"), null);
  const source = readFileSync(new URL("../row-file.ts", import.meta.url), "utf8");
  assert.match(source, /blockedByRefusal\([^\n]*\) \?\? chairmanAskRefusal\(/, "the filing path calls the refusal");
});

test("the gate's tick calls the ask step with the open rows it read", () => {
  const source = readFileSync(new URL("../work-gate.ts", import.meta.url), "utf8");
  assert.match(source, /\.\.\.chairmanAsksNow\(openRowsRead\)/);
  assert.match(source, /chairmanAskOrders\(\{ rows: openRowsRead, now: Date\.now\(\) \},\s*\{ run: defaultRun, repo: repoNow, readItemFacts: readWaitFacts/);
});
