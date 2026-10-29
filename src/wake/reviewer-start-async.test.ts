// no-token: herdr, git, pnpm -- every program here is a recording runner, a stub script, or a fake `git` over a temporary directory; nothing reaches the real herdr, a registry or GitHub
/**
 * A11-379: THE ASYNC FORMS OF A REVIEWER'S START AND END ANSWER AS THE SYNCHRONOUS ONES DO.
 *
 * `reviewer-start-async.ts` has each step of the gate that spawns a program over an async runner, so the board's loop goes on while a reviewer starts. The synchronous forms stay for row mode, and only the sequencing of
 * the awaited calls is written twice, so each pair is held here to the same program calls, in the same order, and the same answer, for a success and for each refusal. Each form runs in a world of its own (a fresh
 * recording runner, a fresh directory), since a step changes the world it runs in.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { INSIDE, OUTSIDE } from "../review-trust.ts";
import { uncommittedPathsOf } from "./ci-class-and-spares.ts";
import { closeReviewer } from "./seat-reset.ts";
import { ensureReviewerToken, linkKeyedDependencies, prepareReviewCheckout, removeReviewCheckout, spawnReviewer } from "./reviewer-tokens-and-checkouts.ts";
import { closeReviewerAsync, ensureReviewerTokenAsync, linkKeyedDependenciesAsync, prepareReviewCheckoutAsync, removeReviewCheckoutAsync, runDoorAsync, spawnReviewerAsync, uncommittedPathsOfAsync } from "./reviewer-start-async.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

const tempDir = (prefix: string): string => tmpDir(prefix);

/** A fake world for a program: `calls` are the argument lists it was given, in order, and `answer` is what each call gets (a string, or an error to throw). */
function recording(answer: (args: string[], calls: string[][]) => string) {
  const calls: string[][] = [];
  const step = (args: string[]): string => { calls.push(args); return answer(args, calls); };
  return { calls, sync: (_cmd: string, args: string[]) => step(args), later: async (_cmd: string, args: string[]) => step(args) };
}

/** The same recording runner under `herdr`'s one-argument shape. */
function herdrRecording(answer: (args: string[]) => string) {
  const calls: string[][] = [];
  const step = (args: string[]): string => { calls.push(args); return answer(args); };
  return { calls, sync: step, later: async (args: string[]) => step(args) };
}

/** What a form answered, or the error it threw, so a refusal by throwing is compared too. */
async function outcome<T>(run: () => T | Promise<T>): Promise<{ answer: T } | { threw: string }> {
  try { return { answer: await run() }; } catch (err) { return { threw: String((err as Error).message) }; }
}

/** A git world over a set of paths that exist: `worktree add` and `checkout` make the tree, `worktree remove` removes it (or does not, with `keeps`), and `fail` names a call that throws. */
function gitWorld({ present = false, head = "abc12345abc12345", at = head, keeps = false, status = "", fail }: { present?: boolean; head?: string; at?: string; keeps?: boolean; status?: string; fail?: string } = {}) {
  let exists = present;
  const records: object[] = [];
  const world = recording((args) => {
    const call = args.filter((arg) => arg !== "-C").join(" ");
    if (fail !== undefined && call.includes(fail)) throw new Error(`git refused: ${fail}`);
    if (call.includes("rev-parse --verify")) return `${head}\n`;
    if (call.includes("rev-parse HEAD")) return `${at}\n`;
    if (call.includes("worktree add") || call.includes("checkout --quiet")) exists = true;
    if (call.includes("worktree remove")) exists = keeps;
    if (call.includes("status --porcelain")) return status;
    return "";
  });
  return { ...world, exists: () => exists, records, record: (line: object) => { records.push(line); } };
}

const COMMON = { pr: 12, session: "reviewer-12", root: "/reviews", repoRoot: "/repo" };

