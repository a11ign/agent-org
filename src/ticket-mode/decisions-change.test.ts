// no-token: gh -- pure builders and the hook's judgment over files in a temporary folder; nothing is spawned
// module: a change to a ticket's Decisions reaches the worker's round and holds its `reviewed` (A11-305) -- the lines that changed, the brief's first section, the Stop hook's refusal
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { asksForWork, DECISIONS_CHANGED, decisionsChange, linesToQuote, saysWhy, unquotedLines } from "./decisions-change.ts";
import { DECISIONS_ROUND_FILE } from "./decisions-files.ts";
import { MAX_STOP_REFUSALS, stopVerdict } from "./hook.ts";
import type { Ticket } from "./source.ts";
import { ticketReadOf } from "./ticket-read.ts";
import { reviewBriefText } from "./worker-files.ts";

const BEFORE = "Rework the merge flow.\n\n## Done-when\n\n- it merges\n\n## Decisions (the chairman, 2026-10-24)\n\n- Keep the ruleset.\n";
const NEW_LINE = "- Private repositories get a merge bot, not a ruleset.";
const AFTER = `${BEFORE}\n## Decisions (the chairman, 2026-10-26)\n\n${NEW_LINE}\n`;
const URL = "https://github.com/a11ign/plugin/pull/11";
const ticket = { key: "A11-291", title: "Merge bot", description: AFTER, url: "https://linear.app/a11ign/issue/A11-291", branch: "a11-291", status: "In Progress", statusOrder: 0, team: "A11", project: null, priority: 3 } as Ticket;
const reads = (before: string, after: string) => ({ previous: ticketReadOf({ description: before }, 1), read: ticketReadOf({ description: after, updatedAt: "2026-10-26T21:30:00.000Z" }, 2) });
const brief = (extra: Partial<Parameters<typeof reviewBriefText>[0]> = {}, text = reads(BEFORE, AFTER)) =>
  reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [{ repo: "plugin", url: URL }], resumed: true, ...text, ...extra });
/** The first `## ` heading of a brief: its first section. */
const firstSection = (text: string): string => text.split("\n").find((line) => line.startsWith("## ")) ?? "";

test("A11-305: a new Decisions entry is the added lines, a taken-out one the removed, and a change outside the Decisions is none", () => {
  const added = decisionsChange(BEFORE, AFTER);
  assert.deepEqual(added?.added, ["## Decisions (the chairman, 2026-10-26)", NEW_LINE]);
  assert.deepEqual(added?.removed, []);
  assert.ok(added?.diff.includes(`+ ${NEW_LINE}`));
  assert.ok(asksForWork(added));
  const taken = decisionsChange(AFTER, BEFORE);
  assert.deepEqual([taken?.added, taken?.removed.length], [[], 2]);
  assert.ok(!asksForWork(taken), "a decision taken out leaves nothing for a pull request to meet");
  assert.equal(decisionsChange(BEFORE, `${BEFORE}\n## Notes\n\nmore prose\n`), null, "a line outside the Decisions is no change of them");
  assert.equal(decisionsChange(BEFORE, `${BEFORE}   \n\n`), null, "spacing is no change");
  assert.deepEqual(decisionsChange("Fix it.", AFTER)?.added.at(-1), NEW_LINE, "a ticket with no Decisions before has all of them added");
  assert.equal(decisionsChange(null, undefined), null);
});

test("A11-305: the chairman's one-line decision counts as a Decisions change too", () => {
  const line = "By the chairman's decision on 2026-10-26, the merge bot replaces the ruleset.";
  assert.deepEqual(decisionsChange("Fix it.", `Fix it.\n\n${line}\n`)?.added, [line]);
});

test("A11-305: a review round's brief opens with the changed lines and the instruction, before anything else", () => {
  const text = brief({ feedback: "New review comment." });
  assert.equal(firstSection(text), "## The ticket's Decisions changed", "the first section is the change");
  const section = text.slice(text.indexOf("## The ticket's Decisions changed"), text.indexOf("## The ticket\n"));
  assert.ok(section.includes(DECISIONS_CHANGED));
  assert.equal(DECISIONS_CHANGED, "The ticket's Decisions changed: make the pull requests meet them, or reply quoting why they already do.");
  assert.ok(section.includes(`+ ${NEW_LINE}`), "the changed lines are in it");
  assert.ok(!section.includes("+ - Keep the ruleset"), "and a line that did not change is not marked added");
  assert.ok(text.indexOf(DECISIONS_CHANGED) < text.indexOf("## The ticket\n"), "it comes before the ticket's own text");
});

