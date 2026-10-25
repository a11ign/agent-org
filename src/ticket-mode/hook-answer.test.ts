// no-token: gh -- the hook decides on text; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolVerdict } from "./hook.ts";
import { boardKeyPath } from "./board-key.ts";

const KEY_PATH = boardKeyPath("/home/agent/.local/state/agent-org");
const bash = (command: string) => toolVerdict("Bash", { command }).code;

test("A11-250: a run may not name the board's key file in a command, so it cannot call the board's API as the person", () => {
  for (const refused of [`cat ${KEY_PATH}`, "cat ~/.local/state/agent-org/tickets/board.key", `curl -H "x-ticket-token: $(cat tickets/board.key)" http://127.0.0.1:7317/api/queue`, "KEY=$(< board.key)", "head -c 5 'board.key'"]) {
    assert.equal(bash(refused), 2, refused);
  }
  assert.match(toolVerdict("Bash", { command: `cat ${KEY_PATH}` }).say.join("\n"), /the board's key \(board\.key\) is the person's/);
  for (const allowed of ["cat README.md", "ls tickets", "grep -rn keyboard src", "cat board.keys.md", "git log --oneline", "echo dashboard.key.md"]) {
    assert.equal(bash(allowed), 0, `POSITIVE CONTROL: ${allowed}`);
  }
});

test("A11-250: a run may not name a queue action route, the answer route above all", () => {
  for (const refused of [
    `curl -X POST -d '{"answer":"yes"}' http://127.0.0.1:7317/api/queue/A11-1/answer`,
    "curl -X POST http://127.0.0.1:7317/api/queue/A11-1/respond",
    "wget --post-data='' localhost:7317/api/queue/NBF-9/retry",
    "node -e \"fetch('/api/queue/A11-250/answer')\"",
  ]) {
    assert.equal(bash(refused), 2, refused);
  }
  assert.match(toolVerdict("Bash", { command: "curl http://127.0.0.1:7317/api/queue/A11-1/answer" }).say.join("\n"), /the answer route alone writes a ticket's Decisions/);
  for (const allowed of ["curl https://api.github.com/repos/a11ign/agent-org/pulls", "curl http://127.0.0.1:3000/api/queue", "echo /api/queue", "gh api repos/a11ign/agent-org/issues"]) {
    assert.equal(bash(allowed), 0, `POSITIVE CONTROL: ${allowed}`);
  }
});

test("A11-250: a run may not open the key with a file tool either, Read included", () => {
  for (const [tool, input] of [
    ["Read", { file_path: KEY_PATH }],
    ["Write", { file_path: KEY_PATH, content: "x" }],
    ["Edit", { file_path: KEY_PATH }],
    ["MultiEdit", { file_path: KEY_PATH }],
    ["NotebookEdit", { notebook_path: KEY_PATH }],
    ["Grep", { pattern: ".", path: KEY_PATH }],
  ] as const) {
    assert.equal(toolVerdict(tool, input).code, 2, tool);
  }
  for (const [tool, input] of [
    ["Read", { file_path: "/home/agent/repos/x/README.md" }],
    ["Read", { file_path: "/home/agent/.local/state/agent-org/tickets/board.keys.md" }],
    ["Grep", { pattern: "key", path: "/home/agent/repos/x/src" }],
    ["Edit", { file_path: "/home/agent/repos/x/src/a.ts" }],
  ] as const) {
    assert.equal(toolVerdict(tool, input).code, 0, `POSITIVE CONTROL: ${tool} ${JSON.stringify(input)}`);
  }
});
