// no-token: none -- herdr, gh, git, pnpm and tailscale are stub programs first on PATH, each appending its arguments to a log; nothing reaches GitHub, herdr or the network
//
// A11-379: STARTING A REVIEWER HOLDS THE BOARD'S LOOP FOR NO SPAWN. A start held it about nine times, about 10 s in all, because the port's `herdr`, `git`, install, token mint and claim calls were synchronous spawns on
// the board's thread. the scenario script written below builds the REAL port (`atomicReviewerPort`) over the real board helpers, the real async gate steps and the GitHub plugin's real code host over `realExecAsync`, in a
// process of its own (the ledger sees only the modules Node loads itself: the test runner's bundle holds what it imported when it loaded, as `blocking-ledger.test.ts` found for its probe), installs the blocking ledger (`createBlockingLedger`, which counts every `spawnSync`, `execFileSync` and `execSync` of the process), makes
// the calls and prints what the ledger counted. This puts stub programs first on PATH and asserts: the ledger is empty, the answers are the real ones, and the stubs' logs show that every program was run, so an empty ledger
// cannot pass because nothing ran. A control run makes the synchronous `git` the port used to run and shows the ledger counts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { realExecAsync } from "../../src/plugins/real-seams.ts";
import { REPO } from "../../src/project-identity.ts";

const OWNER = REPO.split("/")[0];
const CLONE_NAME = "mirror";
const PR = `https://github.com/${OWNER}/${CLONE_NAME}/pull/7`;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const LABEL = "reviewer-mirror-7";
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleOf = (path: string): string => JSON.stringify(pathToFileURL(join(CHECKOUT, path)).href);

/**
 * THE SCENARIO, as the script a child process runs (written to the test's directory, as `blocking-ledger.test.ts` writes its probe). It builds the REAL port (`atomicReviewerPort`) over the real board helpers, the real async gate steps and the
 * GitHub plugin's real code host over `realExecAsync`, installs the ledger, makes the calls its mode names and prints one JSON line: the answers, what the ledger counted, and the heads the port recorded. `control` makes the synchronous `git` the
 * port used to run instead, to show the ledger counts a spawn made by name from a module this process loaded. Its argument is the JSON of the config `runScenario` builds.
 */
const SCENARIO = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { createFakeCodeHost } = await import(${moduleOf("src/plugins/fakes/code-host.ts")});
const { fakePluginDeps } = await import(${moduleOf("src/plugins/fakes/deps.ts")});
const { realExecAsync } = await import(${moduleOf("src/plugins/real-seams.ts")});
const { reviewingHelpers } = await import(${moduleOf("src/plugins/reviewing-helpers.ts")});
const { createBlockingLedger } = await import(${moduleOf("src/ticket-mode/blocking-ledger.ts")});
const { loadReviewerGate } = await import(${moduleOf("src/ticket-mode/reviewer-port.ts")});
const { ensureReviewerTokenAsync, prepareReviewCheckoutAsync, removeReviewCheckoutAsync } = await import(${moduleOf("src/wake/reviewer-start-async.ts")});
const { defaultGit } = await import(${moduleOf("src/wake/reviewer-tokens-and-checkouts.ts")});
const { createCodeHost } = await import(${moduleOf("plugins/github/code-host.ts")});
const { codexTrustSeam } = await import(${moduleOf("plugins/atomic-reviewer/codex-trust.ts")});
const { atomicReviewerPort } = await import(${moduleOf("plugins/atomic-reviewer/port.ts")});

