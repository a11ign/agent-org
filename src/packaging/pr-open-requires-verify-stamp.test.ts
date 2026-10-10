// no-token: gh -- `main` is handed `run`, `git`, `runAcceptance`, `prHead` and `verifyStamp` as seams, the gate is handed `run`, and the project is a throwaway git repository
/**
 * a11ign/a11ign#3215: A PULL REQUEST IS MARKED READY ONLY ON A GREEN VERIFY STAMP FOR ITS HEAD.
 *
 * Two doors make a pull request ready, and both read the stamp `pnpm run verify` writes: `pr:open` (a create without `--draft`) and the
 * gate's `gh pr ready` after a `convinced` verdict. A DRAFT opens on a passing body alone (the row's decision, asserted both ways).
 *
 * THE PROJECT HERE IS A FIXTURE, and says so: a git repository whose `verify` script answers `--check` as the real one does (exit 0 or 1,
 * `  - <reason>` lines, the head, the body's hash and the steps). What is under test is the reading and the two doors, not the wording of a
 * project's reasons, which the project's own tests pin. The stamp lives where git puts a per-worktree file, and the author's tree is a LINKED
 * worktree, so "the gate reads a stamp it did not write, in a tree it is not in" is the case the gate meets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { EXIT_NOTHING_SENT, main } from "../pr-open.ts";
import { decide, performActions } from "../work-gate.ts";
import { VERIFY_STATE, readVerifyStamp, verifyDeclaration, withVerifyStamps, worktreeAtHead } from "../verify-stamp.ts";

const STEPS = ["changed", "ts", "agentOrg"];
const ACCEPTANCE = 'Acceptance: node -e "process.exit(0)"';
const CLOSES = "Closes: none — a reason";
const BODY = [ACCEPTANCE, CLOSES, "Mutation: none -- the fixture changes no test"].join("\n\n");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
// agent-org#519: the body is no longer an acceptance source, so the open's diff ADDS this file and `readFile` hands back the body's text as its content.
const ACCEPTANCE_FILE = ".acceptance/agent~x.md";

/** The project's `verify --check`: the contract `verify-stamp.ts` reads, in a script of its own so the spawn is the real one. */
const VERIFY_MJS = `
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const file = process.argv.find((arg) => arg.startsWith("--draft-body="))?.slice("--draft-body=".length);
const body = file ? readFileSync(file, "utf8") : null;
const head = git("rev-parse", "HEAD");
const path = git("rev-parse", "--path-format=absolute", "--git-path", "verify-stamp.json");
const reasons = [];
if (!existsSync(path)) reasons.push("no stamp: \`pnpm run verify\` has not run on this worktree");
else {
  const stamp = JSON.parse(readFileSync(path, "utf8"));
  if (stamp.head !== head) reasons.push(\`the stamp is for head \${stamp.head.slice(0, 9)}, this is \${head.slice(0, 9)}\`);
  if (stamp.bodyHash !== (body === null ? "none" : createHash("sha256").update(body).digest("hex"))) reasons.push("the stamp is for another body than the one now");
  for (const id of ${JSON.stringify(STEPS)}) if (stamp.steps?.[id]?.status !== "pass") reasons.push(\`step \${id}: \${stamp.steps?.[id]?.status ?? "did not run"}\`);
}
process.stdout.write(reasons.length === 0 ? "verify: GREEN\\n" : \`verify: RED\\n\${reasons.map((reason) => \`  - \${reason}\`).join("\\n")}\\n\`);
process.exit(reasons.length === 0 ? 0 : 1);
`;

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() }).trim();

