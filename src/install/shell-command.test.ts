// no-token: none -- the shell is never started: its answer is injected as text, and every file is in a temporary home
/**
 * WHAT THE PERSON'S SHELL RUNS WHEN THEY TYPE `agent-org`, AND THE ROW THAT JUDGES IT (A11-285).
 *
 * On 2026-10-25 it was an alias in `~/.zshrc` to a checkout at v0.276.0 while the install was v0.304.1. Each case here is one way the answer can come out; the shell's text is injected, so bash's wording and
 * zsh's are both read without either installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { shimTextFor } from "./launcher.ts";
import type { CopyComparison } from "./tool-copy.ts";
import { checkCommand, outcomeLines } from "./shell-command-cli.ts";
import { fixShellCommand } from "./shell-command-fix.ts";
import { judgeShellCommand, readShellCommand, realShellDeps, shellContext, type ShellDeps } from "./shell-command.ts";

const OLD: CopyComparison = { kind: "older", copy: "v0.276.0", installed: "v0.304.1" };
const NEWER: CopyComparison = { kind: "newer-or-same", copy: "main@1a2b3c4", installed: "v0.304.1" };
const NOW = new Date("2026-10-25T19:30:00.000Z");

/** A home with an install at v0.304.1 (`current` names its folder), the shim's directory, and no start-up file yet. */
function world() {
  const home = tmpDir("shell-command-");
  const tool = join(home, ".agent-org", "tool");
  const binDir = join(home, ".local", "bin");
  mkdirSync(join(tool, "versions", "v0.304.1", "src"), { recursive: true });
  symlinkSync("versions/v0.304.1", join(tool, "current"));
  mkdirSync(binDir, { recursive: true });
  const context = { tool, binDir, devTool: null, home };
  const shell = (typed: string | null, compare: ShellDeps["compare"] = () => OLD, env: Record<string, string | undefined> = { SHELL: "/bin/zsh" }): ShellDeps => ({
    ...realShellDeps(env, home, tool), type: () => typed, compare,
  });
  const rc = (name: string, text: string): string => {
    writeFileSync(join(home, name), text);
    return join(home, name);
  };
  return { home, tool, binDir, context, shell, rc };
}

const ZSHRC_WITH_ALIAS = (lines: number) => `${"# a line of the person's own\n".repeat(lines - 1)}alias agent-org='node ~/old/agent-org/src/bin.ts'\nexport EDITOR=vim\n`;

test("an alias to an old checkout fails doctor and names the line, both versions, and the exact fix", () => {
  const w = world();
  w.rc(".zshrc", ZSHRC_WITH_ALIAS(42));
  const row = judgeShellCommand(readShellCommand(w.shell("agent-org is an alias for node ~/old/agent-org/src/bin.ts\n")), w.context);
  assert.equal(row.ok, false);
  assert.equal(row.name, "agent-org command");
  assert.match(row.detail, /an alias, defined at ~\/\.zshrc:42/);
  assert.match(row.detail, new RegExp(`runs ~/old/agent-org \\(v0\\.276\\.0, against the installed v0\\.304\\.1\\)`));
  assert.match(row.detail, /not the installed tool \(~\/\.agent-org\/tool\/current\)/);
  assert.equal(row.fix, "run `node ~/.agent-org/tool/current/src/bin.ts command:check --fix`, which comments out that definition (a backup of the file is kept) and installs ~/.local/bin/agent-org, the shim that always runs ~/.agent-org/tool/current");
});

test("the shim passes: a file on PATH whose text is the installed shim runs the tool through current", () => {
  const w = world();
  const shim = join(w.binDir, "agent-org");
  writeFileSync(shim, shimTextFor(w.tool), { mode: 0o755 });
  const row = judgeShellCommand(readShellCommand(w.shell(`agent-org is ${shim}\n`, () => ({ kind: "installed" }))), w.context);
  assert.equal(row.ok, true, row.detail);
  assert.match(row.detail, /runs the installed tool through ~\/\.agent-org\/tool\/current/);
});

test("an alias to the current link passes, which is how the chairman's alias was fixed by hand", () => {
  const w = world();
  w.rc(".zshrc", `alias agent-org='node ${w.tool}/current/src/bin.ts'\n`);
  const row = judgeShellCommand(readShellCommand(w.shell(`agent-org is an alias for node ${w.tool}/current/src/bin.ts\n`, () => ({ kind: "installed" }))), w.context);
  assert.equal(row.ok, true, row.detail);
  assert.match(row.detail, /an alias \(~\/\.zshrc:1\) runs the installed tool/);
});

