// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` (`A11Y_GH_REAL`) and a stub `herdr` (`HERDR_BIN_PATH`) the test writes; no real
// `gh` or herdr starts and nothing reaches the network or any account's config.
//
// agent-org#486 (Move 0 of a11ign/a11ign#4505): A DECISION COMMENT, A REVIEW AND A CLAIM REPORT POSTED THROUGH `gh` CARRY THE ROLE AND RUN THAT POSTED
// THEM. `ceo`, `product-manager` and `orchestrator` post as one account, so a comment cannot say which of them decided; the wrapper (`host/gh`) is the
// one place every post passes, and it appends `<!-- decided-by: <role> run: <id> -->` to the body of `issue comment`, `pr comment` and `pr review`.
//
// THE POSITIVE CONTROL for every "reached the stub unchanged" assertion is the stub's own record of its arguments: a wrapper that never ran the stub
// records nothing, and every case below first asserts that the record exists. THE NEGATIVE CONTROL is the herdr stub's own marker: `issue list`
// and `pr view` must reach gh-real unchanged AND never ask herdr, so the attribution cannot have cost a call the wrapper did not need to make.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const SESSION = "593792d3-21f4-4deb-baa9-12403b79ecfe";
const WORKSPACE = "w6";
const ROLE = "product-manager";
const MARK = `<!-- decided-by: ${ROLE} run: ${SESSION} -->`;
const STUB_EXIT = 7; // a status nothing else here returns, so it can only have come from the stub

