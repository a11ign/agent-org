// no-token: gh -- every `git`, `row-claim` and `herdr` call here is an injected seam (the claim's `exec`, the pane's `run`, the row's `run`/`post`); nothing imported reaches the real one
/**
 * agent-org#1169: A REBUILT WORKTREE IS NOT HANDED TO ITS WORKER UNTIL `typescript` RESOLVES FROM IT, behind `worktree.rebuildCheck` (shipped OFF).
 *
 * Driven through `deliver`, the production entry, with the REAL `spawnClaimer` over a fake host, so the claim and its release are the real ones. The claimed
 * tree's `node_modules` link resolves nothing: the fake host reports `node_modules/typescript/package.json` absent, which is what `existsSync` says through a
 * dangling link. The last real-filesystem case below makes that link on disk and asks the same question of it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT IS THE RECORDED ONE, as in `wake-spawn-worktree.test.ts`: the host file is set FIRST and the tool imported AFTER it.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-worktree-toolchain-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
// A SPAWN IS REFUSED BEFORE THE CLAIM WITHOUT THE ENGINEER BRIEF AT ITS ABSOLUTE PATH (#869): a one-line file, written here, not into the shared fixture.
writeFileSync(join(PROJECT, ".agent-org", "roles", "engineer.md"), "# engineer brief (a fixture's one line)\n");
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }], clones: { "agent-org": "/clones/agent-org" },
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { deliver, HOST_REPOS } = await import("./wake/fyi-queue.ts");
const { spawnClaimer, rebuildCheckOn, worktreeToolchainReason, sayToolchainRefusal, REBUILD_CHECK_SWITCH } = await import("./wake/release-line-and-seats.ts");
const { startedPanes } = await import("./packaging/started-pane.ts");
/** The row the tier check reads: an ordinary one, so the claim never reaches the real `gh` for its labels (`readRowForTier`'s default). */
const ORDINARY_ROW = () => ({ labels: [], body: "", title: "" });
type ToolchainGate = import("./wake/pull-request-spawn-orders.ts").ToolchainGate;

const ROW = 1169;
const ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: `engineers/ready-row-unclaimed/${ROW}`,
  title: "Rebuilt worktrees wait for typescript",
  prompt: `Ready row #${ROW} is unclaimed. Claim it with \`--session=<you>\`. <launch-directory>`,
};
const ROLE = "worker-4";
// THE CLAIMED TREE, as the spawn test pins it: the claim creates `wt-<row>` under the host's repositories.
const ROW_DIR = `${HOST_REPOS}/wt-${ROW}`;
const TYPESCRIPT = `${ROW_DIR}/node_modules/typescript/package.json`;
const NOBODY: { label: string; status: string }[] = [];

/**
 * A host whose claim lands the row and creates `ROW_DIR`, and whose `git` answers as a clean tree. `existing` is what the filesystem holds before the spawn:
 * the claimed tree's `package.json`, and optionally its resolved `typescript`.
 */
function fakeHost(existing: string[], install?: string) {
  const fs = new Set(existing);
  const events: string[] = [];
  const exec = (command: string, args: string[]) => {
    events.push(`${command} ${args.join(" ")}`);
    if (command === "git") {
      if (args[0] === "worktree") fs.add(args[3]);
      if (args[0] === "symbolic-ref") return { status: 1, output: "" };
      return { status: 0, output: "" };
    }
    if (args[1] === "claim") {
      fs.add(ROW_DIR);
      // The STARTED line as `claimLineFor` writes it: the install's outcome is its last segment, and only when the claim ran an install.
      const suffix = install === undefined ? "" : ` / ${install}`;
      return { status: 0, output: `STARTED -- #${ROW} is now in-progress / session:${ROLE} / worktree ${ROW_DIR}${suffix}\n` };
    }
    fs.delete(ROW_DIR);
    return { status: 0, output: `DECLINED -- #${ROW} is unclaimed again\n` };
  };
  return { exec, events, exists: (path: string) => fs.has(path) };
}

