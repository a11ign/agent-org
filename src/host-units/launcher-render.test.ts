// no-token: none -- the launcher is rendered from the shipped template into text; nothing is installed, and the only files are in a temporary home
/**
 * AN ORG HOST'S `agent-org` LAUNCHER RUNS THE INSTALLED TOOL (A11-285).
 *
 * host.json's `tool` is a checkout that `update-tool` moves, while every unit runs `<agent-org home>/tool/current`. A launcher rendered with the checkout was a second version of the tool on every
 * agent's PATH, and the doctor's `agent-org command` row would fail on that host for good. So `@@tool@@` renders as `current` when this machine has one, and as host.json's `tool` when it has not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import "../packaging/host-units-project.ts"; // FIRST of the tool imports: it makes a fixture project the tool's before `host-units.ts` resolves one (#3233)

const { shippedScriptText } = await import("./shipped-unit-texts-and-declarations.ts");
const { homeHostConfig } = await import("../host-config.ts");

/** The launcher's text for a host whose home is `home` and whose `tool` is `checkout`, with no `AGENT_ORG_HOME`, so the install is `<home>/.agent-org`. */
const rendered = (home: string, checkout: string): string | null => shippedScriptText("agent-org", { host: { ...homeHostConfig(), home, tool: checkout }, env: {} } as never);

test("@@tool@@ renders as the current link when this machine has an installed tool", () => {
  const home = tmpDir("launcher-render-");
  const current = join(home, ".agent-org", "tool", "current");
  mkdirSync(join(home, ".agent-org", "tool", "versions", "v0.306.0", "src"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "tool", "versions", "v0.306.0", "src", "bin.ts"), "");
  symlinkSync("versions/v0.306.0", current);
  const text = rendered(home, "/home/agent/repos/agent-org");
  assert.ok(text?.includes(`exec node "${current}/src/bin.ts" "$@"`), text ?? "no text");
  assert.ok(!text?.includes("/home/agent/repos/agent-org"), "the checkout is not what it runs");
});

test("@@tool@@ renders as host.json's tool when there is no installed tool, as it always did", () => {
  const home = tmpDir("launcher-render-");
  const text = rendered(home, "/home/agent/repos/agent-org");
  assert.ok(text?.includes('exec node "/home/agent/repos/agent-org/src/bin.ts" "$@"'), text ?? "no text");
  assert.ok(!text?.includes(`${home}/.agent-org/tool/current`));
});