/** A project checkout with a commit, and the author's linked worktree on a branch of its own. `declares`: whether `package.json` has a `verify` script. */
function fixture({ declares = true } = {}) {
  const root = tmpDir("verify-stamp-test-");
  const checkout = join(root, "project");
  execFileSync("git", ["init", "-q", "-b", "main", checkout], { env: sandboxGitEnv() });
  git(checkout, "config", "user.email", "t@example.invalid");
  git(checkout, "config", "user.name", "t");
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "fixture-project", scripts: declares ? { verify: "node verify.mjs" } : {} }));
  writeFileSync(join(checkout, "verify.mjs"), VERIFY_MJS);
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "base");
  const author = join(root, "wt-author");
  git(checkout, "worktree", "add", "-q", "-b", "agent/x", author);
  const commit = (message: string) => {
    writeFileSync(join(author, "work.txt"), message);
    git(author, "add", "-A");
    git(author, "commit", "-q", "-m", message);
    return git(author, "rev-parse", "HEAD");
  };
  const stamp = (head: string, over: { body?: string, steps?: Record<string, string>, bodyHash?: string } = {}) => {
    const steps = Object.fromEntries(STEPS.map((id) => [id, { status: over.steps?.[id] ?? "pass", ms: 1 }]));
    for (const [id, status] of Object.entries(over.steps ?? {})) if (status === "") delete (steps as Record<string, unknown>)[id];
    const path = git(author, "rev-parse", "--path-format=absolute", "--git-path", "verify-stamp.json");
    writeFileSync(path, JSON.stringify({ head, dirty: false, bodyHash: over.bodyHash ?? sha256(over.body ?? BODY), steps }));
  };
  return { checkout, author, commit, stamp };
}

/** `pr-open create` from the author's tree, through the real reading of the fixture's stamp. */
function open(project: ReturnType<typeof fixture>, { draft, body = BODY, acceptance = 0 }: { draft: boolean, body?: string, acceptance?: number }) {
  const sent: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const head = git(project.author, "rev-parse", "HEAD");
  const code = main(["create", ...(draft ? ["--draft"] : []), "--head", "agent/x", "--body-file", "body.md", "--body", body], {
    run: (args) => { sent.push(args); },
    git: (args) => (args[0] === "diff" ? (args.includes("--diff-filter=A") ? ACCEPTANCE_FILE : `work.txt\0${ACCEPTANCE_FILE}`) : args.includes("--abbrev-ref") ? "agent/x" : head),
    readFile: () => body,
    prHead: () => ({ ref: "agent/x", oid: head }),
    runAcceptance: () => acceptance,
    runMutation: () => 0,
    owner: () => "ceo",
    verifyStamp: (text: string) => readVerifyStamp({ dir: project.author, body: text }),
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
  });
  return { code, sent, out: out.join(""), err: err.join("") };
}

test("#3215 (1): a READY open with no stamp is REFUSED naming the command that writes one; with a green stamp for this head it proceeds", () => {
  const project = fixture();
  const head = project.commit("one");
  const refused = open(project, { draft: false });
  assert.equal(refused.code, EXIT_NOTHING_SENT, refused.err);
  assert.deepEqual(refused.sent, [], "nothing was sent to GitHub");
  assert.match(refused.err, /no stamp/);
  assert.match(refused.err, /pnpm run verify -- --draft-body=body\.md/, "the line names the command that makes it green, with the body file the open was given");

  project.stamp(head);
  const accepted = open(project, { draft: false });
  assert.equal(accepted.code, 0, `POSITIVE CONTROL: the same open with a green stamp for this head proceeds: ${accepted.err}`);
  assert.equal(accepted.sent.some((args) => args[1] === "create"), true, "and sends the create");
});

test("#3215 (2): a stamp for an EARLIER head is refused as stale with both SHAs; a stamp for this head and another body is refused", () => {
  const project = fixture();
  const first = project.commit("one");
  project.stamp(first);
  const second = project.commit("two");
  const stale = open(project, { draft: false });
  assert.equal(stale.code, EXIT_NOTHING_SENT);
  assert.ok(stale.err.includes(`the stamp is for head ${first.slice(0, 9)}, this is ${second.slice(0, 9)}`), stale.err);

  project.stamp(second, { body: `${BODY}\n\nan edit after the stamp` });
  const other = open(project, { draft: false });
  assert.equal(other.code, EXIT_NOTHING_SENT);
  assert.match(other.err, /another body than the one now/);

  project.stamp(second);
  assert.equal(open(project, { draft: false }).code, 0, "POSITIVE CONTROL: the stamp for this head and this body is accepted");
});

