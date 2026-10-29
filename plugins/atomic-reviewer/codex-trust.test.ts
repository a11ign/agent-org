// no-token: none -- a temporary CODEX_HOME and temporary clones; nothing reads or writes the real ~/.codex, and `git` runs only in temporary folders
//
// CODEX'S TRUST (A11-221): the host file's repositories are trusted before a review starts, an entry that exists is left alone, and a path the host file does not name is never trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** A parse as plain data: `smol-toml`'s tables have no prototype, which `deepEqual` tells apart from an object literal. */
const parse = (text: string): any => JSON.parse(JSON.stringify(parseToml(text)));
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { canonicalPath, cloneRootOf, codexConfigFile, codexTrustSeam, ensureTrusted, readTrustConfig, trustLevelOf, untrustedHostRepositories } from "./codex-trust.ts";

/** A machine: a CODEX_HOME, and two clones the host file names. */
function machine() {
  const root = tmpDir("codex-trust-");
  const codexHome = join(root, "codex");
  const clones = { alpha: join(root, "repos", "alpha"), beta: join(root, "repos", "beta") };
  for (const clone of Object.values(clones)) mkdirSync(clone, { recursive: true });
  const file = join(root, "codex", "config.toml");
  const seams = { env: { CODEX_HOME: codexHome }, clones };
  const write = (text: string) => { mkdirSync(codexHome, { recursive: true }); writeFileSync(file, text); };
  return { root, codexHome, clones, file, seams, write };
}

const ROOMY = `# my settings
model = "gpt-5"   # the one I like

[projects."/elsewhere"]
trust_level = "trusted"
`;

test("an untrusted host-file repository gets one trusted entry, and the person's comments and every other key are as they were", () => {
  const m = machine();
  m.write(ROOMY);
  const answer = ensureTrusted(m.clones.alpha, m.seams);
  assert.deepEqual(answer, { kind: "added", root: m.clones.alpha, file: m.file });
  const text = readFileSync(m.file, "utf8");
  assert.ok(text.startsWith(ROOMY), "the old text, comments and all, is untouched");
  assert.equal(text.split(`[projects."${m.clones.alpha}"]`).length - 1, 1, "exactly one table for the clone");
  assert.deepEqual(parse(text), { model: "gpt-5", projects: { "/elsewhere": { trust_level: "trusted" }, [m.clones.alpha]: { trust_level: "trusted" } } });
});

test("asked twice, the entry is added once", () => {
  const m = machine();
  m.write(ROOMY);
  assert.equal(ensureTrusted(m.clones.alpha, m.seams).kind, "added");
  assert.equal(ensureTrusted(m.clones.alpha, m.seams).kind, "present");
  assert.equal(readFileSync(m.file, "utf8").split(`[projects."${m.clones.alpha}"]`).length - 1, 1);
});

test("a missing config, and a missing CODEX_HOME, are created with only the new entry, the folder private and the file mode 600", () => {
  const m = machine();
  assert.equal(existsSync(m.codexHome), false);
  assert.equal(ensureTrusted(m.clones.alpha, m.seams).kind, "added");
  assert.equal(readFileSync(m.file, "utf8"), `[projects."${m.clones.alpha}"]\ntrust_level = "trusted"\n`);
  assert.equal(statSync(m.codexHome).mode & 0o777, 0o700);
  assert.equal(statSync(m.file).mode & 0o777, 0o600);
});

test("the old file's mode is kept, and no temporary file is left beside it", () => {
  const m = machine();
  m.write(ROOMY);
  chmodSync(m.file, 0o640);
  ensureTrusted(m.clones.alpha, m.seams);
  assert.equal(statSync(m.file).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(m.codexHome), ["config.toml"]);
});

test("a config that is a symlink is written through, and stays a symlink", () => {
  const m = machine();
  mkdirSync(m.codexHome, { recursive: true });
  const real = join(m.root, "dotfiles-config.toml");
  writeFileSync(real, ROOMY);
  symlinkSync(real, m.file);
  assert.equal(ensureTrusted(m.clones.alpha, m.seams).kind, "added");
  assert.ok(statSync(m.file).isFile());
  assert.match(readFileSync(real, "utf8"), new RegExp(`\\[projects\\."${m.clones.alpha}"\\]`));
  assert.equal(readFileSync(m.file, "utf8"), readFileSync(real, "utf8"));
});

