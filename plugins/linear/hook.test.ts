// no-token: gh -- the hook decides on text; no process runs and nothing reaches Linear
//
// The Linear plugin's side of the new-ticket run (A11-135): the hook refuses and grants the tools the plugin's manifest names (`agentOrg.tooling.writer`), and records a creation by the
// shape of Linear's answer. Core's own hook tests run the same cases on the fake tracker (`src/ticket-mode/hook.test.ts`); these are the ones that name Linear's tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { main, toolVerdict, writerGrants } from "../../src/ticket-mode/hook.ts";
import { CREATED_FILE } from "../../src/ticket-mode/writer.ts";

const bash = (command: string) => toolVerdict("Bash", { command }).code;
const LINEAR_READS = [/^mcp__claude_ai_Linear__(get|list|search|extract)_/];

test("A11-94: a new-ticket run may read the tracker through the allowed connectors, and may create nothing, whatever its connectors allow", () => {
  const writer = (tool: string) => toolVerdict(tool, {}, { writer: true, connectors: [LINEAR_READS[0], /^mcp__claude_ai_Linear__save_issue$/] }).code;
  assert.equal(writer("mcp__claude_ai_Linear__get_issue"), 0, "POSITIVE CONTROL: a read the connectors allow");
  assert.equal(writer("mcp__claude_ai_Linear__list_issues"), 0);
  assert.equal(writer("mcp__claude_ai_Linear__save_issue"), 2, "a create the connectors name is still refused: the name is a read");
  assert.equal(writer("mcp__claude_ai_Linear__save_comment"), 2);
  assert.equal(writer("mcp__plugin_slack_slack__slack_send_message"), 2, "a connector the machine does not allow");
  assert.equal(toolVerdict("mcp__claude_ai_Linear__get_issue", {}, { connectors: LINEAR_READS }).code, 0, "a worker keeps its reads as before");
});

test("A11-94: the new-ticket mark is the board's to write, and a new-ticket run reads its own mark through the hook", () => {
  const dir = tmpDir("ticket-hook-writer-");
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  writeFileSync(join(dir, "connectors.json"), `${JSON.stringify(LINEAR_READS.map((pattern) => pattern.source))}\n`);
  assert.equal(call("mcp__claude_ai_Linear__save_issue"), 2, "no mark: a worker's connectors are as before, and this one is not named");
  assert.equal(call("mcp__claude_ai_Linear__get_issue"), 0, "no mark: a worker reads as before");
  writeFileSync(join(dir, "writer-run"), "{}\n");
  assert.equal(call("mcp__claude_ai_Linear__get_issue"), 0);
  assert.equal(call("mcp__claude_ai_Linear__save_issue"), 2);
  assert.equal(call("Write", { file_path: join(dir, "writer-run") }), 2, "a worker may not write the mark");
  assert.equal(bash(`echo '{}' > ${dir}/writer-run`), 2);
});

const CREATE = "mcp__linear__save_issue";
const UPLOAD = "mcp__linear__prepare_attachment_upload";
const ATTACH = "mcp__linear__create_attachment_from_upload";

test("A11-135: a build worker is refused every filing tool by name, and the refusal names New ticket, even where its connectors allow the whole server", () => {
  for (const tool of [CREATE, UPLOAD, ATTACH, "mcp__linear__create_attachment", "mcp__claude_ai_Linear__save_issue", "mcp__claude_ai_Linear__create_attachment_from_upload"]) {
    const verdict = toolVerdict(tool, {}, { connectors: [/^mcp__linear__/, /^mcp__claude_ai_Linear__/] });
    assert.equal(verdict.code, 2, tool);
    assert.match(verdict.say[0], /workers file no tickets.*use New ticket on the board/, tool);
  }
  assert.equal(toolVerdict("mcp__linear__save_comment", {}, { connectors: [/^mcp__linear__/] }).code, 0, "a comment is still a worker's to write");
});

const GRANTED: { writer: boolean; grants: string[]; created: string[] | null } = { writer: true, grants: [CREATE, UPLOAD, ATTACH], created: ["A11-140"] };

