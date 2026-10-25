// no-token: none -- the comparison with the installed tool is injected: no git runs, and no program is started
/**
 * `update`, `host:install` AND `start` REFUSE TO RUN FROM A COPY THAT IS NOT THE INSTALLED TOOL AND IS OLDER THAN IT (A11-285).
 *
 * The case that happened: `agent-org update` typed where `agent-org` was an alias to a v0.276.0 checkout, with v0.304.1 installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planGuardedInvocation } from "../bin.ts";
import { GUARDED, guardCopy, isGuarded, OVERRIDE_FLAG } from "./command-guard.ts";
import type { CopyComparison } from "./tool-copy.ts";

const COPY = "/home/me/Documents/repos/work/agent-org";
const SHIM_DIR = "/home/me/.local/bin";
const OLD: CopyComparison = { kind: "older", copy: "v0.276.0", installed: "v0.304.1" };
const UNKNOWN: CopyComparison = { kind: "unknown", copy: "main@1a2b3c4", installed: "v0.304.1", reason: `${COPY} does not hold v0.304.1's source commit 9f8e7d6`, fix: `git -C ${COPY} fetch origin --tags` };
const guard = (compare: CopyComparison, command: string, rest: string[] = []) => guardCopy({ command, argv: [command, ...rest], copyRoot: COPY, tool: "/home/me/.agent-org/tool", binDir: SHIM_DIR, compare: () => compare });

test("`update` from an older copy refuses, and names the copy, both versions, and the right command to run", () => {
  const result = guard(OLD, "update");
  assert.deepEqual(result, {
    refusal: `agent-org update: refused: this ran ${COPY} (v0.276.0), which is not the installed tool and is older than it (v0.304.1). Run \`${SHIM_DIR}/agent-org update\`, or \`node /home/me/.agent-org/tool/current/src/bin.ts update\`; \`agent-org doctor\` shows what your \`agent-org\` runs. \`--allow-older-copy\` runs it from this copy anyway.`,
  });
});

for (const command of ["host:install", "start"]) {
  test(`\`${command}\` from an older copy refuses, with its own arguments in the command to run`, () => {
    const result = guard(OLD, command, ["--now"]);
    assert.ok("refusal" in result);
    assert.match(result.refusal, new RegExp(`^agent-org ${command}: refused: this ran ${COPY} \\(v0\\.276\\.0\\)`));
    assert.ok(result.refusal.includes(`Run \`${SHIM_DIR}/agent-org ${command} --now\``));
  });
}

test("a copy whose age cannot be told is refused as older, with the fetch that settles it", () => {
  const result = guard(UNKNOWN, "update");
  assert.ok("refusal" in result);
  assert.match(result.refusal, /whose age against the installed v0\.304\.1 cannot be told/);
  assert.ok(result.refusal.includes(`\`git -C ${COPY} fetch origin --tags\` settles it`));
});

test("--allow-older-copy runs the command from the older copy, and the program never sees the flag", () => {
  assert.deepEqual(guard(OLD, "update", [OVERRIDE_FLAG, "--version", "v0.3.0"]), { run: ["update", "--version", "v0.3.0"] });
  assert.deepEqual(guard(UNKNOWN, "start", ["instance", OVERRIDE_FLAG]), { run: ["start", "instance"] });
});

test("the installed tool, a newer copy and an install with no current link run as they did", () => {
  for (const compare of [{ kind: "installed" }, { kind: "newer-or-same", copy: "v0.310.0", installed: "v0.304.1" }, { kind: "no-install" }] as CopyComparison[]) {
    assert.deepEqual(guard(compare, "update", ["--force"]), { run: ["update", "--force"] }, compare.kind);
  }
});

test("a command outside the three is never compared with the installed tool", () => {
  const asked: string[] = [];
  const compare = (root: string): CopyComparison => { asked.push(root); return OLD; };
  for (const command of ["doctor", "status", "stop", "ticket:serve", "onboard", "command:check"]) {
    assert.deepEqual(guardCopy({ command, argv: [command, "--x"], copyRoot: COPY, tool: "/t", binDir: "/b", compare }), { run: [command, "--x"] });
  }
  assert.deepEqual(asked, []);
  assert.deepEqual([...GUARDED], ["update", "host:install", "start"]);
  assert.deepEqual(["update", "host:install", "start", "doctor"].map(isGuarded), [true, true, true, false]);
});

test("the bin's plan and the guard wire together: agent-org update from an older root never reaches a program", () => {
  const plan = planGuardedInvocation(["update"], { copyRoot: COPY, tool: "/home/me/.agent-org/tool", binDir: SHIM_DIR, compare: () => OLD });
  assert.ok("refusal" in plan);
  assert.match(plan.refusal, /^agent-org update: refused: this ran /);
  const forced = planGuardedInvocation(["update", OVERRIDE_FLAG], { copyRoot: COPY, tool: "/t", binDir: "/b", compare: () => OLD });
  assert.ok("run" in forced);
  assert.match(forced.run.program, /install\/update\.ts$/);
  assert.deepEqual(forced.run.args, []);
  const hostInstall = planGuardedInvocation(["host:install"], { copyRoot: COPY, tool: "/t", binDir: "/b", compare: () => ({ kind: "installed" }) });
  assert.ok("run" in hostInstall);
  assert.deepEqual(hostInstall.run.args, ["--install"], "the table's own arguments are kept");
  assert.ok("refusal" in planGuardedInvocation(["nope"], { copyRoot: COPY, tool: "/t", binDir: "/b", compare: () => { throw new Error("an unknown command is refused before any comparison"); } }));
});