const CHECKOUT_CASES: [string, () => ReturnType<typeof gitWorld>, Record<string, unknown>][] = [
  ["a first tree", () => gitWorld(), {}],
  ["a tree that is there and is re-pointed", () => gitWorld({ present: true }), {}],
  ["a tree that is at another head", () => gitWorld({ at: "def67890def67890" }), {}],
  ["a git that refuses to fetch", () => gitWorld({ fail: "fetch" }), {}],
  ["a git that refuses the worktree", () => gitWorld({ fail: "worktree add" }), {}],
  ["an outside pull request, which is linked nothing", () => gitWorld(), { trust: OUTSIDE }],
  ["a dependency step that refuses", () => gitWorld(), { link: () => "node_modules is missing" }],
  ["a dependency step that gives a note", () => gitWorld(), { link: () => ({ note: "started without packages" }) }],
  ["a dependency step that links", () => gitWorld(), { link: () => null }],
];

for (const [name, make, extra] of CHECKOUT_CASES) {
  test(`prepareReviewCheckoutAsync answers as prepareReviewCheckout does for ${name}, with the same git calls`, async () => {
    const sync = make();
    const later = make();
    const expected = await outcome(() => prepareReviewCheckout({ ...COMMON, ...extra, git: sync.sync, exists: sync.exists }));
    const actual = await outcome(() => prepareReviewCheckoutAsync({ ...COMMON, ...extra, git: later.later, exists: later.exists }));
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
    assert.ok(sync.calls.length > 0);
  });
}

const REMOVE_CASES: [string, () => ReturnType<typeof gitWorld>][] = [
  ["a tree that is there", () => gitWorld({ present: true })],
  ["a tree that is already gone", () => gitWorld()],
  ["a tree that is still there after the remove", () => gitWorld({ present: true, keeps: true })],
  ["a git that refuses the remove", () => gitWorld({ present: true, fail: "worktree remove" })],
  ["a git that refuses to drop the ref", () => gitWorld({ fail: "update-ref" })],
];

for (const [name, make] of REMOVE_CASES) {
  test(`removeReviewCheckoutAsync answers as removeReviewCheckout does for ${name}, with the same git calls and ledger lines`, async () => {
    const sync = make();
    const later = make();
    const expected = await outcome(() => removeReviewCheckout({ ...COMMON, key: "", git: sync.sync, exists: sync.exists, record: sync.record as never }));
    const actual = await outcome(() => removeReviewCheckoutAsync({ ...COMMON, key: "", git: later.later, exists: later.exists, record: later.record as never }));
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
    assert.deepEqual(later.records, sync.records);
  });
}

test("removeReviewCheckoutAsync writes `removing` before the remove and `failed` after a remove that git refused", async () => {
  const world = gitWorld({ present: true, fail: "worktree remove" });
  const lines: string[] = [];
  const git = async (cmd: string, args: string[]) => { lines.push(`git ${args.join(" ")}`); return world.later(cmd, args); };
  const answer = await removeReviewCheckoutAsync({ ...COMMON, git, exists: world.exists, record: ((line: { event: string }) => { lines.push(line.event); }) as never });
  assert.match(String(answer), /could not remove \/reviews\/reviewer-12/);
  assert.deepEqual(lines.map((line) => line.split(" ")[0] === "git" ? "git" : line), ["removing", "git", "failed"]);
});

for (const [name, make] of [["a clean tree", () => gitWorld({ status: "" })], ["a tree with changes", () => gitWorld({ status: " M a.ts\n?? b.ts\n" })], ["a git that cannot read the tree", () => gitWorld({ fail: "status" })]] as const) {
  test(`uncommittedPathsOfAsync answers as uncommittedPathsOf does for ${name}`, async () => {
    const sync = make();
    const later = make();
    const expected = await outcome(() => uncommittedPathsOf("/reviews/reviewer-12", sync.sync));
    const actual = await outcome(() => uncommittedPathsOfAsync("/reviews/reviewer-12", later.later));
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
  });
}

const ORDER = { session: "reviewer-12", cause: "draft-awaiting-verdict", causeKey: "reviewer-12/draft-awaiting-verdict/pr-12/abc12345", trust: INSIDE };