test("an alias to the version folder fails even while current names it: the next update leaves it behind", () => {
  const w = world();
  const versionBin = `${w.tool}/versions/v0.304.1/src/bin.ts`;
  w.rc(".zshrc", `alias agent-org='node ${versionBin}'\n`);
  const row = judgeShellCommand(readShellCommand(w.shell(`agent-org is an alias for node ${versionBin}\n`, () => ({ kind: "installed" }))), w.context);
  assert.equal(row.ok, false);
  assert.match(row.detail, /which `current` names today but will leave behind at the next update/);
});

test("a development checkout passes only when host.json names it as devTool and it is at least as new", () => {
  const w = world();
  const checkout = join(w.home, "dev", "agent-org");
  const typed = `agent-org is an alias for node ${checkout}/src/bin.ts\n`;
  w.rc(".zshrc", `alias agent-org='node ${checkout}/src/bin.ts'\n`);
  const named = { ...w.context, devTool: checkout };
  assert.equal(judgeShellCommand(readShellCommand(w.shell(typed, () => NEWER)), named).ok, true, "named and newer");
  assert.equal(judgeShellCommand(readShellCommand(w.shell(typed, () => OLD)), named).ok, false, "named but older");
  const unnamed = judgeShellCommand(readShellCommand(w.shell(typed, () => NEWER)), w.context);
  assert.equal(unnamed.ok, false, "newer but not named");
  assert.match(unnamed.detail, /allowed when host\.json names it as `devTool`/);
  assert.equal(judgeShellCommand(readShellCommand(w.shell(typed, () => ({ kind: "unknown", copy: "main@1a2b3c4", installed: "v0.304.1", reason: "x", fix: "y" }))), named).ok, false, "named but unknown");
});

const WORDINGS: ReadonlyArray<{ name: string; typed: string; kind: string }> = [
  { name: "zsh alias", typed: "agent-org is an alias for node ~/old/agent-org/src/bin.ts\n", kind: "alias" },
  { name: "bash alias", typed: "agent-org is aliased to `node ~/old/agent-org/src/bin.ts'\n", kind: "alias" },
  { name: "zsh function", typed: "agent-org is a shell function from /h/.zshrc\n", kind: "function" },
  { name: "bash function", typed: "agent-org is a function\nagent-org () \n{ \n    node ~/old/agent-org/src/bin.ts \"$@\"\n}\n", kind: "function" },
  { name: "zsh file", typed: "agent-org is /h/.local/bin/agent-org\n", kind: "file" },
  { name: "bash hashed file", typed: "agent-org is hashed (/h/.local/bin/agent-org)\n", kind: "file" },
];

for (const { name, typed, kind } of WORDINGS) {
  test(`the ${name} wording is read as ${kind === "file" ? "a file" : `an ${kind === "alias" ? "alias" : "function"}`}, after the start-up files' own output`, () => {
    const w = world();
    const reading = readShellCommand(w.shell(`welcome back\n${typed}`));
    assert.equal(reading.kind, kind);
  });
}

test("a function defined over several lines names the copy its body runs, and its line", () => {
  const w = world();
  w.rc(".zshrc", "# top\nagent-org() {\n  node ~/old/agent-org/src/bin.ts \"$@\"\n}\n");
  const reading = readShellCommand(w.shell("agent-org is a shell function from /h/.zshrc\n"));
  assert.equal(reading.kind, "function");
  assert.deepEqual(reading.kind === "function" ? reading.defined : null, { file: join(w.home, ".zshrc"), line: 2 });
  assert.equal(reading.kind === "function" ? reading.copyRoot : null, `${w.home}/old/agent-org`);
});

test("the last definition the shell reads wins, and a file it sources is read one level deep", () => {
  const w = world();
  w.rc(".zshenv", "alias agent-org='node ~/first/src/bin.ts'\n");
  w.rc("extra.zsh", "# sourced\nalias agent-org='node ~/second/src/bin.ts'\n");
  w.rc(".zshrc", `source ${w.home}/extra.zsh\n`);
  const reading = readShellCommand(w.shell("agent-org is an alias for node ~/second/src/bin.ts\n"));
  assert.deepEqual(reading.kind === "alias" ? reading.defined : null, { file: join(w.home, "extra.zsh"), line: 2 });
  w.rc(".zlogin", "alias agent-org='node ~/third/src/bin.ts'\n");
  const later = readShellCommand(w.shell("agent-org is an alias for node ~/third/src/bin.ts\n"));
  assert.deepEqual(later.kind === "alias" ? later.defined : null, { file: join(w.home, ".zlogin"), line: 1 });
});

