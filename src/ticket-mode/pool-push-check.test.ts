// no-token: gh -- herdr, the tracker, git and the clock are all injected fakes; nothing is spawned and no push leaves the machine
// A11-346: a worker's hand-back on lost push access is checked by the board with a push before it reaches a person; on 2026-10-27 A11-229's worker claimed it from a 403 and `permissions.push=false`, and a push from its checkout worked 35 minutes later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { herdrName } from "./pool.ts";
import { poolFixture } from "./pool-fixture.ts";
import { ACCESS_EVIDENCE_SENTENCE, ESCALATION_RULE } from "./escalation.ts";
import { claimsLostPush, gitErrorText, PUSH_ERROR_CHARS, PUSH_TRIES } from "./pool-push-check.ts";
import { logOf } from "./queue/run-log.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";
import { briefText } from "./worker-files.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { Git } from "./worktree.ts";

const KEY = "NBF-1";
const REPO = "nbl-ui-netbox";
const CLAIM = { kind: "needs-human", escalation: "access", reason: "The workers lost push access to a11ign/announcement-emulator: git push got a 403 and gh api repos/a11ign/announcement-emulator returns permissions.push=false." };
const REMOTE = "remote: Permission to a11ign/announcement-emulator.git denied to the-workers[bot].\nfatal: unable to access 'https://github.com/a11ign/announcement-emulator.git/': The requested URL returned error: 403";
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A git whose pushes are answered by `push` (the nth push, from 1: undefined takes it, a string refuses it with those words), recording every call. */
function pushingGit(push: (n: number) => string | undefined = () => undefined) {
  const calls: { cwd: string; args: string[] }[] = [];
  let pushes = 0;
  /** The branch every checkout is on, as `git rev-parse --abbrev-ref HEAD` says; set to the ticket's once the run exists. */
  const head = { branch: "" };
  const git: Git = async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "rev-parse") return `${head.branch}\n`;
    if (args[0] !== "push") return "";
    pushes += 1;
    const refusal = push(pushes);
    if (refusal !== undefined) throw Object.assign(new Error("Command failed: git push"), { stderr: refusal });
    return "";
  };
  return { git, head, calls, pushes: () => calls.filter(({ args }) => args[0] === "push") };
}

/** NBF-1's run with a checkout of `REPO`, whose worker ends `needs-human` on `outcome`, over a git that pushes as `push` says. */
async function handedBack(push?: (n: number) => string | undefined, outcome: Record<string, unknown> = CLAIM, { checkout = true, branch }: { checkout?: boolean; branch?: string } = {}) {
  const made = poolFixture({ keys: [KEY], max: 1 });
  const fake = pushingGit(push);
  const pool = made.restart({ git: fake.git });
  fake.head.branch = branch ?? made.entry(KEY).ticket.branch;
  await pool.tick();
  made.status.set(herdrName(KEY), "working");
  await pool.tick();
  if (checkout) {
    mkdirSync(join(ticketFolder(made.settings, KEY), REPO), { recursive: true });
    writeFileSync(join(ticketFolder(made.settings, KEY), REPO, ".git"), "gitdir: elsewhere\n");
  }
  writeFileSync(join(ticketDir(made.settings, KEY), "outcome.json"), JSON.stringify(outcome));
  made.status.set(herdrName(KEY), "idle");
  await pool.tick();
  await settled();
  const log = () => logOf(made.store.get(), KEY);
  const prompts = () => made.herdr.calls.filter((args) => args.includes("prompt"));
  return { ...made, pool, fake, log, prompts };
}

test("a hand-back on lost push access whose push the board makes work raises no card: the worker is woken with 'access is fine', the check is logged, and the board pushed the ticket's branch (dry run first)", async () => {
  const run = await handedBack();
  assert.equal(run.entry(KEY).phase, "running", "the run is not ended");
  assert.equal(run.entry(KEY).outcome, undefined, "and holds no hand-back");
  assert.notEqual(runStatus(run.entry(KEY)), "needs-you");
  assert.equal(run.log().some((event) => event.kind === "needs-you" || event.kind === "finished"), false, "no Needs-you event");
  const pushes = run.fake.pushes();
  assert.deepEqual(pushes.map(({ args }) => args), [["push", "--dry-run", "--no-verify", "origin", `HEAD:refs/heads/${run.entry(KEY).ticket.branch}`], ["push", "--no-verify", "origin", `HEAD:refs/heads/${run.entry(KEY).ticket.branch}`]]);
  assert.ok(pushes.every(({ cwd }) => cwd === join(ticketFolder(run.settings, KEY), REPO)), "from the run's own checkout");
  const checks = run.log().filter((event) => event.kind === "push-check");
  assert.deepEqual(checks.map((event) => event.kind === "push-check" ? [event.step, event.detail] : null), [["passed", REPO]]);
  const told = run.prompts();
  assert.equal(told.length, 1, "the worker is woken once");
  assert.match(told[0].at(-1) ?? "", /access is fine, carry on/);
});

test("a hand-back whose first push is refused and whose retry works is also a pass: the pair is tried twice", async () => {
  const run = await handedBack((n) => (n === 1 ? REMOTE : undefined));
  assert.equal(run.entry(KEY).phase, "running");
  assert.deepEqual(run.fake.pushes().map(({ args }) => args.includes("--dry-run")), [true, true, false]);
  assert.equal(run.prompts().length, 1);
});