/** The wrapper's own text with its `@@name@@` placeholders filled by paths nothing here uses (every one is overridden by an environment variable below). */
const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-attribution-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const host = () => {
  const root = mkdtempSync(join(tmpdir(), "gh-attribution-486-"));
  const cfg = join(root, "cfg");
  const scratch = join(root, "tmp");
  mkdirSync(cfg);
  mkdirSync(scratch);
  writeFileSync(join(cfg, "hosts.yml"), "github.com:\n    user: a11ign-ai-leads\n    oauth_token: not-a-token\n");
  // gh-real: each argument NUL-terminated into `args`, the content of the file named by a body-file flag into `bodyfile`, its stdin into `stdin`.
  const stub = join(root, "gh-real");
  writeFileSync(stub, [
    "#!/bin/sh",
    `: > "${root}/args"`,
    `for a; do printf '%s\\0' "$a" >> "${root}/args"; done`,
    `prev=`,
    `for a; do`,
    `  f=`,
    `  case "$prev" in --body-file|-F) f=$a ;; esac`,
    `  case "$a" in --body-file=*) f=\${a#--body-file=} ;; -F=*) f=\${a#-F=} ;; -F?*) f=\${a#-F} ;; esac`,
    `  [ -n "$f" ] && cat -- "$f" > "${root}/bodyfile" 2>/dev/null`,
    `  prev=$a`,
    `done`,
    `cat > "${root}/stdin"`,
    `echo "stderr-line" >&2`,
    `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  // herdr: answers `workspace get <id>` with the label and workspace id the test chose, and leaves a marker when it is asked at all.
  const herdr = join(root, "herdr");
  writeFileSync(herdr, [
    "#!/bin/sh",
    `echo "$*" >> "${root}/herdr-asked"`,
    `[ -n "$STUB_HERDR_STATUS" ] && exit "$STUB_HERDR_STATUS"`,
    `printf '{"id":"cli:workspace:get","result":{"type":"workspace_info","workspace":{"active_tab_id":"%s:t1","label":"%s","number":1,"workspace_id":"%s"}}}\\n' "\${STUB_HERDR_ID:-$3}" "\${STUB_LABEL:-${ROLE}}" "\${STUB_HERDR_ID:-$3}"`,
    ""].join("\n"), { mode: 0o755 });
  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_BIN_PATH: herdr, TMPDIR: scratch,
    A11Y_GH_LEDGER: "off", A11Y_GH_READ_CACHE: "off", ...extra });
  /** A call from a known seat unless `extra` removes it (an empty string unsets nothing, so a test passes a different environment through `bare`). */
  const run = (extra: Record<string, string>, input: string, ...args: string[]) => {
    const e: Record<string, string> = { HERDR_WORKSPACE_ID: WORKSPACE, CLAUDE_CODE_SESSION_ID: SESSION, ...extra };
    for (const k of Object.keys(e)) if (e[k] === "") delete e[k];
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: env(e), input });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  /** The arguments the stub received. NULL when it was never run, which is not "no arguments". */
  const received = (): string[] | null => (existsSync(join(root, "args")) ? readFileSync(join(root, "args"), "utf8").split("\0").slice(0, -1) : null);
  const bodyfile = () => (existsSync(join(root, "bodyfile")) ? readFileSync(join(root, "bodyfile"), "utf8") : null);
  const herdrAsked = () => existsSync(join(root, "herdr-asked"));
  return { root, scratch, run, received, bodyfile, herdrAsked, stubStdin: () => readFileSync(join(root, "stdin"), "utf8") };
};

const withHost = (fn: (h: ReturnType<typeof host>) => void) => () => {
  const h = host();
  try { fn(h); } finally { rmSync(h.root, { recursive: true, force: true }); }
};

test("#486: `issue comment --body X` from a known session reaches gh-real with X plus the trailing line naming the role and that session", withHost((h) => {
  const r = h.run({}, "", "issue", "comment", "12", "--body", "the decision");
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body", `the decision\n\n${MARK}`]);
  assert.equal(r.stderr, "stderr-line\n", "POSITIVE CONTROL: the stub ran, and its stderr came through unchanged");
}));

test("#486: `--body-file <path>` reaches gh-real as a file holding the body plus the line, and the caller's own file is left as it was", withHost((h) => {
  const path = join(h.root, "body.md");
  writeFileSync(path, "line one\nline two\n");
  h.run({}, "", "issue", "comment", "12", "--body-file", path);
  const args = h.received();
  assert.ok(args, "POSITIVE CONTROL: gh-real was reached");
  assert.deepEqual([args.slice(0, 4), args.length], [["issue", "comment", "12", "--body-file"], 5]);
  assert.notEqual(args[4], path, "gh is given the scratch copy");
  assert.equal(h.bodyfile(), `line one\nline two\n\n${MARK}\n`);
  assert.equal(readFileSync(path, "utf8"), "line one\nline two\n", "the caller's file is not rewritten");
}));

test("#486: `--body-file -` reads the body from stdin and gh-real gets it, with the line, as a file", withHost((h) => {
  h.run({}, "from stdin\n", "issue", "comment", "12", "--body-file", "-");
  const args = h.received();
  assert.ok(args, "POSITIVE CONTROL: gh-real was reached");
  assert.equal(args[3], "--body-file");
  assert.notEqual(args[4], "-");
  assert.equal(h.bodyfile(), `from stdin\n\n${MARK}\n`);
}));

test("#486: `pr review --body X` and `pr comment --body X` are rewritten the same way", withHost((h) => {
  h.run({}, "", "pr", "review", "34", "--approve", "--body", "lgtm");
  assert.deepEqual(h.received(), ["pr", "review", "34", "--approve", "--body", `lgtm\n\n${MARK}`]);
  h.run({}, "", "pr", "comment", "34", "-b", "a note");
  assert.deepEqual(h.received(), ["pr", "comment", "34", "-b", `a note\n\n${MARK}`]);
}));

test("#486: every spelling of the body flag is rewritten: `--body=X`, `-bX`, `-b=X`, `--body-file=P`, `-FP`, `-F P`", withHost((h) => {
  const path = join(h.root, "body.md");
  writeFileSync(path, "from a file");
  for (const [flag, expected] of [["--body=X", `--body=X\n\n${MARK}`], ["-bX", `-bX\n\n${MARK}`], ["-b=X", `-b=X\n\n${MARK}`]] as const) {
    h.run({}, "", "issue", "comment", "12", flag);
    assert.deepEqual(h.received(), ["issue", "comment", "12", expected], flag);
  }
  for (const flag of [`--body-file=${path}`, `-F${path}`, `-F=${path}`]) {
    rmSync(join(h.root, "bodyfile"), { force: true });
    h.run({}, "", "issue", "comment", "12", flag);
    const args = h.received();
    assert.ok(args, "POSITIVE CONTROL: gh-real was reached");
    assert.equal(args.length, 4, flag);
    assert.ok(!args[3].includes(path), `${flag}: the argument names the scratch copy, not the caller's file`);
    assert.equal(h.bodyfile(), `from a file\n\n${MARK}\n`, flag);
  }
  rmSync(join(h.root, "bodyfile"), { force: true });
  h.run({}, "", "issue", "comment", "12", "-F", path);
  assert.equal(h.bodyfile(), `from a file\n\n${MARK}\n`);
}));