test("an existing entry is left alone: trusted, untrusted and one with no trust_level are byte-identical afterwards, and the file is not rewritten", () => {
  for (const [level, body] of [["trusted", 'trust_level = "trusted"'], ["untrusted", 'trust_level = "untrusted"'], ["unset", "# decided later"]] as const) {
    const m = machine();
    const text = `${ROOMY}\n[projects."${m.clones.alpha}"]\n${body}\n`;
    m.write(text);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(m.file, past, past);
    const answer = ensureTrusted(m.clones.alpha, m.seams);
    assert.deepEqual(answer, { kind: "present", root: m.clones.alpha, file: m.file, level }, level);
    assert.equal(readFileSync(m.file, "utf8"), text, level);
    assert.equal(statSync(m.file).mtimeMs, past.getTime(), `${level}: not rewritten`);
  }
});

test("an entry written as an inline table, or as a dotted key, is found and not duplicated", () => {
  for (const text of [(alpha: string) => `projects = { "${alpha}" = { trust_level = "trusted" } }\n`, (alpha: string) => `[projects]\n"${alpha}".trust_level = "trusted"\n`]) {
    const m = machine();
    m.write(text(m.clones.alpha));
    assert.equal(ensureTrusted(m.clones.alpha, m.seams).kind, "present");
    assert.equal(readFileSync(m.file, "utf8"), text(m.clones.alpha));
  }
});

test("a path outside the host file is never trusted: a root not in clones, a folder under a clone, and a symlink to a folder outside clones leave the file untouched", () => {
  const m = machine();
  m.write(ROOMY);
  const outside = join(m.root, "repos", "gamma");
  mkdirSync(outside);
  const underneath = join(m.clones.alpha, "packages", "app");
  mkdirSync(underneath, { recursive: true });
  const link = join(m.root, "repos", "alpha-link");
  symlinkSync(outside, link);
  for (const root of [outside, underneath, link, "/", m.root, join(m.clones.alpha, "..", "gamma"), `${outside}/`]) {
    const answer = ensureTrusted(root, m.seams);
    assert.equal(answer.kind, "not-host", root);
  }
  assert.equal(readFileSync(m.file, "utf8"), ROOMY);
});

test("a root that differs from a clone only by a trailing slash, or by a symlink that leads to it, is that clone", () => {
  const m = machine();
  m.write(ROOMY);
  const link = join(m.root, "repos", "alpha-link");
  symlinkSync(m.clones.alpha, link);
  assert.equal(ensureTrusted(`${m.clones.alpha}/`, m.seams).kind, "added");
  assert.equal(ensureTrusted(link, m.seams).kind, "present");
  assert.equal(Object.keys(parse(readFileSync(m.file, "utf8")).projects).filter((key) => key.includes("alpha")).length, 1);
});

test("a host that names no clones trusts nothing", () => {
  const m = machine();
  assert.equal(ensureTrusted(m.clones.alpha, { env: m.seams.env, clones: {} }).kind, "not-host");
  assert.equal(existsSync(m.file), false);
});

test("a config that does not parse, or that defines projects as something that cannot take a table, is a refusal that names the file, and nothing is written", () => {
  for (const [text, why] of [["model = \n[projects\n", /does not parse/], ["projects = 3\n", /`projects`/]] as const) {
    const m = machine();
    m.write(text);
    const answer = ensureTrusted(m.clones.alpha, m.seams);
    assert.ok(answer.kind === "refused");
    assert.ok(answer.reason.includes(m.file), answer.reason);
    assert.match(answer.reason, why);
    assert.equal(readFileSync(m.file, "utf8"), text);
  }
});

test("a config that is a folder cannot be read, and is a refusal naming the file", () => {
  const m = machine();
  mkdirSync(m.file, { recursive: true });
  const answer = ensureTrusted(m.clones.alpha, m.seams);
  assert.ok(answer.kind === "refused");
  assert.match(answer.reason, /could not be read/);
});