test("A11-305: every kind of round names the change: a Respond round, a feedback round, a conflict round, an approved draft and a stand-off", () => {
  const kinds: [string, Partial<Parameters<typeof reviewBriefText>[0]>][] = [
    ["Respond", { asked: true }],
    ["Respond with a conflict", { asked: true, conflict: `${URL} conflicts with its base branch main.` }],
    ["feedback", { feedback: "A reviewer asked for a rename." }],
    ["conflict", { feedback: `${URL} conflicts with its base branch main.` }],
    ["approved drafts", {}],
    ["stand-off", { standoff: true, feedback: "The re-reviewer is not convinced." }],
    ["the board's own Decisions round", { decisions: true }],
  ];
  for (const [name, extra] of kinds) {
    const text = brief(extra);
    assert.equal(firstSection(text), "## The ticket's Decisions changed", `${name}: the change is the first section`);
    assert.ok(text.includes(`+ ${NEW_LINE}`), `${name}: with the same diff`);
    assert.match(text, /a `reviewed` with no push is allowed only when your final message quotes the new lines/, `${name}: and the end is held to it`);
  }
});

test("A11-305: a round whose ticket's Decisions did not change has no such section, and a round with no earlier text has none", () => {
  const same = brief({ asked: true }, reads(AFTER, AFTER));
  assert.ok(!same.includes("## The ticket's Decisions changed"));
  assert.ok(!same.includes("a `reviewed` with no push is allowed only"));
  const prose = brief({ asked: true }, reads(BEFORE, `${BEFORE}\n## Notes\n\nmore prose\n`));
  assert.ok(!prose.includes("## The ticket's Decisions changed"), "a change of other text keeps the old section about the ticket, not this one");
  assert.ok(prose.includes("### The ticket changed since your last round"));
  const unknown = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [], resumed: true, asked: true, read: reads(BEFORE, AFTER).read });
  assert.ok(!unknown.includes("## The ticket's Decisions changed"));
});

