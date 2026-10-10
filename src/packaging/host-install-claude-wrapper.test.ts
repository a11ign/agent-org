// no-token: gh -- nothing here reaches a real `claude`, `herdr`, `gh` or the network: the wrapper is RUN against a stub `claude` (`A11Y_CLAUDE_REAL`) and a
// stub `herdr` (`HERDR_BIN_PATH`) this file writes into temp directories it deletes.
/**
 * a11ign#4823 (follow-up of a11ign#3663): A STANDING SEAT'S LAUNCH FLAG SURVIVES A HERDR RESTORE.
 *
 * Measured 2026-10-09 12:32:42: herdr restored all four seats as a bare `claude --resume <id>` and the `autoMemoryEnabled:false` given to
 * three of them on 2026-10-05 was gone. `host/claude` is on a pane's PATH ahead of the real binary and adds it again, by workspace.
 *
 *  1. RUNNING `host/claude`: a standing seat other than `ceo` gets exactly one `--settings` carrying `autoMemoryEnabled:false`; `ceo` gets none; a
 *     worker, whose argv already carries `--settings`, is passed through with exactly one and costs herdr no question. The controls are the same
 *     call from the other seat, so a wrapper that always adds and one that never adds are each told apart.
 *  2. WHAT IT LEAVES ALONE: a subcommand, a `--`, no workspace, a herdr that does not answer or answers for another workspace.
 *
 * WHAT IS NOT HERE: the roster that the seat list is rendered from, the install, `host:check` and the shadowing note are `host-units.test.ts`'s ("a11ign#4823"),
 * because they import `host-units.ts`, and a test file that does is charged `History: full` and declared in `work-gate.test.ts` (#2174). This file imports
 * nothing of the tool, so the row's Acceptance is the running half, which is the half no other file can pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(new URL("../../host/claude", import.meta.url));
const SETTINGS = '{"autoMemoryEnabled":false}';
const SEATS = "product-manager orchestrator liaison";

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-org-claude-wrapper-")));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch world for `host/claude`: a stub `claude` that records its arguments NUL-terminated, and a stub `herdr` that answers `workspace get <id>`
 * with the label the call chose (`STUB_LABEL`), another workspace's id (`STUB_ID`) or a failure (`STUB_HERDR_STATUS`), and leaves a marker when asked.
 */
function world() {
  const root = scratch();
  const real = join(root, "claude-real");
  writeFileSync(real, ["#!/bin/sh", `: > "${root}/args"`, `for a; do printf '%s\\0' "$a" >> "${root}/args"; done`, "exit 0", ""].join("\n"), { mode: 0o755 });
  const herdr = join(root, "herdr");
  writeFileSync(herdr, [
    "#!/bin/sh",
    `echo "$*" >> "${root}/herdr-asked"`,
    `[ -n "$STUB_HERDR_STATUS" ] && exit "$STUB_HERDR_STATUS"`,
    `printf '{"id":"cli:workspace:get","result":{"type":"workspace_info","workspace":{"label":"%s","workspace_id":"%s"}}}\\n' "\${STUB_LABEL:-}" "\${STUB_ID:-$3}"`,
    ""].join("\n"), { mode: 0o755 });
  const run = (env: Record<string, string>, ...args: string[]) => {
    const full: Record<string, string> = { PATH: process.env.PATH ?? "", A11Y_CLAUDE_REAL: real, A11Y_CLAUDE_SEATS: SEATS, HERDR_BIN_PATH: herdr,
      HERDR_WORKSPACE_ID: "w2", ...env };
    for (const key of Object.keys(full)) if (full[key] === "") delete full[key];
    const ran = spawnSync("bash", [WRAPPER, ...args], { encoding: "utf8", env: full });
    return { status: ran.status, stderr: ran.stderr };
  };
  /** The arguments the stub claude received, or NULL when it never ran (which is not "no arguments"). */
  const received = (): string[] | null => (existsSync(join(root, "args")) ? readFileSync(join(root, "args"), "utf8").split("\0").slice(0, -1) : null);
  const herdrAsked = () => existsSync(join(root, "herdr-asked"));
  return { run, received, herdrAsked, real };
}

// --- 1. running it -----------------------------------------------------------------------------------------------------------------------

test("1. a standing seat other than ceo is resumed with exactly one --settings, and it holds autoMemoryEnabled:false", () => {
  const w = world();
  assert.equal(w.run({ STUB_LABEL: "product-manager" }, "--resume", "70f008a4").status, 0);
  const args = w.received();
  assert.deepEqual(args, ["--resume", "70f008a4", "--settings", SETTINGS]);
  assert.equal(JSON.parse(args![3]).autoMemoryEnabled, false);
});