test("#3215 (3): a stamp with a FAILED or a MISSING step is refused naming the step", () => {
  const project = fixture();
  const head = project.commit("one");
  project.stamp(head, { steps: { ts: "fail" } });
  const failed = open(project, { draft: false });
  assert.equal(failed.code, EXIT_NOTHING_SENT);
  assert.match(failed.err, /step ts: fail/);
  assert.doesNotMatch(failed.err, /step agentOrg/, "only the red step is named");

  project.stamp(head, { steps: { agentOrg: "" } });
  const missing = open(project, { draft: false });
  assert.equal(missing.code, EXIT_NOTHING_SENT);
  assert.match(missing.err, /step agentOrg: did not run/);
});

test("#3215 (4): a DRAFT with no stamp opens when the body reports pass, and is REFUSED when a body report fails", () => {
  const project = fixture();
  project.commit("one");
  const opened = open(project, { draft: true });
  assert.equal(opened.code, 0, opened.err);
  assert.equal(opened.sent.some((args) => args.includes("--draft")), true, "the draft was sent with no stamp at all");

  const refused = open(project, { draft: true, acceptance: 1 });
  assert.equal(refused.code, EXIT_NOTHING_SENT, "the control: the same draft is still refused for a failing body, so the door can say no");
  assert.deepEqual(refused.sent, []);
  assert.doesNotMatch(refused.err, /verify stamp/, "and not for a stamp");
});

test("#3215 (6): a project that declares no verify command is NOT refused, and says so by name", () => {
  const project = fixture({ declares: false });
  project.commit("one");
  assert.deepEqual(verifyDeclaration(project.author).script, null);
  const result = open(project, { draft: false });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /no verify declared for fixture-project/);

  const declared = fixture();
  declared.commit("one");
  assert.equal(open(declared, { draft: false }).code, EXIT_NOTHING_SENT, "THE CONTROL: the same open in a project that declares one is refused");
});

/** A convinced-verdict draft at `head` from a reviewer who is not its author, owned by `worker-3215`. */
const convincedDraft = (head: string, body = BODY) => ({
  number: 7, isDraft: true, headRefOid: head, body, headRefName: "agent/x",
  statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
  author: { login: "a11ign-ai-workers" }, labels: [{ name: "session:worker-3215" }],
  comments: [{ body: `Review of #7 at \`${head.slice(0, 8)}\`, by \`reviewer\`: convinced.` }],
});
type Order = { session: string, cause: string, causeKey: string, prompt: string, action?: { kind: string, pr: number, repo?: string } };
const ordersFrom = (project: ReturnType<typeof fixture>, pr: unknown) =>
  decide({ prs: withVerifyStamps([pr as never], { checkout: project.checkout }), readyRows: [] }) as Order[];
const readyCalls = (orders: Order[]) => {
  const calls: string[][] = [];
  performActions(orders, (args: string[]) => { calls.push(args); return ""; }, () => {});
  return calls;
};

test("#3215 (5): the gate's `gh pr ready` is NOT run for a head with no green stamp or a stale one, and IS run for a stamped head", () => {
  const project = fixture();
  const first = project.commit("one");
  const none = ordersFrom(project, convincedDraft(first));
  assert.deepEqual(readyCalls(none), [], "no stamp: no `gh pr ready`");
  assert.equal(none[0].action, undefined);

  project.stamp(first);
  const second = project.commit("two");
  assert.deepEqual(readyCalls(ordersFrom(project, convincedDraft(second))), [], "a stamp for the earlier head is stale: no `gh pr ready`");

  project.stamp(second, { body: "an older body" });
  assert.deepEqual(readyCalls(ordersFrom(project, convincedDraft(second))), [], "a stamp for another body is stale too");

  project.stamp(second);
  const stamped = ordersFrom(project, convincedDraft(second));
  assert.deepEqual(readyCalls(stamped), [["pr", "ready", "7"]], "POSITIVE CONTROL: the stamped head is marked ready, in the existing call shape");
  assert.deepEqual(readyCalls(ordersFrom(project, { ...convincedDraft(second), repo: "a11ign/agent-org" })), [["pr", "ready", "7", "--repo", "a11ign/agent-org"]],
    "and the `--repo` form for another repository is unchanged");
});

