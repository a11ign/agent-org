import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePaths } from "./overlap.ts";

test("A11-82: a plan's ## Paths section lists its repository-prefixed paths, bullets only, in order, each once", () => {
  const plan = [
    "# Plan",
    "",
    "## Approach",
    "- `nbl-ui-netbox:src/not/a/path.ts` is in the approach, not the section",
    "",
    "## Paths",
    "- `agent-org:src/ticket-mode/pool.ts`",
    "* `agent-org:src/ticket-mode/`",
    "- `agent-org:src/ticket-mode/pool.ts` again",
    "- `nbl-ui-netbox:docs/guide.md` the guide, with a note after it",
    "  - `agent-org:src/ticket-port/` indented, which is still a bullet",
  ].join("\n");
  assert.deepEqual(parsePaths(plan), ["agent-org:src/ticket-mode/pool.ts", "agent-org:src/ticket-mode/", "nbl-ui-netbox:docs/guide.md", "agent-org:src/ticket-port/"]);
});

test("A11-82: the section ends at the next heading, and a plan without the section declares no paths", () => {
  assert.deepEqual(parsePaths("## Paths\n- `agent-org:a.ts`\n### Notes\n- `agent-org:b.ts`\n"), ["agent-org:a.ts"]);
  assert.deepEqual(parsePaths("# Plan\n- `agent-org:a.ts`\n"), [], "a bullet outside the section is not a path");
  assert.deepEqual(parsePaths(""), []);
});

test("A11-82: a line that is no `repo:path` bullet is nothing: plain text, a bullet without backticks, a bullet with no path, and a bare path", () => {
  assert.deepEqual(parsePaths([
    "## Paths",
    "agent-org:src/a.ts",
    "- src/b.ts",
    "- `src/c.ts`",
    "- `agent-org:`",
    "- `:src/d.ts`",
    "- `agent-org:src/e.ts with a space`",
    "- `agent-org:src/f.ts`",
  ].join("\n")), ["agent-org:src/f.ts"]);
});

test("A11-82: a plan with CRLF line endings reads the same", () => {
  assert.deepEqual(parsePaths("## Paths\r\n- `agent-org:src/a.ts`\r\n- `agent-org:src/b/`\r\n"), ["agent-org:src/a.ts", "agent-org:src/b/"]);
});
