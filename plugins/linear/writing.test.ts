// no-token: none -- pure builders over the manifest's writer tooling
//
// WHAT A NEW-TICKET RUN IS TOLD AND ALLOWED WITH LINEAR (A11-135, moved by A11-159): the writer's brief names Linear's tools and priority numbers, the PostToolUse hook is matched on
// Linear's create tool, and a creation's key is read back from the answers Linear's own MCP gives. These ran on constants in core; they run here on the plugin's manifest, so the
// move changes none of the words a writer run is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCatalog, pluginNamed, trackerWritingOf } from "../../src/plugins/registry.ts";
import { resolveProviders } from "../../src/ticket-mode/providers.ts";
import { workerSettings, writerBriefText, writerTools } from "../../src/ticket-mode/worker-files.ts";
import { createdKeyOf } from "../../src/ticket-mode/writer.ts";

const WRITING = trackerWritingOf(resolveProviders({ tickets: {} }));
const brief = (over: Partial<Parameters<typeof writerBriefText>[0]> = {}) => writerBriefText({ run: "Run the a11ign:create-ticket skill for this request: {request}.", request: "x", mode: "quick", placement: "auto", form: {}, clones: {}, dir: "/d", pickTeam: "A11", writing: WRITING, ...over });

test("a host that names no tracker runs Linear's writing, which is the manifest's", () => {
  assert.equal(WRITING, pluginNamed(defaultCatalog(), "linear")?.tooling.writer);
});

test("the brief names Linear's create tool and its two attachment tools, which tools to prefer, and what is read with its read-only tools", () => {
  const text = brief();
  assert.match(text, /- \*\*Tracker tools:\*\* create the ticket with `mcp__linear__save_issue`, with no `id`\. Attach files with `mcp__linear__prepare_attachment_upload` and `mcp__linear__create_attachment_from_upload`, naming only a ticket this run created\. Use the `mcp__linear__` tools, not the claude\.ai Linear ones\./);
  assert.match(text, /with the read-only Linear tools \(`get`, `list`, `search`, `extract`\)/);
});

test("the brief gives Linear's number for each priority the form names, 0 being none", () => {
  const priority = (name: string) => brief({ placement: "manual", form: { priority: name as "high" } });
  for (const [name, number] of [["urgent", 1], ["high", 2], ["medium", 3], ["low", 4], ["none", 0]] as const) {
    assert.match(priority(name), new RegExp(`- Priority: ${name}, number ${number} \\(the ticket's priority number\\)`), name);
  }
});

test("the board grants a new-ticket run Linear's create tool and its two attachment tools, and the hook records a creation by the create tool", () => {
  assert.deepEqual(writerTools(WRITING), ["mcp__linear__save_issue", "mcp__linear__prepare_attachment_upload", "mcp__linear__create_attachment_from_upload"]);
  const base = { model: "opus", ticketDir: "/d", readDirs: [], hook: { node: "/usr/bin/node", bin: "/tool/src/bin.ts" } };
  assert.equal((workerSettings({ ...base, writer: WRITING }) as { hooks: { PostToolUse: { matcher: string }[] } }).hooks.PostToolUse[0].matcher, "mcp__linear__save_issue");
  assert.equal((workerSettings(base) as { hooks: { PostToolUse: { matcher: string }[] } }).hooks.PostToolUse[0].matcher, "Bash", "a build worker records no ticket: its hook is matched on Bash, for the pull request a command opens (A11-358)");
});

test("a creation's key is read from the result Linear's MCP returned, in any of its shapes: `identifier`, else `id` when that is a key, under `issue` or not", () => {
  const keyOf = (response: unknown) => createdKeyOf(response, WRITING.createdKey);
  assert.equal(keyOf({ identifier: "A11-140", title: "x" }), "A11-140");
  assert.equal(keyOf({ id: "A11-135", title: "x", url: "https://linear.app/x" }), "A11-135", "Linear's own MCP answers with the key as `id`, as its get_issue does");
  assert.equal(keyOf([{ type: "text", text: JSON.stringify({ issue: { identifier: "A11-141" } }) }]), "A11-141");
  assert.equal(keyOf({ content: [{ type: "text", text: JSON.stringify({ id: "A11-142" }) }] }), "A11-142");
  assert.equal(keyOf(JSON.stringify({ identifier: "A11-143" })), "A11-143");
  assert.equal(keyOf({ content: [{ type: "text", text: "Created the issue." }] }), null);
  assert.equal(keyOf({ id: "7d1c5e2a-0000-4000-8000-000000000001" }), null, "a UUID is no ticket key");
  assert.equal(keyOf(undefined), null);
});
