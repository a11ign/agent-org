// no-token: gh -- no `gh` call is made here; the reader is handed text, the raise is handed a roster and an order seam, and the one test that goes through `promptOrQueue` is handed a scratch queue
// a11ign/agent-org#463 (epic a11ign/a11ign#4437, class `tool-drift-interactive-prompt`): a pane that shows a menu or dialog is ordered to its owner on the first tick that sees it.
//
// WHAT THIS SHOWS, AND THE CONTROLS THAT MAKE IT MEAN SOMETHING. The positive case is the dialog `reviewer-lab-45` sat on, in the chairman's words. Every negative control is a
// screen a looser reader would call a dialog: an idle prompt, a numbered list in ordinary output, a code block, a working pane, and a dialog the output has moved past. A reader that
// never fires turns the positives red and one that always fires turns the negatives red; the mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOL_DRIFT_KIND } from "./agent-tool-update.ts";
import { parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { dialogOrder, dialogOwner, dialogSignature, raisePaneDialogs, readDialog, readRaised, writeRaised, type Memory } from "./pane-dialog.ts";
import { STANCE, EXIT, failureLedgerPath, orderClass, promptOrQueue } from "./prompt-session.ts";
import { isLimitMenu } from "./worker-state.ts";

/** The chairman's quoted question and three choices (a11ign/a11ign#4437, comment 6078759093), drawn the way Codex draws a selection: `› 1.` on the selected line and its key hint under. */
const REVIEWER_LAB_45 = [
  "",
  "  Background server has incompatible feature settings.",
  "  This session requires api_key_model_discovery to be disabled",
  "",
  "› 1. Run without daemon this time",
  "  2. Restart the shared daemon",
  "  3. Cancel",
  "",
  "  Press enter to confirm or esc to go back",
].join("\n");
const DAY = 24 * 3_600_000;
const REVIEWER_QUESTION = "Background server has incompatible feature settings. This session requires api_key_model_discovery to be disabled";

const CLAUDE_PERMISSION = [
  "● Bash(rm -rf build)",
  "╭──────────────────────────────────────────────╮",
  "│ Bash command                                 │",
  "│                                              │",
  "│ Do you want to proceed?                      │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and don't ask again for rm commands │",
  "│   3. No, and tell Claude what to do differently (esc) │",
  "╰──────────────────────────────────────────────╯",
].join("\n");

const CODEX_IDLE = "OpenAI Codex (v0.157.0)\n\n  Done: the change is in.\n\n› Ask Codex to do anything\n\n  ? for shortcuts";
const CLAUDE_IDLE = "● The change is in.\n\n╭────────────────────────────────╮\n│ > Try \"fix lint errors\"        │\n╰────────────────────────────────╯\n  ? for shortcuts";
const ORDINARY_LIST_THEN_PROMPT = "Here is the plan:\n\n  1. Install the package\n  2. Configure the daemon\n  3. Restart the reviewer\n\n› Ask Codex to do anything\n\n  ? for shortcuts";
const CODE_BLOCK = "Steps to reproduce:\n\n```\n1. Start the shared daemon\n2. Start a reviewer\n3. Read the pane\n```\n\nThat is all of it.";
const LIST_LAST_NO_SIGNATURE = "The three causes, in order:\n  1. The CLI is older than the daemon\n  2. The daemon updated itself\n  3. Feature defaults differ";
const WORKING = "Running the suite\n  1. parse passed\n  2. render passed\n\n• Working (12s • esc to interrupt)\n\n  gpt-5 high · 83% context left";
const WORKING_LAST = "Running the suite\n  1. parse passed\n  2. render passed\n  esc to interrupt";
const ANSWERED = `${REVIEWER_LAB_45}\n\n• Running without the daemon\n\n› Ask Codex to do anything\n\n  ? for shortcuts`;
/** The usage-limit menu (agent-org#1412, #1481): a representative reconstruction, not a capture. Both option lines are on screen, so `isLimitMenu` is true. */
const LIMIT_MENU = [
  "  You've hit your weekly limit · resets 7am (Europe/London)", "", "  What do you want to do?", "",
  "  ❯ 1. Stop and wait for limit to reset", "    2. Upgrade your plan", "    3. Switch to usage credits", "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// ---- THE READER -------------------------------------------------------------------------------------------------------------------------------------

test("(1) the reviewer-lab-45 dialog is detected, its question line is the chairman's quote and its three choices are the ones he named", () => {
  const dialog = readDialog(REVIEWER_LAB_45);
  assert.deepEqual(dialog, { question: REVIEWER_QUESTION, choices: ["Run without daemon this time", "Restart the shared daemon", "Cancel"] });
});

test("(1b) the same menu in the other shapes the org's TUIs draw: Claude's framed permission box, a hint with no selector, a selector with no numbers, colour codes", () => {
  assert.deepEqual(readDialog(CLAUDE_PERMISSION), { question: "Do you want to proceed?", choices: ["Yes", "Yes, and don't ask again for rm commands", "No, and tell Claude what to do differently (esc)"] });
  assert.deepEqual(readDialog("Update available! 0.162.1 -> 0.163.0\n\n  1. Update now\n  2. Skip\n\n  Press enter to continue"),
    { question: "Update available! 0.162.1 -> 0.163.0", choices: ["Update now", "Skip"] });
  assert.deepEqual(readDialog("Select a model\n\n❯ gpt-5-codex\n  gpt-5\n  o3\n\n  ↑/↓ to navigate · Enter to select"), { question: "Select a model", choices: ["gpt-5-codex", "gpt-5", "o3"] });
  assert.deepEqual(readDialog(`\x1b[1mBackground server has incompatible feature settings.\x1b[0m\n\n\x1b[36m› 1. Run without daemon this time\x1b[0m\n  2. Cancel\n`),
    { question: "Background server has incompatible feature settings.", choices: ["Run without daemon this time", "Cancel"] });
  assert.deepEqual(readDialog("Trust this folder?\n› 1. Yes, continue\n    and remember the choice\n  2. No, exit\n"),
    { question: "Trust this folder?", choices: ["Yes, continue and remember the choice", "No, exit"] }, "a wrapped option is one choice, not two");
});

test("(2) NEGATIVE CONTROLS: an idle prompt, a numbered list in ordinary output, a code block, a working pane and an answered dialog are none of them dialogs", () => {
  for (const [name, text] of Object.entries({
    "an idle Codex prompt": CODEX_IDLE,
    "an idle Claude prompt box": CLAUDE_IDLE,
    "a numbered list above the idle prompt": ORDINARY_LIST_THEN_PROMPT,
    "a numbered list inside a code block": CODE_BLOCK,
    "a numbered list as the last output, no selector and no hint": LIST_LAST_NO_SIGNATURE,
    "a pane mid-output, working, with a numbered list above the spinner": WORKING,
    "a numbered list whose last line is the working hint `esc to interrupt`": WORKING_LAST,
    "a dialog the output has moved past": ANSWERED,
    "an empty pane": "",
    "only blank lines": "\n\n   \n",
  })) assert.equal(readDialog(text), null, `${name} must not read as a dialog`);
  assert.equal(readDialog(null), null, "a pane that could not be read shows no dialog");
});

test("(2b) the controls are the right distance from the positive: take the signature away and the same list is not a dialog; put it back and it is", () => {
  const withoutSignature = "Background server has incompatible feature settings.\n\n  1. Run without daemon this time\n  2. Restart the shared daemon\n  3. Cancel\n";
  assert.equal(readDialog(withoutSignature), null);
  assert.notEqual(readDialog(`${withoutSignature}\n  Press enter to confirm or esc to go back`), null, "a key hint under it makes it a menu");
  assert.notEqual(readDialog(withoutSignature.replace("  1. Run", "› 1. Run")), null, "a selector on one option makes it a menu");
  assert.equal(readDialog("Which one?\n  1. Run without daemon this time\n› 3. Cancel"), null, "a list that does not count up from 1 is not read");
  assert.equal(readDialog("Which one?\n  2. Run without daemon this time\n› 3. Cancel"), null, "nor is the tail of a list that began above");
  assert.equal(readDialog("Which one?\n  1. Run without daemon this time\n  1. Restart the shared daemon\n› 3. Cancel"), null, "nor is a list that repeats a number to make up the count");
  assert.notEqual(readDialog("Which one?\n  1. Run without daemon this time\n› 2. Cancel"), null, "...and the same list counted properly is");
  assert.equal(readDialog("What now?\n› 1. Only option"), null, "one option is not a choice");
});

test("(2c) a dialog scrolled above ordinary output is not live, however much it looks like one", () => {
  assert.equal(readDialog(`${REVIEWER_LAB_45}\n\nThe reviewer is now running without the daemon.`), null);
  assert.notEqual(readDialog(`Earlier output\n${REVIEWER_LAB_45}`), null, "output ABOVE it is the ordinary case");
});

test("(3) the signature is the question and the choices, not the pane: another line elsewhere is the same dialog and another choice is not", () => {
  const same = dialogSignature(readDialog(REVIEWER_LAB_45)!);
  assert.equal(dialogSignature(readDialog(`gpt-5 · 83% left · 12:01:05\n${REVIEWER_LAB_45}`)!), same);
  assert.notEqual(dialogSignature(readDialog(REVIEWER_LAB_45.replace("3. Cancel", "3. Quit"))!), same);
});

// ---- THE OWNER --------------------------------------------------------------------------------------------------------------------------------------

test("(4) the owner is chosen per session kind: a reviewer or a worker is the first reader's, a standing seat is its own", () => {
  assert.equal(dialogOwner("reviewer-lab-45"), "product-manager");
  assert.equal(dialogOwner("reviewer-3"), "product-manager");
  assert.equal(dialogOwner("worker-agent-org-463"), "product-manager");
  assert.equal(dialogOwner("worker-4202"), "product-manager");
  for (const seat of ["ceo", "orchestrator", "liaison", "product-manager"]) assert.equal(dialogOwner(seat), seat);
});

test("(4b) the order quotes the question and the choices, names the pane, and tells a seat that owns its pane so instead of to message itself", () => {
  const dialog = readDialog(REVIEWER_LAB_45)!;
  const text = dialogOrder({ label: "reviewer-lab-45", owner: "product-manager", dialog });
  assert.match(text, new RegExp(`^Class: ${TOOL_DRIFT_KIND}\\n`));
  assert.ok(text.includes(`Question: ${REVIEWER_QUESTION}`));
  for (const [i, choice] of dialog.choices.entries()) assert.ok(text.includes(`  ${i + 1}. ${choice}`), choice);
  assert.ok(text.includes("agent read reviewer-lab-45"), "which pane");
  assert.ok(text.includes("Owner: you (product-manager)"));
  const own = dialogOrder({ label: "ceo", owner: "ceo", dialog });
  assert.ok(own.includes("your own pane") && !own.includes("Owner: you (ceo)"));
  assert.equal(orderClass(text), TOOL_DRIFT_KIND, "the line is the token `prompt:session` records the order under");
});

// ---- ONCE PER DIALOG --------------------------------------------------------------------------------------------------------------------------------

/** A herdr that shows each session the text a test sets, and an owner that takes or refuses what it is sent. */
function tick(panes: Record<string, string | null>, memory: Memory, { accept = true }: { accept?: boolean | ((owner: string) => boolean) } = {}) {
  const orders: { owner: string; text: string }[] = [];
  const said: string[] = [];
  const result = raisePaneDialogs({ roster: Object.keys(panes).map((label) => ({ label })), memory, read: (label) => panes[label], report: (line) => said.push(line),
    order: (owner, text) => {
      orders.push({ owner, text });
      const taken = typeof accept === "function" ? accept(owner) : accept;
      return taken;
    } });
  return { ...result, orders, said };
}

test("(5) the first tick that sees a dialog orders its owner; the second tick over the same text raises nothing; a changed text raises again", () => {
  const first = tick({ "reviewer-lab-45": REVIEWER_LAB_45, "worker-4202": WORKING, ceo: CODEX_IDLE }, {});
  assert.equal(first.orders.length, 1, "one dialog, one order, and the other two panes are none");
  assert.equal(first.orders[0].owner, "product-manager");
  assert.ok(first.orders[0].text.includes(REVIEWER_QUESTION));
  assert.deepEqual(first.sent.map((s) => s.label), ["reviewer-lab-45"]);

  const second = tick({ "reviewer-lab-45": REVIEWER_LAB_45, "worker-4202": WORKING, ceo: CODEX_IDLE }, first.raised);
  assert.equal(second.orders.length, 0, "the same text, the next tick: nothing");
  assert.deepEqual(second.raised, first.raised, "and it is still remembered, so the tick after is as quiet");

  const changed = tick({ "reviewer-lab-45": REVIEWER_LAB_45.replace("3. Cancel", "3. Quit") }, second.raised);
  assert.equal(changed.orders.length, 1, "a changed text is a new dialog");
  assert.ok(changed.orders[0].text.includes("3. Quit"));
});

test("(5b) a dialog answered and met again later is a new incident; a pane that could not be read is not an answer", () => {
  const raised = tick({ "reviewer-lab-45": REVIEWER_LAB_45 }, {}).raised;
  const unread = tick({ "reviewer-lab-45": null }, raised);
  assert.deepEqual(unread.unread, ["reviewer-lab-45"]);
  assert.equal(tick({ "reviewer-lab-45": REVIEWER_LAB_45 }, unread.raised).orders.length, 0, "an unread tick in between does not make the dialog new");

  const answered = tick({ "reviewer-lab-45": CODEX_IDLE }, unread.raised);
  assert.deepEqual(answered.raised, {}, "a pane that READS and shows no dialog is forgotten");
  assert.equal(tick({ "reviewer-lab-45": REVIEWER_LAB_45 }, answered.raised).orders.length, 1, "the same text again, after it was answered, is raised again");
});

test("(5c) an order that was not accepted is not remembered, so the next tick asks again; one that throws is the same, and is said", () => {
  const refused = tick({ "reviewer-lab-45": REVIEWER_LAB_45 }, {}, { accept: false });
  assert.deepEqual(refused.refused, ["reviewer-lab-45"]);
  assert.deepEqual(refused.raised, {});
  assert.equal(tick({ "reviewer-lab-45": REVIEWER_LAB_45 }, refused.raised).orders.length, 1);

  const said: string[] = [];
  const thrown = raisePaneDialogs({ roster: [{ label: "worker-1" }], memory: {}, read: () => REVIEWER_LAB_45, order: () => { throw new Error("herdr said no\nsecond line"); }, report: (line) => said.push(line) });
  assert.deepEqual(thrown.refused, ["worker-1"]);
  assert.deepEqual(thrown.raised, {});
  assert.equal(said.length, 1);
  assert.ok(said[0].includes("herdr said no") && !said[0].includes("second line"), said[0]);
});

test("(5d) a session that is no longer listed is forgotten, and each session is raised for its own dialog", () => {
  const both = tick({ "reviewer-lab-45": REVIEWER_LAB_45, "worker-agent-org-463": CLAUDE_PERMISSION }, {});
  assert.deepEqual(both.orders.map((o) => o.owner), ["product-manager", "product-manager"]);
  assert.ok(both.orders[0].text.includes("agent read reviewer-lab-45") && both.orders[1].text.includes("agent read worker-agent-org-463"));
  assert.deepEqual(Object.keys(tick({ "worker-agent-org-463": CLAUDE_PERMISSION }, both.raised).raised), ["worker-agent-org-463"]);
});

test("(5f) the usage-limit menu is not a decision order: a seat on it is ordered to nobody, and the dialog on the other seat is raised as before (agent-org#1481)", () => {
  assert.equal(isLimitMenu(LIMIT_MENU), true);
  assert.ok(readDialog(LIMIT_MENU) !== null, "the reader still reads it as a dialog: the exclusion is the raise's, not the reader's");
  const first = tick({ "worker-4202": LIMIT_MENU, "reviewer-lab-45": REVIEWER_LAB_45, ceo: CODEX_IDLE }, {});
  assert.equal(first.orders.length, 1, "one order, for the Codex dialog; the limit-menu seat and the plain pane are none");
  assert.equal(first.orders[0].owner, "product-manager");
  assert.ok(first.orders[0].text.includes(REVIEWER_QUESTION));
  assert.ok(!first.orders.some((o) => o.text.includes("Switch to usage credits")), "no order offers usage credits to a manager");
  assert.deepEqual(first.sent.map((s) => s.label), ["reviewer-lab-45"]);
  assert.deepEqual(first.refused, []);
  assert.deepEqual(Object.keys(first.raised), ["reviewer-lab-45"], "the limit-menu seat is remembered for nothing");
});

test("(5g) a seat that showed the usage-limit menu on one tick and a different dialog on the next raises on the next tick", () => {
  const menu = tick({ "worker-4202": LIMIT_MENU }, {});
  assert.equal(menu.orders.length, 0);
  assert.deepEqual(menu.raised, {});
  const next = tick({ "worker-4202": REVIEWER_LAB_45 }, menu.raised);
  assert.equal(next.orders.length, 1, "a dialog after the menu is a new incident");
  assert.ok(next.orders[0].text.includes(REVIEWER_QUESTION));
});

test("(5e) the memory is a file:an absent or damaged one is `nothing raised`, and one that did not change is not rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-dialog-"));
  try {
    const path = join(dir, "state", "pane-dialog-raised.json");
    assert.deepEqual(readRaised(path), {});
    writeRaised(path, {}, { "reviewer-lab-45": "abc123" });
    assert.deepEqual(readRaised(path), { "reviewer-lab-45": "abc123" });
    assert.equal(existsSync(`${path}.tmp`), false, "written by rename");
    writeRaised(path, { "reviewer-lab-45": "abc123" }, { "reviewer-lab-45": "abc123" });
    assert.equal(readFileSync(path, "utf8"), '{"reviewer-lab-45":"abc123"}\n');
    assert.deepEqual(readRaised(join(dir, "missing.json"), () => "{not json"), {});
    assert.deepEqual(readRaised(path, () => '["a"]'), {}, "an array is not a memory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- THE INCIDENT IS RECORDED -----------------------------------------------------------------------------------------------------------------------

test("(6) an accepted order is recorded in the failure ledger under `tool-drift-interactive-prompt`, once per dialog, so a second dialog is a counted repeat and a quiet tick adds none", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-dialog-"));
  const queue = join(dir, "handoffs.jsonl");
  const ledger = failureLedgerPath(queue);
  const reported: string[] = [];
  // `product-manager` is working, so the order is QUEUED for it: no prompt is typed and no transcript is read, and the record is the one `promptOrQueue` makes of an order it accepted.
  const roster = [{ label: "product-manager", status: "working" }, { label: "reviewer-lab-45", status: "blocked" }, { label: "worker-4202", status: "blocked" }];
  const order = (owner: string, text: string): boolean => {
    const code = promptOrQueue({ run: () => { throw new Error("nothing may be typed"); }, label: owner, text, agents: roster, path: queue, stance: STANCE.DECISION, sender: "work-tick",
      ledger: { report: (line) => reported.push(line) } });
    return code === EXIT.OK || code === EXIT.QUEUED;
  };
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const panes = { "reviewer-lab-45": REVIEWER_LAB_45, "worker-4202": WORKING };
    const first = raisePaneDialogs({ roster, memory: {}, read: (label) => (panes as Record<string, string>)[label] ?? null, order });
    assert.deepEqual(first.sent.map((s) => s.label), ["reviewer-lab-45"]);
    const second = raisePaneDialogs({ roster, memory: first.raised, read: (label) => (panes as Record<string, string>)[label] ?? null, order });
    assert.equal(second.sent.length, 0);

    const entries = parseFailureLedger(readFileSync(ledger, "utf8"));
    assert.deepEqual(entries.map((e) => e.classKey), [TOOL_DRIFT_KIND], "one line of the kind, and no `unclassified` order beside it");
    assert.ok(entries[0].ref.startsWith("product-manager/"), entries[0].ref);
    assert.ok(readFileSync(queue, "utf8").includes(REVIEWER_QUESTION), "and the order is on the queue the gate delivers from");
    assert.deepEqual(repeatsIn(entries, { windowMs: DAY }), [], "one incident is not a repeat");

    const third = raisePaneDialogs({ roster, memory: second.raised, order,
      read: (label) => (label === "worker-4202" ? CLAUDE_PERMISSION : (panes as Record<string, string>)[label] ?? null) });
    assert.deepEqual(third.sent.map((s) => s.label), ["worker-4202"]);
    const after = parseFailureLedger(readFileSync(ledger, "utf8"));
    assert.equal(after.filter((e) => e.classKey === TOOL_DRIFT_KIND).length, 2, "a second dialog is a second line of the kind");
    assert.equal(after.filter((e) => e.classKey !== TOOL_DRIFT_KIND).length, 0);
    assert.deepEqual(repeatsIn(after, { windowMs: DAY }).map((r) => r.classKey), [TOOL_DRIFT_KIND], "and the kind now reads as a repeat");
    assert.deepEqual(reported, []);
  } finally {
    process.stderr.write = stderr;
    rmSync(dir, { recursive: true, force: true });
  }
});