const config = JSON.parse(process.argv[2]);
const { pr, head, label } = config;
await loadReviewerGate();
const seeded = createFakeCodeHost("worker-bot");
seeded.seedPull(config.owner + "/" + config.cloneName, 7, { head, state: "open", trust: "inside", settled: true, reviews: [] });
const state = await seeded.readReviewState(pr);
const refused = () => { throw new Error("a synchronous exec was reached"); };
const deps = fakePluginDeps({ exec: refused, execAsync: realExecAsync, env: { CODEX_HOME: join(config.root, "codex") }, clones: { [config.cloneName]: config.clone }, log: () => undefined });
const codeHost = { ...createCodeHost(deps), peekReviewState: () => state };
const heads = new Map();
const helpers = reviewingHelpers({ session: "tickets", run: refused, codeHost: () => codeHost, clones: { [config.cloneName]: config.clone }, instance: "work", heads });
const port = atomicReviewerPort(helpers, {
  codexTrust: codexTrustSeam(deps),
  checkout: (options) => prepareReviewCheckoutAsync({ ...options, root: config.treesRoot }),
  removeCheckout: (options) => removeReviewCheckoutAsync({ ...options, root: config.treesRoot, record: () => undefined }),
  checkoutOf: (seat) => join(config.treesRoot, seat),
  // The gate's own path of a seat's tree is under the real home, so the retire's check that it exists would skip its git status: the stub git answers it, and the tree removed is the one under treesRoot.
  exists: () => true,
  mint: (tree) => ensureReviewerTokenAsync(tree, { appId: "1", keyPath: "/stub/key.pem" }, { script: config.mint }),
});
if (config.mode === "calls") {
  heads.set(label, head);
  mkdirSync(join(config.treesRoot, label), { recursive: true });
  writeFileSync(join(config.dir, "listing.json"), JSON.stringify({ result: { workspaces: [{ label, workspace_id: "w1", agent_status: "idle" }] } }));
}
const ledger = createBlockingLedger({ err: () => undefined });
const uninstall = ledger.install();
const answers = {};
try {
  if (config.mode === "start") answers.start = await port.start({ pr, head });
  if (config.mode === "calls") {
    answers.live = await port.live({ pr, head });
    answers.settled = await port.settled({ pr, head });
    answers.listedPulls = await port.listedPulls();
    answers.close = await port.close({ pr, head });
    answers.retire = await port.retire(pr);
  }
  if (config.mode === "control") answers.git = defaultGit("git", ["status"]);
} finally {
  uninstall();
}
process.stdout.write(JSON.stringify({ answers, worst: ledger.worst(100), heads: [...heads] }) + "\\n");
`;

/** A shell stub for `name`: it appends its program name and arguments to the log, then runs `body`. */
function stub(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(file, 0o755);
}

/** The stub programs a reviewer start runs, and the mint script, in a directory of their own. */
function stubPrograms(root: string): { bin: string; log: string; mint: string } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  stub(bin, "herdr", `case "$*" in
  *"workspace list"*) if [ -f "$STUB_DIR/listing.json" ]; then cat "$STUB_DIR/listing.json"; else echo '{"result":{"workspaces":[]}}'; fi ;;
  *"workspace create"*) echo '{"result":{"root_pane":{"pane_id":"w1:p1"},"workspace":{"workspace_id":"w1"}}}' ;;
  *) echo '{"type":"ok"}' ;;
esac`);
  // The claim's first read lists nothing; every later read lists this instance's own claim, as GitHub does once the claim is written.
  stub(bin, "gh", `case "$*" in
  *"--method"*) ;;
  *) n=$(cat "$STUB_DIR/reads" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_DIR/reads"
     if [ "$n" -gt 0 ]; then printf '1\\t%s\\tclaimed by work at %s, lease 60 min\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"; fi ;;
esac`);
  // git: a worktree add makes the tree with a manifest that declares one package; rev-parse answers the head and the clone's common dir; status is clean.
  stub(bin, "git", `case "$*" in
  *"worktree add"*) tree=""; prev=""; for arg in "$@"; do if [ "$prev" = "--detach" ]; then tree="$arg"; fi; prev="$arg"; done
     mkdir -p "$tree" && echo '{"devDependencies":{"left-pad":"1.0.0"}}' > "$tree/package.json" ;;
  *"worktree remove"*) for last; do :; done; rm -rf "\${last:?}" ;;
  *"--git-common-dir"*) echo "$STUB_CLONE/.git" ;;
  *"rev-parse --verify"*|*"rev-parse HEAD"*) echo "${HEAD}" ;;
  *) ;;