test("a hand-back whose push the board finds refused twice keeps the card, quotes git's error in the reason and the log, and wakes nobody", async () => {
  const run = await handedBack(() => REMOTE);
  const outcome = run.entry(KEY).outcome as Extract<Outcome, { kind: "needs-human" }>;
  assert.deepEqual([run.entry(KEY).phase, outcome.kind, outcome.escalation], ["finished", "needs-human", "access"]);
  assert.match(outcome.reason, /permissions\.push=false/, "the worker's words stay");
  assert.ok(outcome.reason.includes(`${REPO}: ${REMOTE}`), "git's own words, the remote: lines whole, follow");
  assert.equal(runStatus(run.entry(KEY)), "needs-you");
  assert.equal(run.fake.pushes().length, PUSH_TRIES, "the dry run was refused twice and no real push was made");
  const failed = run.log().filter((event) => event.kind === "push-check");
  assert.deepEqual(failed.map((event) => event.kind === "push-check" ? event.step : null), ["failed"]);
  assert.ok(failed.some((event) => event.kind === "push-check" && event.detail.includes("denied to the-workers[bot]") && event.detail.includes("returned error: 403")), "the log holds the error text");
  assert.equal(run.prompts().length, 0);
});

test("a hand-back that is not about pushing, and one from a run with no checkout, are not checked", async () => {
  const money = await handedBack(undefined, { kind: "needs-human", escalation: "access", reason: "The ticket asks for a paid plan, which needs money." });
  assert.equal(money.fake.calls.length, 0);
  assert.equal(money.entry(KEY).phase, "finished");
  const bare = await handedBack(undefined, CLAIM, { checkout: false });
  assert.equal(bare.fake.calls.length, 0);
  assert.equal(bare.entry(KEY).phase, "finished");
  assert.equal(bare.log().some((event) => event.kind === "push-check"), false);
});

test("a checkout left on another branch holds none of the ticket's work: nothing is pushed from it and the hand-back stands as it was", async () => {
  const run = await handedBack(undefined, CLAIM, { branch: "somebody-elses-branch" });
  assert.equal(run.fake.pushes().length, 0);
  assert.equal(run.entry(KEY).phase, "finished");
  assert.equal(run.log().some((event) => event.kind === "push-check"), false);
});

test("a hand-back that only mentions a credential or permission in passing is not read as a refused push", () => {
  const access = (reason: string): Outcome => ({ kind: "needs-human", escalation: "access", reason });
  assert.equal(claimsLostPush(access("I did not push because the commit holds a credential")), false);
  assert.equal(claimsLostPush(access("needs permission to push to the protected branch")), false);
});

test("a worker told access is fine that hands back on it again gets its card: the board wakes it once", async () => {
  const run = await handedBack();
  assert.equal(run.entry(KEY).phase, "running");
  writeFileSync(join(ticketDir(run.settings, KEY), "outcome.json"), JSON.stringify({ ...CLAIM, reason: `${CLAIM.reason} Still.` }));
  run.status.set(herdrName(KEY), "idle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.pool.tick();
  await settled();
  assert.equal(run.entry(KEY).phase, "finished");
  assert.equal(run.prompts().length, 1, "no second wake");
  assert.equal(run.fake.pushes().length, 2, "and no second push");
});

test("claimsLostPush reads an access hand-back about a refused push, and nothing else", () => {
  const access = (reason: string): Outcome => ({ kind: "needs-human", escalation: "access", reason });
  assert.equal(claimsLostPush(access("git push got a 403")), true);
  assert.equal(claimsLostPush(access("money, access or security — gh api shows permissions.push=false")), true);
  assert.equal(claimsLostPush(access("a push notification service needs a paid plan")), false, "a push that is not refused");
  assert.equal(claimsLostPush(access("the ticket needs a secret for staging")), false);
  assert.equal(claimsLostPush({ kind: "needs-human", escalation: "outward", reason: "git push got a 403" }), false, "another item");
  assert.equal(claimsLostPush({ kind: "checked", reason: "git push got a 403" }), false);
});

test("gitErrorText keeps the remote: lines whole and cuts only a very long error", () => {
  assert.equal(gitErrorText(Object.assign(new Error("Command failed"), { stderr: `${REMOTE}\n` })), REMOTE);
  assert.equal(gitErrorText(new Error("spawn git ENOENT")), "spawn git ENOENT");
  assert.equal(gitErrorText(Object.assign(new Error("x"), { stderr: "remote: x\n".repeat(1000) })).length, PUSH_ERROR_CHARS);
});

test("the role text every worker is briefed with names permissions.push as not evidence, and says to retry a push once and quote the full remote: lines", () => {
  assert.match(ACCESS_EVIDENCE_SENTENCE, /`permissions\.push`[^.]*reads false for every repository under an App installation token, so it is not evidence/);
  assert.match(ACCESS_EVIDENCE_SENTENCE, /Retry a failed push once/);
  assert.match(ACCESS_EVIDENCE_SENTENCE, /full `remote:` lines/);
  assert.ok(ESCALATION_RULE.includes(ACCESS_EVIDENCE_SENTENCE));
  const brief = briefText({ ticket: { key: KEY, title: "t", description: "", url: "https://example.test/NBF-1", labels: [], branch: "nbf-1" } as never, folder: "/f", ticketDir: "/d", attachments: [], clones: {}, worktreeCommand: "wt", prOpenCommand: "pr" });
  assert.ok(brief.includes(ACCESS_EVIDENCE_SENTENCE), "the worker's brief carries it");
});