test("A11-305: the board's own round for a changed Decisions answers it, marks nothing ready, and says no feedback came", () => {
  const text = brief({ decisions: true });
  assert.match(text, /^# A11-291: decisions round for Merge bot/);
  assert.match(text, /No new feedback reached the pull requests: the changed Decisions are what you answer\./);
  assert.match(text, /do not run `gh pr ready`/);
  assert.ok(!text.includes("A person reviewed your draft pull requests and approved them"), "it is no round for approved drafts");
  assert.match(text, /1\. Read the new lines of the ticket's Decisions in the first section/);
});

test("A11-305: the quote is found through quote marks, backticks, list marks and spacing, and a missing line is named", () => {
  const added = ["## Decisions (the chairman, 2026-10-26)", NEW_LINE, "- The merge bot is a GitHub App."];
  assert.deepEqual(linesToQuote(added), [NEW_LINE, "- The merge bot is a GitHub App."], "a heading only names the entry");
  assert.deepEqual(linesToQuote(["## Decisions"]), ["## Decisions"], "unless it is all there is");
  assert.deepEqual(unquotedLines(added, "> Private repositories get a  merge bot, not a `ruleset`.\n> - The merge bot is a GitHub App.\nBoth hold."), []);
  assert.deepEqual(unquotedLines(added, "Private repositories get a merge bot, not a ruleset."), ["- The merge bot is a GitHub App."]);
  assert.deepEqual(unquotedLines(added, "I checked the decisions."), [NEW_LINE, "- The merge bot is a GitHub App."]);
  assert.equal(saysWhy([NEW_LINE], `> ${NEW_LINE.slice(2)}`), false, "a bare quote says nothing of why");
  assert.equal(saysWhy([NEW_LINE], `> ${NEW_LINE.slice(2)}\nThe pull request already installs the merge bot and removes the ruleset step, in src/bot.ts.`), true);
});

/** A round the board left its mark for: the new lines and the head each pull request had. */
function decisionsRound(outcome: object = { kind: "reviewed" }, heads: Record<string, string | null> = { [URL]: "h1" }, added: string[] = [NEW_LINE]) {
  const dir = tmpDir("ticket-hook-decisions-");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
  writeFileSync(join(dir, DECISIONS_ROUND_FILE), JSON.stringify({ added, heads }));
  return dir;
}
const WHY = "The pull request already installs the merge bot as a GitHub App and drops the ruleset step, in src/bot.ts, so it meets the decision.";
const unmoved = { pull: () => ({ head: "h1", body: "" }) };

test("A11-305: a reviewed that pushed nothing and does not quote the new lines is refused, naming the instruction and the lines", () => {
  const dir = decisionsRound();
  const refused = stopVerdict(dir, { ...unmoved, lastMessage: "Checked the pull requests: no new feedback, nothing to change." });
  assert.equal(refused.code, 2);
  const said = refused.say.join("\n");
  assert.ok(said.includes(DECISIONS_CHANGED));
  assert.ok(said.includes(`> ${NEW_LINE}`), "the line the message left out is named");
});

test("A11-305: a reviewed that quotes the new lines and says why the pull requests meet them is allowed, from the final message or the outcome's own words", () => {
  const dir = decisionsRound();
  assert.equal(stopVerdict(dir, { ...unmoved, lastMessage: `> ${NEW_LINE.slice(2)}\n\n${WHY}` }).code, 0);
  const inFile = decisionsRound({ kind: "reviewed", reason: `${NEW_LINE.slice(2)}: ${WHY}` });
  assert.equal(stopVerdict(inFile, { ...unmoved, lastMessage: "Done." }).code, 0, "the outcome file's words count too");
});

test("A11-305: a quote with no reason is refused too", () => {
  const dir = decisionsRound();
  const refused = stopVerdict(dir, { ...unmoved, lastMessage: `> ${NEW_LINE.slice(2)}` });
  assert.equal(refused.code, 2);
  assert.match(refused.say.join("\n"), /does not say why the pull requests already meet them/);
});

test("A11-305: a push to any pull request answers the change, with no quote", () => {
  const other = "https://github.com/a11ign/auth-capture-check/pull/20";
  const dir = decisionsRound({ kind: "reviewed" }, { [URL]: "h1", [other]: "k1" });
  const heads: Record<string, string> = { [URL]: "h1", [other]: "k2" };
  assert.equal(stopVerdict(dir, { pull: (url) => ({ head: heads[url], body: "" }), lastMessage: "Pushed." }).code, 0);
});

test("A11-305: only reviewed is held to it, and a needs-human on the escalation list stands", () => {
  const stops = decisionsRound({ kind: "needs-human", reason: "the decision needs a new licence", escalation: "legal" });
  assert.equal(stopVerdict(stops, { ...unmoved, lastMessage: "Stopping." }).code, 0);
  const none = tmpDir("ticket-hook-decisions-none-");
  writeFileSync(join(none, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  assert.equal(stopVerdict(none, { pull: () => null, lastMessage: "Fine." }).code, 0, "a round with no change of the Decisions is judged as before");
});

test("A11-305: a pull request or a record the hook cannot read allows the stop out loud, and the refusal is bounded like every other", () => {
  const unread = decisionsRound();
  const allowed = stopVerdict(unread, { pull: () => null, lastMessage: "Fine." });
  assert.equal(allowed.code, 0);
  assert.match(allowed.say.join("\n"), /could not be read, so the Decisions round's answer was not checked and the stop is ALLOWED/);
  const noHead = decisionsRound({ kind: "reviewed" }, { [URL]: null });
  assert.match(stopVerdict(noHead, { ...unmoved, lastMessage: "Fine." }).say.join("\n"), /ALLOWED/);
  const broken = decisionsRound();
  writeFileSync(join(broken, DECISIONS_ROUND_FILE), "{");
  assert.match(stopVerdict(broken, { ...unmoved, lastMessage: "Fine." }).say.join("\n"), /cannot be read.*ALLOWED/);
  const stuck = decisionsRound();
  for (let n = 0; n < MAX_STOP_REFUSALS; n += 1) assert.equal(stopVerdict(stuck, { ...unmoved, lastMessage: "Nothing." }).code, 2);
  const last = stopVerdict(stuck, { ...unmoved, lastMessage: "Nothing." });
  assert.equal(last.code, 0, "past the count the stop is allowed");
  assert.match(last.say.join("\n"), /does not quote the new lines of the Decisions/);
});