const WORKSPACE = JSON.stringify({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } });

/** A herdr that opens a pane, and starts or refuses the agent. */
const herdrFor = (starts: string | Error) => (args: string[]): string => {
  if (args.includes("create")) return WORKSPACE;
  if (args.includes("start")) { if (starts instanceof Error) throw starts; return starts; }
  return "{}";
};

const SPAWN_CASES: [string, Record<string, unknown>, (args: string[]) => string, { token?: string | null; order?: Record<string, unknown> }][] = [
  ["an inside reviewer", {}, herdrFor("{}"), {}],
  ["an order that does not say whether its pull request is inside", {}, herdrFor("{}"), { order: { trust: undefined } }],
  ["an outside reviewer", {}, herdrFor("{}"), { order: { trust: OUTSIDE } }],
  ["a token that could not be minted", {}, herdrFor("{}"), { token: "the app key is unreadable" }],
  ["herdr refusing to open a pane", {}, () => { throw new Error("no room"); }, {}],
  ["herdr refusing to start the agent, which closes the workspace", {}, herdrFor(new Error("agent_not_ready: blocked during startup")), {}],
  ["herdr refusing to start the agent and the close", {}, (args) => { if (args.includes("close")) throw new Error("busy"); return herdrFor(new Error("no"))(args); }, {}],
  ["a reviewer that is already listed", { agents: [{ label: "reviewer-12", status: "working" }] }, herdrFor("{}"), {}],
];