esac`);
  // pnpm: the install makes the package the manifest declares, in the tree it runs in.
  stub(bin, "pnpm", "mkdir -p node_modules/left-pad");
  stub(bin, "tailscale", "");
  const mint = join(root, "mint.mjs");
  writeFileSync(mint, `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(join(process.env.A11Y_APP_TOKEN_DIR, "reviewer.token"), "stub-token");\n`);
  return { bin, log, mint };
}

/** What the scenario printed: the answers, what the ledger counted, and the heads the port recorded. */
type Scenario = { answers: Record<string, unknown>; worst: { site: string; program: string; count: number }[]; heads: [string, string][] };

/** Runs the scenario of `mode` in a process of its own, with the stub programs first on PATH, and answers what it printed and the stubs' log. */
async function runScenario(mode: "start" | "calls" | "control"): Promise<{ scenario: Scenario; calls: string[]; treesRoot: string }> {
  const root = tmpDir(`start-holds-no-loop-${mode}-`);
  const { bin, log, mint } = stubPrograms(root);
  const script = join(root, "scenario.mjs");
  writeFileSync(script, SCENARIO);
  const dir = join(root, "stub-state");
  const clone = join(root, "clone");
  for (const path of [dir, join(clone, ".git"), join(clone, "node_modules")]) mkdirSync(path, { recursive: true });
  const treesRoot = join(root, "reviews");
  const config = { mode, root, mint, treesRoot, clone, dir, pr: PR, head: HEAD, label: LABEL, owner: OWNER, cloneName: CLONE_NAME };
  // `npm_execpath` is the real pnpm when the suite runs under `pnpm exec`, and the install would run it: emptied, the install is `pnpm` on PATH, which is the stub.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "", AGENT_ORG_HOST: process.env.AGENT_ORG_HOST ?? "", STUB_LOG: log, STUB_DIR: dir, STUB_CLONE: clone, npm_execpath: "" };
  const ran = await realExecAsync(process.execPath, [script, JSON.stringify(config)], { env, withoutEnv: Object.keys(process.env).filter((name) => !(name in env)), timeoutMs: 60_000 });
  assert.equal(ran.status, 0, `the scenario ran: ${ran.stderr}`);
  const printed = ran.stdout.trim().split("\n").at(-1) ?? "";
  return { scenario: JSON.parse(printed) as Scenario, calls: readFileSync(log, "utf8").split("\n").filter(Boolean), treesRoot };
}

const reached = (calls: readonly string[], program: string, text: string): boolean => calls.some((call) => call.startsWith(`${program} `) && call.includes(text));

test("A11-379: the blocking ledger counts the synchronous `git` the port used to run (the control for the tests below)", async () => {
  const { scenario, calls } = await runScenario("control");
  assert.deepEqual(scenario.worst.map(({ program, count }) => [program, count]), [["git", 1]], "the gate's synchronous `git` made one spawn, and it was counted");
  assert.ok(reached(calls, "git", "status"), "and it ran the stub");
});

test("A11-379: starting a reviewer through the real port makes no synchronous spawn, and reaches herdr, git, the install, the claim, the mint and the prompt", async () => {
  const { scenario, calls, treesRoot } = await runScenario("start");
  assert.deepEqual(scenario.answers.start, { label: LABEL }, "the start answered its label");
  assert.deepEqual(scenario.worst, [], "the blocking ledger counted no synchronous spawn");
  for (const [program, text] of [["herdr", "workspace list"], ["git", "fetch --quiet origin"], ["git", "worktree add"], ["pnpm", "install"], ["git", "--git-common-dir"], ["gh", "--method POST"],
    ["herdr", "workspace create"], ["herdr", "agent start"], ["herdr", "agent prompt"]]) {
    assert.ok(reached(calls, program, text), `${program} ${text} ran: ${calls.join(" | ")}`);
  }
  assert.ok(calls.filter((call) => call.startsWith("gh ") && !call.includes("--method")).length >= 2, "the claim was read, written and read back");
  assert.deepEqual(scenario.heads, [[LABEL, HEAD]], "the port recorded the head its reviewer was started for");
  assert.ok(existsSync(join(treesRoot, LABEL, "node_modules", "left-pad")), "the install ran in the tree");
});

test("A11-379: live, settled, close, retire and listedPulls through the real port make no synchronous spawn either", async () => {
  const { scenario, calls, treesRoot } = await runScenario("calls");
  assert.deepEqual(scenario.answers, { live: true, settled: "ended", listedPulls: [PR], close: { state: "closed" }, retire: { retired: true, report: null } });
  assert.deepEqual(scenario.worst, [], "the blocking ledger counted no synchronous spawn");
  for (const [program, text] of [["herdr", "workspace list"], ["herdr", "workspace close"], ["git", "status"], ["git", "worktree remove"], ["git", "update-ref -d"]]) {
    assert.ok(reached(calls, program, text), `${program} ${text} ran: ${calls.join(" | ")}`);
  }
  assert.equal(existsSync(join(treesRoot, LABEL)), false, "the retired tree is gone");
});
