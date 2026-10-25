// no-token: none -- the shell runs only the text of install.sh's own heredoc; nothing is installed
/**
 * THE SHIM'S TEXT IS ONE TEXT (A11-285): `launcherText` and `install.sh`'s `write_launcher` heredoc write the same bytes, so `onboard`, `command:check --fix` and `install.sh` never write two shims.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { launcherText, shimTextFor, writeLauncher } from "./launcher.ts";

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.sh");

/** What `write_launcher`'s heredoc writes for these two variables: the heredoc is cut out of install.sh and run by `sh`. */
function heredocOutput(agentOrgHome: string, current: string): string {
  const script = readFileSync(INSTALL_SH, "utf8");
  const body = /cat >"\$TEMPORARY" <<EOF\n([\s\S]*?)\nEOF\n/.exec(script)?.[1];
  assert.ok(body !== undefined, "write_launcher's heredoc is found");
  const ran = spawnSync("/bin/sh", ["-c", `AGENT_ORG_HOME='${agentOrgHome}'; CURRENT='${current}'; cat <<EOF\n${body}\nEOF`], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

test("launcherText equals what install.sh's write_launcher writes, byte for byte", () => {
  const agentOrgHome = "/home/me/.agent-org";
  assert.equal(launcherText({ agentOrgHome, current: `${agentOrgHome}/tool/current` }), heredocOutput(agentOrgHome, `${agentOrgHome}/tool/current`));
  assert.equal(shimTextFor(`${agentOrgHome}/tool`), heredocOutput(agentOrgHome, `${agentOrgHome}/tool/current`));
});

test("the shim runs through current, so an update that moves current changes what it runs", () => {
  assert.match(shimTextFor("/h/.agent-org/tool"), /^exec node '\/h\/\.agent-org\/tool\/current\/src\/bin\.ts' "\$@"$/m);
});

test("writeLauncher writes the text executable, atomically", () => {
  const path = join(tmpDir("launcher-"), "bin", "agent-org");
  writeLauncher(path, shimTextFor("/h/.agent-org/tool"));
  assert.equal(readFileSync(path, "utf8"), shimTextFor("/h/.agent-org/tool"));
  assert.equal(statSync(path).mode & 0o777, 0o755);
});