test("#3215 (5): when `gh pr ready` FAILS on a stamped head, product-manager is woken exactly as before", () => {
  const project = fixture();
  const head = project.commit("one");
  project.stamp(head);
  const [order] = ordersFrom(project, convincedDraft(head));
  const { delivered, performed } = performActions([order], () => { throw new Error("gh: not authorised"); }, () => {});
  assert.equal(performed, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].session, "product-manager");
  assert.equal(delivered[0].cause, "draft-convinced-not-ready");
});

test("#3215 (7): the withheld ready is told to the AUTHOR once, and a pull request that is not convinced is untouched", () => {
  const project = fixture();
  const head = project.commit("one");
  const pr = convincedDraft(head);

  const first = ordersFrom(project, pr);
  const again = ordersFrom(project, pr);
  assert.deepEqual(first, again, "the pure builder over the same state is byte-identical, so the waker's ledger delivers it once");
  assert.equal(first.length, 1);
  assert.equal(first[0].session, "worker-3215", "the author, who holds the worktree `verify` runs in -- not product-manager");
  assert.match(first[0].prompt, /WILL NOT mark it ready/);
  assert.match(first[0].prompt, /no stamp/, "it says which stamp is missing");
  assert.match(first[0].prompt, /pnpm run verify/);

  project.stamp(head, { steps: { ts: "fail" } });
  const reasonChanged = ordersFrom(project, pr);
  assert.match(reasonChanged[0].prompt, /step ts: fail/);
  assert.equal(reasonChanged[0].causeKey, first[0].causeKey, "a changed REASON is not new work: the author is not woken twice for one head");

  // Not convinced, and no verdict at all: the order is exactly the one an unstamped pull request gets.
  const refused = { ...pr, comments: [{ body: `Review of #7 at \`${head.slice(0, 8)}\`, by \`reviewer\`: not convinced.` }] };
  const bare = { ...pr, comments: [] };
  for (const untouched of [refused, bare]) {
    assert.deepEqual(ordersFrom(project, untouched), decide({ prs: [untouched], readyRows: [] }),
      "the stamp changes nothing for a pull request that is not convinced");
  }
  assert.notEqual(decide({ prs: [bare], readyRows: [] }).length, 0, "the control: the untouched order is a real order, so the equality above is not two empty lists");

  // A verdict the author signed still wakes a human, stamp or no stamp.
  const selfSigned = { ...pr, comments: [{ body: `Review of #7 at \`${head.slice(0, 8)}\`, by \`a11ign-ai-workers\`: convinced.` }] };
  assert.equal(ordersFrom(project, selfSigned)[0].session, "product-manager");
});

test("#3215: a head with no worktree is red, an unreadable manifest is red and not a crash, and a pull request nobody read is not accused", () => {
  const project = fixture();
  const head = project.commit("one");
  assert.equal(worktreeAtHead({ checkout: project.checkout, head, git: (args) => execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() }) }), project.author,
    "the linked worktree is found by its HEAD");

  const [unknown] = withVerifyStamps([convincedDraft("f".repeat(40))], { checkout: project.checkout });
  assert.equal(unknown.verifyStamp.state, VERIFY_STATE.RED);
  assert.match(unknown.verifyStamp.reasons[0], /no worktree of fixture-project is at head fffffffff/);

  writeFileSync(join(project.checkout, "package.json"), "{ not json");
  const [broken] = withVerifyStamps([convincedDraft(head)], { checkout: project.checkout });
  assert.equal(broken.verifyStamp.state, VERIFY_STATE.RED);
  assert.match(broken.verifyStamp.reasons[0], /could not be read/);

  assert.equal(withVerifyStamps([convincedDraft(head)], { checkout: undefined })[0].verifyStamp, undefined, "no checkout to read: unstamped, accusing nobody");
  const ready = { ...convincedDraft(head), isDraft: false };
  assert.equal(withVerifyStamps([ready], { checkout: project.checkout })[0].verifyStamp, undefined, "only drafts, the pull requests the ready action reaches");
});