/** A recording herdr that answers `workspace create` as the live org does. */
function fakeHerdr() {
  const calls: string[] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (line.includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { calls, run };
}

function spawn(host: ReturnType<typeof fakeHost>, herdr: ReturnType<typeof fakeHerdr>, toolchain?: ToolchainGate) {
  return deliver([ORDER], NOBODY, [ROLE], {
    run: herdr.run,
    claimer: spawnClaimer({ exec: host.exec, exists: host.exists, readRow: ORDINARY_ROW }),
    toolchain,
    registerSpawn: () => {},
    record: () => {},
  });
}

/** The gate as production wires it, over the fake host's filesystem: the question the real check asks, answered by the fake's `exists`. */
function gateOver(host: ReturnType<typeof fakeHost>, written: string[]): ToolchainGate {
  return {
    reason: (tree, install) => worktreeToolchainReason(tree, { exists: host.exists, install }),
    refused: (_order, reason) => { written.push(reason); },
  };
}

test("#1169 REFUSAL: a claimed tree whose node_modules resolves no typescript is not handed to its worker; the refusal names it, the claim is released, no pane opens", () => {
  const host = fakeHost([`${ROW_DIR}/package.json`]);
  const herdr = fakeHerdr();
  const written: string[] = [];
  const got = spawn(host, herdr, gateOver(host, written));

  assert.deepEqual(got.sent, [], JSON.stringify(got));
  assert.equal(got.refused.length, 1, JSON.stringify(got));
  assert.match(got.refused[0], /no spawn: `typescript` does not resolve from .*node_modules: /, JSON.stringify(got));
  assert.equal(written.length, 1, "the refusal is handed to the row writer once");
  assert.match(written[0], /`typescript` does not resolve from/);
  assert.deepEqual(herdr.calls.filter((c) => c.includes("workspace create")), [], "no pane is opened in the tree");
  assert.ok(host.events.some((e) => e.includes("row-claim.ts decline")), `the claim is released: ${host.events.join(" | ")}`);
});

test("#1169 OFF: with no gate passed (`worktree.rebuildCheck` off), the same tree starts its worker, as today", () => {
  const host = fakeHost([`${ROW_DIR}/package.json`]);
  const herdr = fakeHerdr();
  const got = spawn(host, herdr, undefined);

  assert.deepEqual(got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`], JSON.stringify(got));
  assert.equal(herdr.calls.filter((c) => c.includes("workspace create")).length, 1, "the pane is opened, as before");
  assert.ok(!host.events.some((e) => e.includes("row-claim.ts decline")), "and the claim is kept");
});

test("#1169 POSITIVE CONTROL: with typescript resolved from the claimed tree, the gate passes and the worker starts", () => {
  const host = fakeHost([`${ROW_DIR}/package.json`, TYPESCRIPT]);
  const herdr = fakeHerdr();
  const written: string[] = [];
  const got = spawn(host, herdr, gateOver(host, written));

  assert.deepEqual(got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`], JSON.stringify(got));
  assert.deepEqual(written, [], "nothing is refused, so nothing is written on the row");
});

test("#1169 the refusal is written on the row once for its cause, and not again on the next tick", () => {
  const posted: string[][] = [];
  let comments = "";
  const write = sayToolchainRefusal({
    run: () => comments,
    post: (args) => { posted.push(args); return ""; },
    warn: (line) => { throw new Error(line); },
  });
  const reason = "`typescript` does not resolve from /x/node_modules";

  write(ORDER, reason);
  assert.equal(posted.length, 1, "the first refusal is written");
  assert.deepEqual(posted[0].slice(0, 3), ["issue", "comment", String(ROW)]);
  assert.match(posted[0][4], /^<!-- worktree-not-ready:1169:[0-9a-f]{8} -->\n/, "the body opens with the marker");
  assert.match(posted[0][4], /NOT started this tick: its worktree is not ready for a worker\.\*\* `typescript` does not resolve/);

  // THE NEXT TICK FINDS THE MARKER ON THE ROW: the cause is written once.
  comments = `${JSON.stringify([1, "bot", "2026-10-12T00:00:00Z", true])}\n`;
  write(ORDER, reason);
  assert.equal(posted.length, 1, "no second comment for the same cause");
});

