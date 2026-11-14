// no-token: gh -- pure parsing of captured text; nothing is read from the host
// A11-434: every captured sample of Claude Code's allowance message is recognised, with its reset time; text that only quotes it is not
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLimitMessage, lastSaidInTail, limitResetAt, spentIn, spentOnPane } from "./account-limit-message.ts";

/**
 * A transcript entry as Claude Code 2.1.296 wrote it on the host, 2026-10-13T20:40:20Z (`isApiErrorMessage`, `error: "rate_limit"`), cut to the fields that
 * matter here. Captured; the session's other fields are left out.
 */
const TRANSCRIPT_2_1_296 = JSON.stringify({
  type: "assistant", isSidechain: false, timestamp: "2026-10-13T20:40:20.028Z", version: "2.1.296", isApiErrorMessage: true, error: "rate_limit",
  message: { model: "<synthetic>", role: "assistant", type: "message", content: [{ type: "text", text: "You've hit your weekly limit · resets Oct 15, 8am (Europe/London)" }] },
});

/** A worker's pane as Claude Code 2.1.299 drew it on the host on 2026-10-13 at 21:37 London: the reply glyph, a no-break space, and the limit menu. Captured. */
const PANE_2_1_299 = [
  "  Ran 25 shell commands",
  "  ⎿  You've hit your weekly limit · resets Oct 15, 8am (Europe/London)",
  "",
  "✻ Cooked for 2m 56s · done Tuesday 21:37",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Wait here, then continue automatically shortly",
  "     3. Switch to usage credits",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

/** The short form, measured in the host's transcripts for agent-org#2256 (494 lines); the entries themselves were not kept. */
const SHORT_FORM = "You've hit your weekly limit · resets 8am (Europe/London)";

const at = (iso: string): number => Date.parse(iso);

test("A11-434: the transcript sample of Claude Code 2.1.296 is the session's last reply, recognised, with its reset at 8am London on 15 Oct", () => {
  const said = lastSaidInTail(`{"cut line\n${TRANSCRIPT_2_1_296}\n`);
  assert.deepEqual(said, { role: "assistant", text: "You've hit your weekly limit · resets Oct 15, 8am (Europe/London)", at: at("2026-10-13T20:40:20.028Z") });
  assert.deepEqual(spentIn(said!), { text: said!.text, until: at("2026-10-15T07:00:00Z") });
});

test("A11-434: the pane sample of Claude Code 2.1.299 is recognised on its own line, behind the reply glyph and a no-break space, with the same reset", () => {
  const spent = spentOnPane(PANE_2_1_299, at("2026-10-13T20:41:00Z"));
  assert.deepEqual(spent, { text: "You've hit your weekly limit · resets Oct 15, 8am (Europe/London)", until: at("2026-10-15T07:00:00Z") });
});

test("A11-434: the measured short form is recognised, its reset the next 8am London after it was written", () => {
  assert.equal(isLimitMessage(SHORT_FORM), true);
  assert.equal(limitResetAt(SHORT_FORM, at("2026-11-13T20:00:00Z")), at("2026-11-14T08:00:00Z"));
});

test("A11-434: a qualifier and a separator not seen yet are read the same way; a reset that cannot be read holds an hour from when it was said", () => {
  assert.equal(limitResetAt("You've hit your 5-hour limit ∙ resets 2pm (UTC)", at("2026-11-13T12:00:00Z")), at("2026-11-13T14:00:00Z"));
  assert.deepEqual(spentIn({ text: "You've hit your session limit · resets 2pm (Mars/Olympus)", at: at("2026-11-13T12:00:00Z") }),
    { text: "You've hit your session limit · resets 2pm (Mars/Olympus)", until: at("2026-11-13T13:00:00Z") });
});

test("A11-434: text that quotes the message is not the message: a paragraph, a line of code on a pane, the clause alone", () => {
  assert.equal(isLimitMessage(`The worker said "${SHORT_FORM}" and stopped.`), false);
  assert.equal(spentOnPane(`  const SAID = "${SHORT_FORM}";`, 0), null);
  assert.equal(spentIn({ text: "resets 8am (Europe/London)", at: 0 }), null);
});