test("a definition no start-up file holds is said as such, not hidden", () => {
  const w = world();
  const row = judgeShellCommand(readShellCommand(w.shell("agent-org is an alias for node ~/old/agent-org/src/bin.ts\n")), w.context);
  assert.equal(row.ok, false);
  assert.match(row.detail, /defined somewhere I could not find in your start-up files/);
});

test("a shell that cannot be asked is a warning, not a fail, and a shell that finds no agent-org is a warning with the PATH line", () => {
  const w = world();
  const silent = judgeShellCommand(readShellCommand(w.shell(null)), w.context);
  assert.deepEqual([silent.ok, silent.warning], [true, true]);
  assert.match(silent.detail, /could not be asked what `agent-org` is/);
  assert.equal(silent.fix, "run `type agent-org` in your shell to see what it runs");
  const absent = judgeShellCommand(readShellCommand(w.shell("zsh: command not found: agent-org\nagent-org not found\n")), w.context);
  assert.deepEqual([absent.ok, absent.warning], [true, true]);
  assert.match(absent.fix ?? "", /export PATH="~\/\.local\/bin:\$PATH"/);
});

test("with SHELL unset the first agent-org on PATH is read, as a file", () => {
  const w = world();
  const shim = join(w.binDir, "agent-org");
  writeFileSync(shim, shimTextFor(w.tool), { mode: 0o755 });
  const deps: ShellDeps = { ...w.shell(null, () => ({ kind: "installed" }), {}), which: () => shim };
  assert.equal(judgeShellCommand(readShellCommand(deps), w.context).ok, true);
});

test("a symlink to bin.ts is followed one link at a time: one to current passes, one to a checkout fails", () => {
  const w = world();
  const viaCurrent = join(w.binDir, "agent-org");
  symlinkSync(`${w.tool}/current/src/bin.ts`, viaCurrent);
  assert.equal(judgeShellCommand(readShellCommand(w.shell(`agent-org is ${viaCurrent}\n`, () => ({ kind: "installed" }))), w.context).ok, true);
  const other = join(w.home, "other-bin");
  mkdirSync(other);
  symlinkSync(`${w.home}/old/agent-org/src/bin.ts`, join(other, "agent-org"));
  const row = judgeShellCommand(readShellCommand(w.shell(`agent-org is ${other}/agent-org\n`)), w.context);
  assert.equal(row.ok, false);
  assert.match(row.detail, /the file is ~\/other-bin\/agent-org; it runs ~\/old\/agent-org \(v0\.276\.0/);
});

test("shellContext reads binDir and devTool from the host file, and binDir from AGENT_ORG_BIN_DIR first", () => {
  const host = JSON.stringify({ binDir: "/srv/bin", devTool: "/src/agent-org" });
  assert.deepEqual(shellContext({}, "/h", host), { tool: "/h/.agent-org/tool", binDir: "/srv/bin", devTool: "/src/agent-org", home: "/h" });
  assert.equal(shellContext({ AGENT_ORG_BIN_DIR: "/mine" }, "/h", host).binDir, "/mine");
  assert.deepEqual(shellContext({}, "/h", "not json"), { tool: "/h/.agent-org/tool", binDir: "/h/.local/bin", devTool: null, home: "/h" });
  assert.equal(shellContext({}, "/h", JSON.stringify({ devTool: "relative" })).devTool, null, "a relative devTool is no setting");
});

/** The files in `dir` that are backups of start-up files. */
const backupsIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.includes(".before-agent-org-"));

test("the fix comments out an alias line under a marker, backs the whole file up with its original bytes, and installs the shim", () => {
  const w = world();
  const original = ZSHRC_WITH_ALIAS(3);
  const rc = w.rc(".zshrc", original);
  const reading = readShellCommand(w.shell("agent-org is an alias for node ~/old/agent-org/src/bin.ts\n"));
  const result = fixShellCommand(reading, { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW });
  assert.equal(result.refused, null);
  const [backup] = backupsIn(w.home);
  assert.equal(backup, ".zshrc.before-agent-org-2026-10-25T19-30-00-000Z");
  assert.equal(readFileSync(join(w.home, backup), "utf8"), original, "the backup holds the original bytes");
  const lines = readFileSync(rc, "utf8").split("\n");
  assert.equal(lines[2], "# agent-org (A11-285): replaced by the installed command ~/.local/bin/agent-org on 2026-10-25; was:");
  assert.equal(lines[3], "# alias agent-org='node ~/old/agent-org/src/bin.ts'");
  assert.equal(lines[4], "export EDITOR=vim");
  assert.equal(readFileSync(join(w.binDir, "agent-org"), "utf8"), shimTextFor(w.tool));
  assert.equal(statSync(join(w.binDir, "agent-org")).mode & 0o777, 0o755);
});