test("#1169 a real `node_modules` link that resolves nothing is named on disk; a tree with typescript, or with no package.json, is not refused", () => {
  const dangling = join(SCRATCH, "dangling-tree");
  mkdirSync(dangling);
  writeFileSync(join(dangling, "package.json"), "{}");
  symlinkSync(join(SCRATCH, "no-such-install"), join(dangling, "node_modules"));
  assert.equal(existsSync(join(dangling, "node_modules")), false, "existsSync reads the dangling link as absent");
  assert.match(worktreeToolchainReason(dangling) ?? "", /^`typescript` does not resolve from .*node_modules: /);

  const installed = join(SCRATCH, "installed-tree");
  mkdirSync(join(installed, "node_modules", "typescript"), { recursive: true });
  writeFileSync(join(installed, "package.json"), "{}");
  writeFileSync(join(installed, "node_modules", "typescript", "package.json"), "{}");
  assert.equal(worktreeToolchainReason(installed), null);

  const bare = join(SCRATCH, "bare-tree");
  mkdirSync(bare);
  assert.equal(worktreeToolchainReason(bare), null, "no package.json, no toolchain to resolve");
});

test("#1169 (agent-org#1265) a refusal names the claim's install when it failed: `install failed: <first error line>` is in the reason and on the row", () => {
  const line = "install failed: ERR_PNPM_FETCH_404 GET https://registry.example/typescript: Not Found";
  const host = fakeHost([`${ROW_DIR}/package.json`], line);
  const herdr = fakeHerdr();
  const written: string[] = [];
  const got = spawn(host, herdr, gateOver(host, written));

  assert.deepEqual(got.sent, [], JSON.stringify(got));
  assert.equal(got.refused.length, 1, JSON.stringify(got));
  assert.ok(got.refused[0].includes(`the claim's install: ${line}`), `the refusal carries the install line: ${JSON.stringify(got)}`);
  assert.ok(written[0].includes(`the claim's install: ${line}`), `the row carries the install line: ${written[0]}`);
  assert.ok(host.events.some((e) => e.includes("row-claim.ts decline")), `the claim is still released: ${host.events.join(" | ")}`);
});

test("#1169 (agent-org#1265) a refusal says `no install ran` when the claim's STARTED line carries no install outcome", () => {
  const host = fakeHost([`${ROW_DIR}/package.json`]);
  const herdr = fakeHerdr();
  const written: string[] = [];
  const got = spawn(host, herdr, gateOver(host, written));

  assert.equal(got.refused.length, 1, JSON.stringify(got));
  assert.ok(got.refused[0].includes("the claim's install: no install ran"), `the refusal says no install ran: ${JSON.stringify(got)}`);
  assert.ok(written[0].includes("the claim's install: no install ran"), `the row says no install ran: ${written[0]}`);
});

test("#1169 `worktree.rebuildCheck` is read from decisions.json and is OFF unless it is `true`", () => {
  const file = join(SCRATCH, "decisions.json");
  assert.equal(REBUILD_CHECK_SWITCH, "worktree.rebuildCheck");
  assert.equal(rebuildCheckOn(file), false, "an absent file is OFF");
  writeFileSync(file, JSON.stringify({ [REBUILD_CHECK_SWITCH]: false }));
  assert.equal(rebuildCheckOn(file), false, "false is OFF");
  writeFileSync(file, JSON.stringify({ [REBUILD_CHECK_SWITCH]: true }));
  assert.equal(rebuildCheckOn(file), true, "true is ON");
});