test("a root whose name needs escaping is written as a TOML string that reads back as the same root", () => {
  const m = machine();
  const odd = join(m.root, "repos", 'we"ird\\name');
  mkdirSync(odd);
  m.write(ROOMY);
  assert.equal(ensureTrusted(odd, { env: m.seams.env, clones: { odd } }).kind, "added");
  assert.deepEqual(parse(readFileSync(m.file, "utf8")).projects[odd], { trust_level: "trusted" });
});

test("the config is CODEX_HOME's config.toml, else HOME's .codex/config.toml, from the env given and not the process's", () => {
  assert.equal(codexConfigFile({ CODEX_HOME: "/c", HOME: "/h" }), "/c/config.toml");
  assert.equal(codexConfigFile({ HOME: "/h" }), "/h/.codex/config.toml");
  assert.equal(codexConfigFile({ CODEX_HOME: "", HOME: "/h" }), "/h/.codex/config.toml");
});

test("reading a missing config answers an empty one", () => {
  const m = machine();
  const config = readTrustConfig(m.file);
  assert.ok(!("refusal" in config));
  assert.deepEqual([config.file, config.text, Object.keys(config.parsed), Object.keys(config.projects)], [m.file, "", [], []]);
});

test("untrustedHostRepositories lists a clone with no entry and one that is not trusted, with what each holds, and not a trusted one", () => {
  const m = machine();
  const third = join(m.root, "repos", "third");
  mkdirSync(third);
  const clones = { ...m.clones, third };
  m.write(`[projects."${m.clones.alpha}"]\ntrust_level = "trusted"\n\n[projects."${third}"]\ntrust_level = "untrusted"\n`);
  assert.deepEqual(untrustedHostRepositories({ env: m.seams.env, clones }), { file: m.file, untrusted: [{ root: m.clones.beta, level: "absent" }, { root: third, level: "untrusted" }] });
});

test("untrustedHostRepositories names the config when it cannot be parsed, and writes nothing", () => {
  const m = machine();
  m.write("[[[");
  const answer = untrustedHostRepositories(m.seams);
  assert.ok("refusal" in answer);
  assert.equal(answer.file, m.file);
  assert.equal(readFileSync(m.file, "utf8"), "[[[");
});

/** Runs `git` as the plugin's `execAsync` does: a status and the output, as a promise. */
const gitExec = async (file: string, args: readonly string[]) => {
  const run = spawnSync(file, [...args], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

test("a linked worktree's clone root is its main clone, not the worktree, and that is the root the seam trusts", async () => {
  const m = machine();
  const git = (cwd: string, ...args: string[]) => { const run = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); };
  git(m.clones.alpha, "init", "-q", "-b", "main");
  git(m.clones.alpha, "commit", "-q", "--allow-empty", "-m", "first");
  const worktree = join(m.root, "reviews", "reviewer-7");
  git(m.clones.alpha, "worktree", "add", "-q", "--detach", worktree);
  assert.equal(await cloneRootOf(worktree, gitExec), canonicalPath(m.clones.alpha));
  const seam = codexTrustSeam({ ...m.seams, execAsync: gitExec, log: () => undefined });
  assert.equal(await seam.rootOf(worktree), canonicalPath(m.clones.alpha));
  assert.equal(seam.ensure((await seam.rootOf(worktree))!).kind, "added");
  const config = readTrustConfig(m.file);
  assert.ok(!("refusal" in config));
  assert.equal(trustLevelOf(config.projects, canonicalPath(m.clones.alpha)), "trusted");
});

test("a folder that is no git checkout, and a bare repository, have no clone root", async () => {
  const m = machine();
  assert.equal(await cloneRootOf(m.root, gitExec), null);
  const bare = join(m.root, "bare.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
  assert.equal(await cloneRootOf(bare, gitExec), null);
  assert.equal(await cloneRootOf(m.root, async () => ({ status: null, stdout: "", stderr: "git cannot start" })), null);
});