test("A11-135: a new-ticket run may create a ticket with no id and no blocks, and attach a plan only to a ticket it created", () => {
  const verdict = (tool: string, input: Record<string, unknown>, over: Partial<typeof GRANTED> = {}) => toolVerdict(tool, input, { ...GRANTED, ...over }).code;
  assert.equal(verdict(CREATE, { title: "x", team: "A11", parentId: "A11-12", relatedTo: ["A11-9"], blockedBy: ["A11-8"] }), 0, "POSITIVE CONTROL: a creation with its relations to the new ticket");
  assert.equal(verdict(UPLOAD, { issue: "A11-140", filename: "0001-plan-x.md" }), 0);
  assert.equal(verdict(ATTACH, { issue: "A11-140", assetUrl: "https://uploads.linear.app/x", title: "A11-140-0001-plan-x.md" }), 0);
  assert.match(toolVerdict(CREATE, { id: "A11-9", title: "x" }, GRANTED).say[0], /updates an existing ticket/, "an id is an update");
  assert.equal(verdict(CREATE, { id: "7d1c5e2a-0000-4000-8000-000000000001", title: "x" }), 2, "a UUID id is an update too");
  assert.match(toolVerdict(CREATE, { title: "x", blocks: ["A11-3"] }, GRANTED).say[0], /writes a relation on another ticket/);
  assert.equal(verdict(UPLOAD, { issue: "A11-3", filename: "x.md" }), 2, "an attachment to a ticket this run did not create");
  assert.equal(verdict(CREATE, { title: "x" }, { created: Array.from({ length: 10 }, (_, i) => `A11-${i + 1}`) }), 2, "an eleventh creation");
  assert.equal(verdict(CREATE, { title: "x" }, { created: null }), 2, "a record that cannot be read refuses a creation");
  assert.equal(verdict(UPLOAD, { issue: "A11-140" }, { created: null }), 2, "and an attachment");
  assert.equal(toolVerdict("mcp__linear__save_comment", {}, GRANTED).code, 2, "every other write stays refused");
  assert.equal(toolVerdict("mcp__linear__delete_attachment", { id: "x" }, GRANTED).code, 2);
  assert.equal(verdict("mcp__linear__create_attachment", { issue: "A11-140" }), 2, "the plain attachment creator is not granted");
  assert.equal(verdict("mcp__claude_ai_Linear__save_issue", { title: "x" }), 2, "the person's connector is not granted");
});

test("A11-135: the mark grants only the filing tools it names that the hook knows", () => {
  const dir = tmpDir("ticket-hook-grant-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE, "mcp__linear__delete_issue", ATTACH] }));
  assert.deepEqual(writerGrants(dir), [CREATE, ATTACH]);
  assert.deepEqual(writerGrants(tmpDir("ticket-hook-grant-none-")), [], "no mark, no grant");
  assert.deepEqual(writerGrants(dir, () => "{not json"), [], "a mark it cannot read grants nothing");
});

test("A11-135: each creation is recorded as its result returns, by the hook alone, and a result with no key is refused out loud", () => {
  const dir = tmpDir("ticket-hook-record-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE] }));
  const found = [{ type: "text", text: JSON.stringify({ id: "A11-140", title: "x" }) }];
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: found }), ["post-tool-use", dir]).code, 0);
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: { identifier: "A11-141" } }), ["post-tool-use", dir]).code, 0);
  assert.equal(readFileSync(join(dir, CREATED_FILE), "utf8"), '{"identifier":"A11-140"}\n{"identifier":"A11-141"}\n');
  const unkeyed = main(JSON.stringify({ tool_name: CREATE, tool_response: "Created the issue." }), ["post-tool-use", dir]);
  assert.equal(unkeyed.code, 2);
  assert.match(unkeyed.say[0], /not in the result, so it is not recorded/);
  assert.equal(main(JSON.stringify({ tool_name: "Bash", tool_response: "" }), ["post-tool-use", dir]).code, 0, "another call is not a creation");
  const worker = tmpDir("ticket-hook-record-worker-");
  assert.equal(main(JSON.stringify({ tool_name: CREATE, tool_response: found }), ["post-tool-use", worker]).code, 0);
  assert.equal(existsSync(join(worker, CREATED_FILE)), false, "a run that is not a new-ticket run records nothing");
});

test("A11-135: the record counts a run's creations, fails closed when it cannot be read, and is the board's own file", () => {
  const dir = tmpDir("ticket-hook-count-");
  writeFileSync(join(dir, "writer-run"), JSON.stringify({ mode: "quick", tools: [CREATE, UPLOAD, ATTACH] }));
  writeFileSync(join(dir, CREATED_FILE), `${Array.from({ length: 10 }, (_, i) => `{"identifier":"A11-${i + 1}"}`).join("\n")}\n`);
  const pre = (tool_name: string, tool_input: Record<string, unknown>) => main(JSON.stringify({ tool_name, tool_input }), ["pre-tool-use", dir]).code;
  assert.equal(pre(CREATE, { title: "x" }), 2, "the eleventh creation");
  assert.equal(pre(UPLOAD, { issue: "A11-10", filename: "x.md" }), 0, "an attachment to the tenth");
  assert.equal(pre(UPLOAD, { issue: "A11-11", filename: "x.md" }), 2, "an attachment to a ticket past the record");
  assert.equal(pre("Write", { file_path: join(dir, CREATED_FILE) }), 2, "a worker may not write the record");
  assert.equal(pre("Bash", { command: `echo '{}' >> ${dir}/${CREATED_FILE}` }), 2, "nor append to it");
  writeFileSync(join(dir, CREATED_FILE), "garbage\n");
  assert.equal(pre(UPLOAD, { issue: "A11-10", filename: "x.md" }), 2, "a record that cannot be read refuses the attachment");
});