test("#486: a call with no known session reaches gh-real with the body UNCHANGED, whichever way it is unknown", withHost((h) => {
  const body = ["issue", "comment", "12", "--body", "x"];
  // no workspace id at all: a unit or script outside any seat
  h.run({ HERDR_WORKSPACE_ID: "" }, "", ...body);
  assert.deepEqual(h.received(), body, "no workspace id");
  assert.equal(h.herdrAsked(), false, "and herdr was not asked");
  // herdr does not answer
  h.run({ STUB_HERDR_STATUS: "1" }, "", ...body);
  assert.deepEqual(h.received(), body, "herdr failed");
  assert.equal(h.herdrAsked(), true, "POSITIVE CONTROL: herdr was asked, so the unchanged body is its failure and not a wrapper that never looked");
  // herdr answers for another workspace
  h.run({ STUB_HERDR_ID: "w99" }, "", ...body);
  assert.deepEqual(h.received(), body, "an answer for another workspace");
  // a label that is not a name: guessing a role from `a b` would be a guess
  h.run({ STUB_LABEL: "a b" }, "", ...body);
  assert.deepEqual(h.received(), body, "a label with a space");
  h.run({ STUB_LABEL: "x-->y" }, "", ...body);
  assert.deepEqual(h.received(), body, "a label that would close the comment");
}));

test("#486: with a role and NO run id the line carries the role only, and a Codex thread id names the run when there is no Claude session", withHost((h) => {
  h.run({ CLAUDE_CODE_SESSION_ID: "" }, "", "issue", "comment", "12", "--body", "x");
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body", `x\n\n<!-- decided-by: ${ROLE} -->`]);
  h.run({ CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "01a109e5-898a" }, "", "issue", "comment", "12", "--body", "x");
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body", `x\n\n<!-- decided-by: ${ROLE} run: 01a109e5-898a -->`]);
}));

test("#486: NEGATIVE CONTROL: `issue list` and `pr view` reach gh-real with their arguments unchanged, and herdr is never asked", withHost((h) => {
  for (const args of [["issue", "list", "--label", "ready", "--json", "number"], ["pr", "view", "34", "--json", "body", "--jq", ".body"]]) {
    h.run({}, "", ...args);
    assert.deepEqual(h.received(), args);
  }
  assert.equal(h.herdrAsked(), false);
  // the same for a write the row does not name: a body flag on `issue create` is not a decision comment
  h.run({}, "", "issue", "create", "--title", "t", "--body", "b");
  assert.deepEqual(h.received(), ["issue", "create", "--title", "t", "--body", "b"]);
  assert.equal(h.herdrAsked(), false);
}));

test("#486: a body that cannot be rewritten is posted UNCHANGED and never refused", withHost((h) => {
  // already ends in a line: a nested call does not stack a second one
  const marked = `done\n\n<!-- decided-by: ceo run: abc -->`;
  h.run({}, "", "issue", "comment", "12", "--body", marked);
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body", marked]);
  // an unreadable file: gh-real is handed the path as given and reports it itself
  const missing = join(h.root, "no-such-file.md");
  h.run({}, "", "issue", "comment", "12", "--body-file", missing);
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body-file", missing]);
  // no body named at all
  h.run({}, "", "issue", "comment", "12", "--edit-last");
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--edit-last"]);
  // no scratch directory to put a file body in: the stub is handed the path as given
  const path = join(h.root, "body.md");
  writeFileSync(path, "x");
  h.run({ TMPDIR: join(h.root, "no-such-dir") }, "", "issue", "comment", "12", "--body-file", path);
  assert.deepEqual(h.received(), ["issue", "comment", "12", "--body-file", path]);
}));

test("#486: the exit status and stderr pass through, an argument with a space or a quote arrives intact, and no scratch file is left behind", withHost((h) => {
  const path = join(h.root, "body.md");
  writeFileSync(path, "x");
  const r = h.run({ STUB_STATUS: String(STUB_EXIT) }, "", "pr", "comment", "34", "--body-file", path, "--repo", "a b/c'd");
  assert.equal(r.status, STUB_EXIT);
  const args = h.received();
  assert.ok(args, "POSITIVE CONTROL: gh-real was reached");
  assert.deepEqual(args.slice(-2), ["--repo", "a b/c'd"]);
  assert.deepEqual(readdirSync(h.scratch), [], "the scratch directory the wrapper made is gone");
}));
