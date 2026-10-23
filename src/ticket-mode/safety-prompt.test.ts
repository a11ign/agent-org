// no-token: gh -- pure reader, handed pane text
// A11-174: what a running agent's pane shows when Claude Code stops to ask a person, and the one message that tells the agent its prompt was answered No.
//
// The panes are in `safety-prompt-fixture.ts`, reconstructions and not captures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { declineMessage, readSafetyPrompt } from "./safety-prompt.ts";
import { ASK_USER, BOX, DANGEROUS_RM, DANGEROUS_RM_CLOSE, EDIT, IDLE, IMPORTS, MOVED_PAST, TRUST, WORKING } from "./safety-prompt-fixture.ts";

test("A11-174: the dangerous-rm pane reads as a safety prompt, with its command and its warning", () => {
  assert.deepEqual(readSafetyPrompt(DANGEROUS_RM), {
    kind: "safety", command: "rm -f $SC/*.done Remove the done markers", warning: "Dangerous rm operation on possibly-empty variable path", firstLine: "Do you want to proceed?",
  });
});

test("A11-174: a warning drawn directly above the question is still the warning, and the prompt is still a safety prompt", () => {
  assert.deepEqual(readSafetyPrompt(DANGEROUS_RM_CLOSE), {
    kind: "safety", command: "rm -f $SC/*.done", warning: "Dangerous rm operation on possibly-empty variable path", firstLine: "Dangerous rm operation on possibly-empty variable path",
  });
});

test("A11-174: an edit confirmation is a safety prompt too, with no warning", () => {
  assert.deepEqual(readSafetyPrompt(EDIT), { kind: "safety", command: "src/app.ts", warning: "", firstLine: "Do you want to make this edit to app.ts?" });
});

test("A11-174: a command is cut to 200 characters", () => {
  const long = BOX("Bash command", "", `  echo ${"x".repeat(300)}`, "", "Do you want to proceed?", "❯ 1. Yes", "  2. No (esc)");
  const prompt = readSafetyPrompt(long);
  assert.equal(prompt?.kind === "safety" && prompt.command.length, 200);
});

test("A11-174: NEGATIVE CONTROLS: a dialog that is not Claude Code's permission prompt is unrecognised, with its first line, and anything that is not a dialog is null", () => {
  for (const [name, pane, firstLine] of [
    ["the external CLAUDE.md imports dialog", IMPORTS, "This project's CLAUDE.md imports files outside the current working directory."],
    ["the folder-trust dialog", TRUST, "Quick safety check: Is this a project you created or one you trust? (Like your own code, a"],
    ["a question menu", ASK_USER, "Which database should the migration use?"],
  ] as const) {
    assert.deepEqual(readSafetyPrompt(pane), { kind: "unrecognised", firstLine }, `${name} is left for a person`);
  }
  for (const [name, pane] of [["an idle prompt", IDLE], ["a working pane", WORKING], ["a dialog the output has moved past", MOVED_PAST], ["an empty pane", ""], ["a pane that could not be read", null]] as const) {
    assert.equal(readSafetyPrompt(pane), null, `${name} shows no dialog`);
  }
});

test("A11-174: a first line is cut to 120 characters", () => {
  const prompt = readSafetyPrompt(BOX("x".repeat(200), "❯ 1. Yes", "  2. No"));
  assert.equal(prompt?.kind, "unrecognised");
  assert.equal(prompt?.firstLine.length, 120);
});

test("A11-174: the message names the command and the warning, and says to guard variable paths for the empty-variable warning", () => {
  const message = declineMessage({ command: "rm -f $SC/*.done", warning: "Dangerous rm operation on possibly-empty variable path" });
  assert.equal(message, 'The board answered No to a Claude Code safety prompt on your command `rm -f $SC/*.done`: "Dangerous rm operation on possibly-empty variable path". '
    + 'Nobody answers prompts on an unattended run. Guard variable paths with ${VAR:?}, for example rm -rf "${DIR:?}/x", run it again that way, and carry on.');
});

test("A11-174: any other safety prompt is told to do it another way, with no guard advice, and a prompt with no warning quotes none", () => {
  const message = declineMessage({ command: "src/app.ts", warning: "" });
  assert.equal(message, "The board answered No to a Claude Code safety prompt on your command `src/app.ts`. Nobody answers prompts on an unattended run. Do it another way that raises no prompt, and carry on.");
  assert.ok(!declineMessage({ command: "curl x", warning: "Some other warning" }).includes("${VAR:?}"));
});