test("1. the control: ceo's workspace is NOT switched, so a wrapper that always adds the flag is told apart", () => {
  const w = world();
  w.run({ STUB_LABEL: "ceo", HERDR_WORKSPACE_ID: "w6" }, "--resume", "9172a127");
  assert.deepEqual(w.received(), ["--resume", "9172a127"]);
  assert.ok(w.herdrAsked(), "it asked herdr and was told `ceo`: not leaving the call unflagged for want of asking");
});

test("1. a worker's argv already carries --settings: it is passed through with exactly one, and herdr is not asked", () => {
  const w = world();
  const argv = ["--model", "sonnet", "--settings", "/x/worker-settings.json", "--disallowedTools", "AskUserQuestion"];
  w.run({ STUB_LABEL: "product-manager" }, ...argv);
  assert.deepEqual(w.received(), argv);
  assert.equal(w.received()!.filter((a) => a === "--settings").length, 1);
  assert.equal(w.herdrAsked(), false);
  w.run({ STUB_LABEL: "product-manager" }, "--resume", "x", "--settings={\"model\":\"opus\"}");
  assert.deepEqual(w.received(), ["--resume", "x", "--settings={\"model\":\"opus\"}"], "the `--settings=` spelling is a named settings too");
});

test("1. a workspace labelled worker-<n> is not a seat, so the flag is never added to it", () => {
  const w = world();
  w.run({ STUB_LABEL: "worker-4823", HERDR_WORKSPACE_ID: "w373" }, "--model", "sonnet");
  assert.deepEqual(w.received(), ["--model", "sonnet"]);
});

// --- 2. what it leaves alone -------------------------------------------------------------------------------------------------------------

test("2. a call that does not open with a flag, or holds `--`, is exec'd unchanged and herdr is not asked", () => {
  const w = world();
  w.run({ STUB_LABEL: "product-manager" }, "update");
  assert.deepEqual(w.received(), ["update"], "a subcommand could refuse an option it does not know");
  w.run({ STUB_LABEL: "product-manager" }, "--resume", "x", "--", "prompt");
  assert.deepEqual(w.received(), ["--resume", "x", "--", "prompt"], "nothing can be appended after the options end");
  assert.equal(w.herdrAsked(), false);
});

test("2. a herdr that fails, one that names another workspace, and a call with no workspace id all leave the call unflagged", () => {
  const w = world();
  w.run({ STUB_HERDR_STATUS: "1" }, "--resume", "x");
  assert.deepEqual(w.received(), ["--resume", "x"], "herdr did not answer");
  w.run({ STUB_LABEL: "product-manager", STUB_ID: "w9" }, "--resume", "x");
  assert.deepEqual(w.received(), ["--resume", "x"], "herdr answered for another workspace");
  w.run({ STUB_LABEL: "product-manager", HERDR_WORKSPACE_ID: "" }, "--resume", "x");
  assert.deepEqual(w.received(), ["--resume", "x"], "no workspace id");
});

test("2. a bare `claude` is a launch too, and it is flagged in a seat", () => {
  const w = world();
  w.run({ STUB_LABEL: "orchestrator", HERDR_WORKSPACE_ID: "w5" });
  assert.deepEqual(w.received(), ["--settings", SETTINGS]);
});

test("2. argv[0] stays `claude` for a call it does not change, so `ps` and the readers of `claude --resume <id>` see what they saw", () => {
  const w = world();
  const ran = spawnSync("bash", [WRAPPER, "-c", 'printf %s "$0"'], { encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", A11Y_CLAUDE_REAL: "/bin/bash", A11Y_CLAUDE_SEATS: "", HERDR_BIN_PATH: w.real } });
  assert.equal(ran.stdout, "claude");
});

test("2. a wrapper that IS the real binary refuses, and does not exec itself", () => {
  const dir = scratch();
  const copy = join(dir, "claude");
  writeFileSync(copy, readFileSync(WRAPPER));
  chmodSync(copy, 0o755);
  const link = join(dir, "link");
  symlinkSync(copy, link);
  const ran = spawnSync("bash", [copy, "--resume", "x"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", A11Y_CLAUDE_REAL: link }, timeout: 5000 });
  assert.equal(ran.status, 127);
  assert.match(ran.stderr, /would exec itself/);
});