test("the fix comments out a function from its first line to its closing brace, and nothing past it", () => {
  const w = world();
  const original = "export A=1\nfunction agent-org {\n  node ~/old/agent-org/src/bin.ts \"$@\"\n}\nexport B=2\n";
  const rc = w.rc(".zshrc", original);
  const reading = readShellCommand(w.shell("agent-org is a shell function from /h/.zshrc\n"));
  assert.equal(fixShellCommand(reading, { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW }).refused, null);
  const lines = readFileSync(rc, "utf8").split("\n");
  assert.deepEqual(lines.slice(1, 7).map((line) => line.replace(/^(# agent-org \(A11-285\).*)$/, "MARKER")), ["MARKER", "# function agent-org {", "#   node ~/old/agent-org/src/bin.ts \"$@\"", "# }", "export B=2", ""]);
  assert.equal(readFileSync(join(w.home, backupsIn(w.home)[0]), "utf8"), original);
});

test("a function whose body never closes on a line of its own is left as it is, and the fix says so", () => {
  const w = world();
  const rc = w.rc(".zshrc", "agent-org() {\n  node ~/old/agent-org/src/bin.ts \"$@\" ; }  # open\n");
  const reading = readShellCommand(w.shell("agent-org is a shell function from /h/.zshrc\n"));
  const result = fixShellCommand(reading, { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW });
  assert.match(result.refused ?? "", /no closing `\}` line of its own/);
  assert.equal(readFileSync(rc, "utf8"), "agent-org() {\n  node ~/old/agent-org/src/bin.ts \"$@\" ; }  # open\n");
  assert.deepEqual(backupsIn(w.home), [], "nothing is backed up when nothing is changed");
});

test("a start-up file outside the home folder is never edited", () => {
  const w = world();
  const outside = tmpDir("shell-command-system-");
  const file = join(outside, "zshenv");
  writeFileSync(file, "alias agent-org='node /opt/old/src/bin.ts'\n");
  const reading = { ...readShellCommand(w.shell("agent-org is an alias for node /opt/old/src/bin.ts\n")), defined: { file, line: 1 } };
  const result = fixShellCommand(reading as never, { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW });
  assert.match(result.refused ?? "", /is outside your home folder, so it is left as it is/);
  assert.equal(readFileSync(file, "utf8"), "alias agent-org='node /opt/old/src/bin.ts'\n");
  assert.deepEqual(readdirSync(outside), ["zshenv"]);
});

test("a file on PATH that is not the shim is renamed to its backup and the shim is written in its place; one outside home is named, not touched", () => {
  const w = world();
  const stale = join(w.binDir, "agent-org");
  writeFileSync(stale, `#!/bin/sh\nexec node '${w.home}/old/agent-org/src/bin.ts' "$@"\n`, { mode: 0o755 });
  const reading = readShellCommand(w.shell(`agent-org is ${stale}\n`));
  const result = fixShellCommand(reading, { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW });
  assert.equal(result.refused, null);
  assert.equal(readFileSync(stale, "utf8"), shimTextFor(w.tool));
  assert.match(readFileSync(join(w.binDir, backupsIn(w.binDir)[0]), "utf8"), /old\/agent-org\/src\/bin\.ts/);
  const system = tmpDir("shell-command-usr-");
  writeFileSync(join(system, "agent-org"), `#!/bin/sh\nexec node '${w.home}/old/agent-org/src/bin.ts' "$@"\n`);
  const outside = fixShellCommand(readShellCommand(w.shell(`agent-org is ${system}/agent-org\n`)), { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW });
  assert.match(outside.refused ?? "", /sudo install -m 755 /);
  assert.equal(existsSync(join(system, "agent-org")), true);
  assert.deepEqual(readdirSync(system), ["agent-org"]);
});

/** A shell that answers `type agent-org` from the files it would read: the alias in `.zshrc` while it is live, else the file in `binDir`, else nothing. */
function fakeShell(w: ReturnType<typeof world>): ShellDeps {
  const type = (): string | null => {
    const rc = existsSync(join(w.home, ".zshrc")) ? readFileSync(join(w.home, ".zshrc"), "utf8") : "";
    const alias = /^alias agent-org='(.*)'$/m.exec(rc);
    if (alias !== null) return `agent-org is an alias for ${alias[1]}\n`;
    return existsSync(join(w.binDir, "agent-org")) ? `agent-org is ${join(w.binDir, "agent-org")}\n` : "agent-org not found\n";
  };
  return { ...w.shell(null), type, compare: (root) => (root === join(w.tool, "current") ? { kind: "installed" } : OLD) };
}

const checkOver = (w: ReturnType<typeof world>, confirm: () => boolean | null) => ({ shell: fakeShell(w), context: w.context, fix: { home: w.home, binDir: w.binDir, tool: w.tool, now: () => NOW }, confirm });

/** A home whose `.zshrc` holds the old alias on line 2, and the outcome of `command:check` over it with `options`, answering `confirm` when asked. */
async function checkedOver(options: { fix: boolean; ask: boolean }, confirm: () => boolean | null) {
  const w = world();
  const original = ZSHRC_WITH_ALIAS(2);
  w.rc(".zshrc", original);
  return { w, original, outcome: await checkCommand(options, checkOver(w, confirm)) };
}

test("command:check reads and changes nothing without --fix, and a row that is ok is not fixed", async () => {
  const { w, original, outcome } = await checkedOver({ fix: false, ask: false }, () => { throw new Error("nobody is asked without --fix"); });
  assert.equal(outcome.after.ok, false);
  assert.deepEqual(outcome.fixed, []);
  assert.equal(readFileSync(join(w.home, ".zshrc"), "utf8"), original);
  assert.match(outcomeLines(outcome)[0], /^✗ agent-org command: `agent-org` in your shell is an alias, defined at ~\/\.zshrc:2;/);
});

test("--fix --ask asks first; a no leaves the alias and the file exactly as they were", async () => {
  const { w, original, outcome } = await checkedOver({ fix: true, ask: true }, () => false);
  assert.equal(outcome.declined, true);
  assert.equal(outcome.after.ok, false);
  assert.equal(readFileSync(join(w.home, ".zshrc"), "utf8"), original);
  assert.deepEqual(backupsIn(w.home), []);
  assert.equal(existsSync(join(w.binDir, "agent-org")), false);
});

test("--fix --ask with nobody to ask replaces the alias and says it did, ending with the shim in place and the line backed up", async () => {
  const { w, original, outcome } = await checkedOver({ fix: true, ask: true }, () => null);
  assert.equal(outcome.unasked, true);
  assert.equal(outcome.after.ok, true, outcome.after.detail);
  assert.match(outcomeLines(outcome).join("\n"), /no terminal to ask on, so it is replaced without asking\n {2}fixed: commented out ~\/\.zshrc:2 \(the whole file is kept as ~\/\.zshrc\.before-agent-org-/);
  assert.equal(readFileSync(join(w.home, backupsIn(w.home)[0]), "utf8"), original);
  assert.equal(readFileSync(join(w.binDir, "agent-org"), "utf8"), shimTextFor(w.tool));
});

test("--fix --ask with a yes replaces the alias, and an alias hiding a stale file on PATH takes a second pass that replaces the file too", async () => {
  const w = world();
  w.rc(".zshrc", ZSHRC_WITH_ALIAS(1));
  const stale = join(w.binDir, "agent-org");
  writeFileSync(stale, `#!/bin/sh\nexec node '${w.home}/old/agent-org/src/bin.ts' "$@"\n`, { mode: 0o755 });
  const outcome = await checkCommand({ fix: true, ask: true }, checkOver(w, () => true));
  assert.equal(outcome.after.ok, true, outcome.after.detail);
  assert.equal(outcome.fixed.length, 2);
  assert.equal(readFileSync(stale, "utf8"), shimTextFor(w.tool));
  assert.equal(backupsIn(w.home).length, 1);
  assert.equal(backupsIn(w.binDir).length, 1);
});

test("a fix that is refused leaves the row failing and says why", async () => {
  const w = world();
  w.rc(".zshrc", "agent-org() {\n  node ~/old/agent-org/src/bin.ts \"$@\" ; }  # open\n");
  const shell = { ...fakeShell(w), type: () => "agent-org is a shell function from /h/.zshrc\n" };
  const outcome = await checkCommand({ fix: true, ask: false }, { ...checkOver(w, () => true), shell });
  assert.equal(outcome.after.ok, false);
  assert.match(outcome.refused ?? "", /no closing `\}` line of its own/);
  assert.match(outcomeLines(outcome).join("\n"), /\n {2}refused: the function at ~\/\.zshrc:1 has no closing/);
});