for (const [name, extra, answer, { token = null, order = {} }] of SPAWN_CASES) {
  test(`spawnReviewerAsync answers as spawnReviewer does for ${name}, with the same herdr calls in the same order`, async () => {
    const sync = herdrRecording(answer);
    const later = herdrRecording(answer);
    const agents = (extra.agents ?? []) as { label: string; status: string }[];
    const tree = tempDir("spawn-async-tree-");
    const expected = await outcome(() => spawnReviewer({ ...ORDER, ...order }, agents, { run: sync.sync, cwd: tree, token: () => token }));
    const actual = await outcome(() => spawnReviewerAsync({ ...ORDER, ...order }, agents, { run: later.later, cwd: tree, token: async () => token }));
    assert.deepEqual(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
  });
}

/** A mint: a node script that writes the token into the directory it is told (`A11Y_APP_TOKEN_DIR`), and the environment it ran in to `env.json` beside it. */
function mintScript(body: string): string {
  const dir = tempDir("mint-script-");
  const script = join(dir, "mint.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = process.env.A11Y_APP_TOKEN_DIR;\nwriteFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify(Object.keys(process.env).sort()));\n${body}\n`);
  return script;
}

const APP = { appId: "123", keyPath: "/keys/app.pem", installationId: "456" };
const MINT_OK = `writeFileSync(join(dir, "reviewer.token"), "9999999999 ghs_token\\n");`;

const MINT_CASES: [string, string, boolean][] = [
  ["a mint that writes the token", MINT_OK, false],
  ["a mint that exits non-zero with a reason", `process.stderr.write("the key is expired\\n"); process.exit(1);`, false],
  ["a mint that exits non-zero with no reason", "process.exit(2);", false],
  ["a mint that writes no token", "", false],
  ["a token cache that is a file", MINT_OK, true],
];

for (const [name, body, cacheIsFile] of MINT_CASES) {
  test(`ensureReviewerTokenAsync answers as ensureReviewerToken does for ${name}`, async () => {
    const script = mintScript(body);
    const results: { answer: string | null; token: string | null }[] = [];
    for (const form of ["sync", "async"] as const) {
      const tree = tempDir("mint-tree-");
      if (cacheIsFile) { mkdirSync(join(tree, "node_modules", ".cache"), { recursive: true }); writeFileSync(join(tree, "node_modules", ".cache", "app-tokens"), "not a directory"); }
      const answer = form === "sync" ? ensureReviewerToken(tree, APP, { script }) : await ensureReviewerTokenAsync(tree, APP, { script });
      const dir = join(tree, "node_modules", ".cache", "app-tokens");
      const read = (file: string) => { try { return readFileSync(join(dir, file), "utf8"); } catch { return null; } };
      results.push({ answer: answer === null ? null : answer.replaceAll(tree, "<tree>"), token: read("reviewer.token") });
    }
    assert.deepEqual(results[1], results[0]);
  });
}

test("the mint is given a PATH and the app's identity and nothing else of this process's environment, in both forms", async () => {
  const dir = tempDir("mint-env-");
  const out = join(dir, "env.json");
  const script = join(dir, "mint.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env).filter((k) => k !== "PWD" && k !== "SHLVL" && k !== "_").sort()));\nwriteFileSync(join(process.env.A11Y_APP_TOKEN_DIR, "reviewer.token"), "9999999999 ghs_token\\n");`);
  process.env.A11Y_SECRET_OF_THE_BOARD = "do not pass";
  cleanups.push(() => { delete process.env.A11Y_SECRET_OF_THE_BOARD; });
  const seen: string[][] = [];
  for (const form of ["sync", "async"] as const) {
    const tree = tempDir("mint-env-tree-");
    assert.equal(form === "sync" ? ensureReviewerToken(tree, APP, { script }) : await ensureReviewerTokenAsync(tree, APP, { script }), null);
    seen.push(JSON.parse(readFileSync(out, "utf8")));
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.ok(!seen[1].includes("A11Y_SECRET_OF_THE_BOARD"), "the board's own environment does not reach the mint");
  assert.ok(seen[1].includes("A11Y_APP_KEY_PATH"));
});

test("ensureReviewerTokenAsync mints nothing for a reviewer with no app, and nothing for a token that is good", async () => {
  const tree = tempDir("mint-none-");
  assert.equal(await ensureReviewerTokenAsync(tree, null), null);
  const dir = join(tree, "node_modules", ".cache", "app-tokens");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reviewer.token"), "9999999999 ghs_kept\n");
  assert.equal(await ensureReviewerTokenAsync(tree, APP, { script: join(tree, "never-run.mjs") }), null);
  assert.equal(readFileSync(join(dir, "reviewer.token"), "utf8"), "9999999999 ghs_kept\n");
});

/** A tree and a clone on disk: the tree declares `declared`, the clone holds `held`. */
function keyedWorld(declared: string[], held: string[], manifest?: string) {
  const root = tempDir("keyed-");
  const tree = join(root, "tree");
  const clone = join(root, "clone");
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(clone, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "package.json"), manifest ?? JSON.stringify({ devDependencies: Object.fromEntries(declared.map((name) => [name, "1.0.0"])) }));
  for (const name of held) mkdirSync(join(clone, "node_modules", name), { recursive: true });
  return { root, tree, clone };
}

const INSTALL_CASES: [string, string[], string[], string | undefined, (cwd: string) => void | never][] = [
  ["a clone that holds every declared package", ["left-pad"], ["left-pad"], undefined, () => { throw new Error("not asked"); }],
  ["a manifest that cannot be read", [], [], "{ not json", () => { throw new Error("not asked"); }],
  ["an install that supplies the package", ["left-pad"], [], undefined, (cwd) => mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true })],
  ["an install that finishes without the package", ["left-pad"], [], undefined, () => undefined],
  ["an install that fails", ["left-pad"], [], undefined, () => { throw Object.assign(new Error("Command failed: pnpm"), { stderr: "ERR_PNPM_OFFLINE\n", stdout: "" }); }],
  ["an install that fails only for a package no registry holds", ["@a11ign/control"], [], undefined, () => { throw Object.assign(new Error("Command failed: pnpm"), { stdout: "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@a11ign%2Fcontrol: Not Found - 404", stderr: "" }); }],
];

for (const [name, declared, held, manifest, installs] of INSTALL_CASES) {
  test(`linkKeyedDependenciesAsync answers as linkKeyedDependencies does for ${name}, with the same install call`, async () => {
    const results: { answer: unknown; installs: string[][] }[] = [];
    for (const form of ["sync", "async"] as const) {
      const world = keyedWorld(declared, held, manifest);
      const calls: string[][] = [];
      const install = ({ cwd, args }: { cwd: string; args: string[] }) => { calls.push([cwd.replace(world.root, "<root>"), ...args]); installs(cwd); };
      const where = { path: world.tree, repoRoot: world.clone, fs: await import("node:fs") };
      const answer = form === "sync" ? linkKeyedDependencies({ ...where, install }) : await linkKeyedDependenciesAsync({ ...where, install: async (run) => install(run) });
      results.push({ answer: JSON.parse(JSON.stringify(answer ?? null).replaceAll(world.root, "<root>")), installs: calls });
    }
    assert.deepEqual(results[1], results[0]);
  });
}

const LISTING = (...labels: string[]) => JSON.stringify({ result: { workspaces: labels.map((label, i) => ({ label, workspace_id: `w${i}` })) } });

const CLOSE_CASES: [string, (args: string[]) => string][] = [
  ["one workspace", () => LISTING("reviewer-12")],
  ["no workspace under the label", () => LISTING("worker-1")],
  ["two workspaces under the label", () => LISTING("reviewer-12", "reviewer-12")],
  ["a workspace that will not close", (args) => { if (args.includes("close")) throw new Error("busy"); return LISTING("reviewer-12", "reviewer-12"); }],
  ["herdr not answering", () => { throw new Error("no herdr"); }],
];

for (const [name, answer] of CLOSE_CASES) {
  test(`closeReviewerAsync answers as closeReviewer does for ${name}, with the same calls and warnings`, async () => {
    const sync = herdrRecording(answer);
    const later = herdrRecording(answer);
    const warnedSync: string[] = [];
    const warnedLater: string[] = [];
    const expected = closeReviewer("reviewer-12", { run: sync.sync, warn: (line) => warnedSync.push(line) });
    const actual = await closeReviewerAsync("reviewer-12", { run: later.later, warn: (line) => warnedLater.push(line) });
    assert.equal(actual, expected);
    assert.deepEqual(later.calls, sync.calls);
    assert.deepEqual(warnedLater, warnedSync);
  });
}

/** A door script that exits with `code` after printing `message` on stderr. */
function door(code: number, message: string): string {
  const dir = tempDir("door-");
  const file = join(dir, "pr-review-verdict");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${message}' >&2\nenv | sort > '${join(dir, "env.txt")}'\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("runDoorAsync resolves for a door that posts, and runs it with a PATH, a HOME and the reviewer's environment only", async () => {
  const file = door(0, "posted");
  process.env.A11Y_SECRET_OF_THE_BOARD = "do not pass";
  cleanups.push(() => { delete process.env.A11Y_SECRET_OF_THE_BOARD; });
  await runDoorAsync(file, ["12", "convinced", "/v.md"], { A11Y_REVIEWER_SESSION: "reviewer-12" });
  const env = readFileSync(join(file, "..", "env.txt"), "utf8");
  assert.match(env, /A11Y_REVIEWER_SESSION=reviewer-12/);
  assert.doesNotMatch(env, /A11Y_SECRET_OF_THE_BOARD/);
});

test("runDoorAsync rejects with the door's exit status and stderr, which the port reads the reason from", async () => {
  const file = door(5, "pr-review-verdict: NOT POSTED. the head moved");
  await assert.rejects(runDoorAsync(file, ["12", "convinced", "/v.md"], {}), (err: any) => err.status === 5 && /the head moved/.test(err.stderr));
  assert.ok(existsSync(file));
});

test("runDoorAsync rejects with the reason as the message and no stderr for a door that cannot start, which the verdict poster reads as it reads the synchronous error", async () => {
  await assert.rejects(runDoorAsync("/no/such/door", [], {}), (err: any) => err.status === null && err.stderr === undefined && /ENOENT/.test(String(err.stderr ?? err.message)));
});
