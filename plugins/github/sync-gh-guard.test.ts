// no-token: gh -- the source is read off disk, and the code host is built over stand-in seams: nothing is spawned
//
// NO SYNCHRONOUS `gh` ON THE INSTANCE'S LOOP (A11-356 for the reads its sweeps make, A11-395 for the operations it makes on an event). A synchronous spawn holds the process still for as long as `gh` takes (755 holds of about a second in ten minutes, `reviews.ts:18` alone 35 times a minute), so
// every request, every queue write and every card waited behind it. A11-282 refused it in `src/` (`request-thread-guard.test.ts`); this refuses it in `plugins/`, in three ways:
//   1. no module under `plugins/` calls `spawnSync`, `execFileSync` or `execSync`, but those listed with the reason they never run on the instance's loop;
//   2. the reads the board's sweeps make (`ASYNCHRONOUS_READS`) and the operations it makes on an event (`ASYNCHRONOUS_EVENT_OPERATIONS`) never reach `deps.exec`: built over an `exec` that fails the test when `gh` is run through it, each answers through `deps.execAsync`;
//   3. the operations that still run `gh` through the synchronous runner (`STILL_SYNCHRONOUS`) are exactly the ones `code-host.ts` hands it to, so one cannot be added without a line here that says why, and one made asynchronous leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecResult } from "../../src/plugins/manifest.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { stackChecks } from "./checks.ts";
import { createCodeHost } from "./code-host.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** What `gh extension list` prints of the stacking extension. */
const LISTING = "gh stack  github/gh-stack  v0.2.1\n";
const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\s*\(/;

/** The modules under `plugins/` that spawn synchronously, each with why it never runs on the instance's loop. Paths from the checkout's root. */
const SPAWNING_MODULES: Readonly<Record<string, string>> = {
  "plugins/github/command-exec.ts": "the `deps.exec` of the CLI commands (`merge-flow-command.ts`, `stack-live-check-command.ts`), which run in a process of their own and hold nothing but themselves",
  "plugins/linear/key.ts": "the macOS keychain's `security`, once, as the Linear key is read before the instance listens; it is no `gh`",
};

/** The operations of the code host whose `gh` still runs through the synchronous runner `gh` of `code-host.ts`, each with why it never holds the instance's loop. Every other operation answers a promise (`ASYNCHRONOUS_READS`, `ASYNCHRONOUS_EVENT_OPERATIONS`). */
const STILL_SYNCHRONOUS: Readonly<Record<string, string>> = {
  armMerge: "no caller on the instance's loop: `CodeHostPort.armMerge` is declared in `ticket-port/port.ts` and nothing in ticket mode calls it; row mode arms through `arm-pr.ts` in a process of its own",
};

/** The reads the board's sweeps make on every pass, with the arguments to ask them with. They are the call sites that held the loop (reviews, open pull requests, replies, feedback, CI spend, dependency pulls, merged findings). */
const PULL = "https://github.com/owner/repo/pull/7";
const RUN = "https://github.com/owner/repo/actions/runs/1";
const ASYNCHRONOUS_READS: Readonly<Record<string, (host: ReturnType<typeof createCodeHost>) => Promise<unknown>>> = {
  readOwnLogin: (host) => host.readOwnLogin(),
  readPullFeedback: (host) => host.readPullFeedback(PULL, "worker"),
  readReviewState: (host) => host.readReviewState(PULL),
  readPullState: (host) => host.readPullState(PULL),
  openPullUrlsOf: (host) => host.openPullUrlsOf("owner/repo"),
  readReplies: (host) => host.readReplies(PULL, { since: 0, authors: ["worker"] }),
  readBranchCi: (host) => host.readBranchCi!("owner/repo", "main", new Set()),
  openDependencyPulls: (host) => host.openDependencyPulls!("owner/repo"),
  readMergedFindings: (host) => host.readMergedFindings!(PULL),
  // The reviewer's start claims a head with these two (A11-379, code host 3.0): the port awaits them, so the start holds the loop for neither.
  readReviewClaims: (host) => host.readReviewClaims("owner/repo", "abc"),
  writeReviewClaim: (host) => host.writeReviewClaim({ repository: "owner/repo", head: "abc", description: "claimed", environment: {} }),
};

/**
 * The operations the board makes on an event (A11-395, code host 4.0), with the arguments to ask them with. Each answers a promise and reaches GitHub through `deps.execAsync` alone: a stack merge, a rerun, an update, a close or a comment held the loop for as long as `gh` took.
 * Built over an `exec` that fails the test when `gh` is run through it.
 */
const ASYNCHRONOUS_EVENT_OPERATIONS: Readonly<Record<string, (host: ReturnType<typeof createCodeHost>) => Promise<unknown>>> = {
  readQueueFailure: (host) => host.readQueueFailure!(PULL, "0".repeat(40)),
  holdFromQueue: (host) => host.holdFromQueue!(PULL, true),
  readDefaultBranchRed: (host) => host.readDefaultBranchRed!("owner/repo"),
  readMergeFlow: (host) => host.readMergeFlow!("owner/repo"),
  readClosedWork: (host) => host.readClosedWork!(PULL),
  pullsNaming: (host) => host.pullsNaming!("NBF-1", ["owner/repo"]),
  sweepRetargets: (host) => host.sweepRetargets({ urls: [PULL], previous: {}, stacked: new Set(["feature/base"]), defaults: new Map(), log: () => undefined }),
  stackMergeFactsOf: (host) => host.stackMergeFactsOf!(PULL),
  requestStackMerge: (host) => host.requestStackMerge!({ repo: "owner/repo", number: 7 }),
  readCiRun: (host) => host.readCiRun!("owner/repo", 1),
  readCheckLog: (host) => host.readCheckLog(`${RUN}/job/2`),
  rerunFailedChecks: (host) => host.rerunFailedChecks([`${RUN}/job/2`]),
  rerunRuns: (host) => host.rerunRuns!([`${RUN}/job/2`]),
  updateBranch: (host) => host.updateBranch!(PULL, "abc"),
  closePull: (host) => host.closePull!(PULL, "closed"),
  commentOnPull: (host) => host.commentOnPull!(PULL, "a comment"),
};


function typescriptFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : typescriptFilesUnder(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("A11-356: no module under plugins/ spawns synchronously but those listed with the reason they never do so on the instance's loop", () => {
  const spawning = typescriptFilesUnder(join(CHECKOUT, "plugins")).filter((file) => SYNC_SPAWN.test(readFileSync(file, "utf8"))).map((file) => relative(CHECKOUT, file)).sort();
  assert.deepEqual(spawning.filter((file) => !(file in SPAWNING_MODULES)), [], "a module under plugins/ spawns synchronously: run the program through deps.execAsync, or list it with why it never runs on the instance's loop");
  assert.deepEqual(Object.keys(SPAWNING_MODULES).filter((file) => !spawning.includes(file)), [], "an exception that no longer holds: the module spawns nothing synchronously now");
});

test("A11-356, A11-395: the reads the board's sweeps make and the operations it makes on an event run gh through deps.execAsync, and never through deps.exec", async () => {
  const sync: string[][] = [];
  const asynchronous: string[][] = [];
  const refused: ExecResult = { status: 1, stdout: "", stderr: "gh: stand-in" };
  // A host of its own for each read: the code host does not ask a repository that just refused again for a few seconds (A11-365), and each read is to be seen asking.
  const hostOf = () => createCodeHost(fakePluginDeps({
    policy: corePolicy(() => ({ fields: "headRefOid,reviews", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] })),
    exec: (file, args) => { sync.push([file, ...args]); return refused; },
    execAsync: (file, args) => { asynchronous.push([file, ...args]); return Promise.resolve(refused); },
  }));
  for (const [name, call] of Object.entries({ ...ASYNCHRONOUS_READS, ...ASYNCHRONOUS_EVENT_OPERATIONS })) {
    const before = asynchronous.length;
    // A write the place refuses rejects with the refusal: the asking is what is seen.
    await call(hostOf()).catch(() => undefined);
    assert.ok(asynchronous.length > before, `${name} asks GitHub through deps.execAsync`);
  }
  assert.deepEqual(sync, [], "none of them ran a program through deps.exec, which holds the process still");
});

test("A11-356: the stacking rows of doctor, which ask GitHub for each repository a clone names, run gh and git through deps.execAsync", async () => {
  const sync: string[][] = [];
  const asynchronous: string[][] = [];
  const answer: ExecResult = { status: 0, stdout: "[]", stderr: "" };
  const deps = fakePluginDeps({
    clones: { repo: "/src/repo" },
    exec: (file, args) => { sync.push([file, ...args]); return answer; },
    execAsync: (file, args) => {
      asynchronous.push([file, ...args]);
      const stdout = file === "git" ? "git@github.com:owner/repo.git\n" : args[0] === "extension" ? LISTING : "[]";
      return Promise.resolve({ ...answer, stdout });
    },
  });
  const checks = await stackChecks({ stack: true }, deps);
  assert.ok(checks.length > 0, "the rows are made");
  assert.ok(asynchronous.some(([file, ...args]) => file === "gh" && args.join(" ") === "api repos/owner/repo/stacks"), "GitHub is asked about the repository the clone names");
  assert.deepEqual(sync, [], "nothing ran through deps.exec");
});

test("A11-356, A11-395: the operations that still run gh synchronously are the ones listed, each with why", () => {
  const text = readFileSync(join(CHECKOUT, "plugins/github/code-host.ts"), "utf8");
  const start = text.indexOf("  return {\n    repoViewArgs,");
  const body = text.slice(start, text.indexOf("\n  };\n}", start));
  const entries = body.split(/\n    (?=\w+: |\w+,)/).slice(1);
  const synchronous = entries.flatMap((entry) => {
    const name = /^(\w+)/.exec(entry)?.[1] ?? "";
    return /(?<![\w.])gh(?!\w)|ghRunner\(/.test(entry) ? [name] : [];
  }).sort();
  assert.deepEqual(synchronous, Object.keys(STILL_SYNCHRONOUS).sort(), "the code host hands the synchronous runner to an operation this list does not name, or an operation listed here is asynchronous now: update the list, and say why each remaining one is not an asynchronous read");
  assert.deepEqual(Object.keys({ ...ASYNCHRONOUS_READS, ...ASYNCHRONOUS_EVENT_OPERATIONS }).filter((name) => name in STILL_SYNCHRONOUS), [], "an operation is either asynchronous or listed as still synchronous");
});
