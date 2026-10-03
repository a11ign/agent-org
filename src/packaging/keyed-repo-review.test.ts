// no-token: gh -- imports `work-gate.mjs` and `wake.mjs`, whose default readers spawn `gh`; every read here is handed an injected `run`, every per-tick read a stub, and `git` and `herdr` are fakes, so nothing is spawned (#2969)
/**
 * #2969: A REPOSITORY THE ORG OPENS PULL REQUESTS IN, THAT THE GATE DOES NOT DECLARE, IS INVISIBLE TO EVERY PULL-REQUEST CAUSE.
 *
 * 2026-10-02: `a11ign/agent-org#6` had green checks, no review request and no review for hours, and `#3` for a day, because
 * `.agent-org/project.json` declared one code repository and nothing ticks, reviews or watches the others. Four things were missing, and
 * each is pinned below by a test that goes red when it is taken away:
 *
 *   (1) the DECLARATION  a declared code repository with a key is a scope of its own, with no tracker, the primary first. THAT EVERY REPOSITORY THE
 *                        ORGANISATION HAS IS DECLARED OR EXEMPT IS A11IGN'S INVARIANT, not this tool's, and it moved there (#3233): it compared a
 *                        recording of GitHub's repository list with a11ign's live declaration, so a repository a11ign opened turned this suite red
 *   (2) the CHECKOUT     `noReviewCheckoutFor` is `null` for a declared key whose clone the host names, and the fetch is made FROM that clone
 *   (3) the DOOR         the keyed reviewer's order and environment carry `GH_REPO=<repo>`
 *   (4) the OWNER        a keyed pull request nobody owns falls to `ownerOfPr`'s last rung, `ceo`, never to nobody
 *
 * AND THE PRIMARY IS UNTOUCHED (3 of the row's list): the empty key's seat, ref, fetch root and prompt are asserted byte for byte.
 *
 * POSITIVE CONTROLS ARE IN THIS FILE, each next to the assertion it serves (`.claude/rules/guards-and-assertions.md`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLONE = "/home/agent/repos/agent-org";

// --- (#3233) THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, NOT A11IGN'S CHECKOUT ---
//
// The readers below take the project they serve from `$AGENT_ORG_HOST` AT IMPORT, and without it the layout answers a11ign's live checkout: its declaration
// (which repositories it has, which it has a clone of) changed this file's verdict whenever a11ign gained one. So the host file is set FIRST and the tool is
// imported AFTER it, dynamically; the project is `fixtures/keyed-repo-review/project`, copied to a temp directory. Its host names the clone `CLONE`, which is
// what `reviewCloneOf` reads back.
const SCRATCH = mkdtempSync(join(tmpdir(), "keyed-repo-review-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/keyed-repo-review/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", clones: { "agent-org": CLONE },
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { homeProjectDeclaration } = await import("../project-config.mjs");
const { scopesOf, readLanes, scopeTick } = await import("../work-gate.mjs");
const { ownerOfPr } = await import("../work-gate/pr-orders.mjs");
const { lookupOpenPrFiles } = await import("../row-claim/file-overlap-rule.mjs");
const { deliver, noReviewCheckoutFor, prepareReviewCheckout, removeReviewCheckout, reviewCloneOf, reviewerEnvironment,
  linkKeyedDependencies, withReviewCheckout, repointedForReviewer, REPO_ROOT } = await import("../wake.mjs");

const SESSION = "reviewer-agent-org-6";
/** The refusal of a `{ clone } | { refusal }` answer, or `undefined` when it was a clone. */
const refusalOf = (answer: { clone: string } | { refusal: string }) => ("refusal" in answer ? answer.refusal : undefined);
/** A host declaration `host-config.mjs` accepts, with `extra` laid over it: `reviewCloneOf` reads through that reader (#2991), so a bare `{ clones }` is no host file. */
const hostFile = (extra: Record<string, unknown>) => JSON.stringify({ schema: 1, home: "/h", binDir: "/h/bin", primary: "p",
  projects: [{ id: "p", checkout: "/h/p" }], gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] }, ...extra });

// --- (1) THE DECLARATION ---------------------------------------------------------------------------------------------------------

test("(1) the declaration reads `agent-org` as a CODE scope with no tracker of its own, and the primary stays first", () => {
  const scopes = scopesOf([homeProjectDeclaration()]);
  assert.equal(scopes[0].key, "", "the primary is first");
  const keyed = scopes.find((s) => s.key === "agent-org");
  assert.deepEqual(keyed, { key: "agent-org", code: { repo: "a11ign/agent-org" }, tracker: null });
  // The fixture declares one keyed repository, so "nothing else" is a claim about the reader and a second one would be seen.
  assert.deepEqual(scopes.slice(1).map((s) => s.key), ["agent-org"], "and nothing else is declared");
});

// --- (2) THE ORDER, AND ITS CHECKOUT ----------------------------------------------------------------------------------------------

const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const HEAD = "abc12345deadbeefcafe000011112222";
/** A ready (not draft), green, unreviewed pull request, as `gh pr list` returns it. */
const readyPr = (number: number) => ({ number, isDraft: false, headRefOid: HEAD, statusCheckRollup: GREEN, author: { login: "a11ign-ai-leads" },
  comments: [], labels: [], reviews: [], reviewRequests: [] });
const NO_READINGS = { code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
  tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null }) };

/** One scope's orders, made the way `main` makes them: the lanes through `readLanes`, then `scopeTick`. `gh` answers the pull-request list only. */
function ordersOf(key: string, prs: unknown[]) {
  const scope = scopesOf([homeProjectDeclaration()]).find((s) => s.key === key)!;
  const aimedAt: (string | undefined)[] = [];
  const run = (args: string[], repo?: string) => { aimedAt.push(repo); return args[0] === "pr" ? JSON.stringify(prs) : "[]"; };
  const orders = scopeTick(scope, false, readLanes(scope, run), NO_READINGS).orders as { session: string, cause: string, causeKey: string, prompt: string }[];
  return { orders, aimedAt };
}

/** A `git` that records every call, and answers as a repository whose pull request 6 is at `HEAD`. */
function fakeGit() {
  const calls: string[][] = [];
  const trees = new Set<string>();
  const git = (_cmd: string, args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.includes(" fetch ")) return "";
    if (line.includes("rev-parse --verify")) return `${HEAD}\n`;
    if (line.includes("worktree add")) { trees.add(args[args.length - 2]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${HEAD}\n`;
    if (line.includes("worktree remove")) { trees.delete(args[args.length - 1]); return ""; }
    if (line.includes("update-ref -d")) return "";
    throw new Error(`unexpected git ${line}`);
  };
  return { calls, trees, seams: { git, exists: (p: string) => trees.has(p), root: "/reviews-root", link: () => null } };
}

test("(2) a ready, green, unreviewed pull request in the `agent-org` scope yields a reviewer order to `reviewer-agent-org-<n>`", () => {
  const { orders, aimedAt } = ordersOf("agent-org", [readyPr(6), readyPr(3)]);
  assert.ok(aimedAt.length > 0 && aimedAt.every((repo) => repo === "a11ign/agent-org"), `every read is aimed at the keyed repository: ${aimedAt}`);
  const reviewer = orders.filter((o) => o.cause === "draft-awaiting-verdict");
  // POSITIVE CONTROL: orders exist, or the deepEqual below compares two empty lists.
  assert.equal(reviewer.length, 2, "one per pull request");
  assert.deepEqual(reviewer.map((o) => o.session).sort(), ["reviewer-agent-org-3", "reviewer-agent-org-6"]);
  assert.equal(reviewer.find((o) => o.session === SESSION)!.causeKey, `${SESSION}/draft-awaiting-verdict/pr-agent-org#6/abc12345`);
  assert.match(reviewer[0].prompt, /REPOSITORY `agent-org` \(code `a11ign\/agent-org`\)/, "and the prompt says which repository a bare number belongs to");
});

test("(2) `noReviewCheckoutFor` is `null` for a declared key whose clone the host names, and refuses every other keyed instance by name", () => {
  assert.equal(noReviewCheckoutFor(SESSION), null);
  assert.deepEqual(reviewCloneOf("agent-org"), { clone: CLONE }, "the host declares the clone this test names");
  assert.equal(noReviewCheckoutFor("reviewer-7"), null, "the primary's instance still gets one");
  // NEGATIVE: a key the project does not declare is refused even though the host would happily name a clone for it ...
  assert.match(String(noReviewCheckoutFor("reviewer-other-7")), /no review checkout for "reviewer-other-7": the project declares no code repository for key `other`.*WRONG repository's pull request/);
  // ... and a declared key the host gives NO clone is refused by name, never answered with the primary's checkout.
  assert.match(String(refusalOf(reviewCloneOf("agent-org", { path: "/h.json", read: (() => hostFile({ clones: {} })) as never }))), /declares no absolute `clones.agent-org` path/);
  assert.match(String(refusalOf(reviewCloneOf("agent-org", { path: "/h.json", read: (() => { throw new Error("ENOENT"); }) as never }))), /cannot be read as the host declaration/);
  assert.match(String(refusalOf(reviewCloneOf("agent-org", { path: "/h.json", read: (() => hostFile({ clones: { "agent-org": "relative/path" } })) as never }))), /cannot be read as the host declaration .*`clones.agent-org` it must be an absolute path/);
  assert.match(String(refusalOf(reviewCloneOf("constructor", { path: "/h.json", read: (() => hostFile({ clones: {} })) as never }))), /declares no absolute `clones.constructor` path/,
    "an inherited property is not a declared clone");
});

test("(2) the checkout is fetched from the DECLARED CLONE into a keyed ref, never from `origin` of the primary", () => {
  const git = fakeGit();
  const made = prepareReviewCheckout({ pr: 6, session: SESSION, ...git.seams });
  assert.deepEqual(made, { path: `/reviews-root/${SESSION}`, head: HEAD });
  const fetched = git.calls.find((args) => args.includes("fetch"))!;
  // POSITIVE CONTROL: a fetch was made, or `every` below passes over nothing.
  assert.deepEqual(fetched, ["-C", CLONE, "fetch", "--quiet", "origin", "+refs/pull/6/head:refs/review/agent-org/pr-6"]);
  assert.ok(git.calls.some((args) => args.includes("worktree") && args[1] === CLONE), "the worktree is added IN the clone");
  assert.equal(git.calls.filter((args) => args[1] === REPO_ROOT).length, 0, "and the primary's checkout is never asked");
  // Taken down, the same way: removal runs in the clone too, and drops the KEYED ref.
  const removed = removeReviewCheckout({ pr: 6, session: SESSION, key: "agent-org", ...git.seams, record: () => {} });
  assert.equal(removed, null);
  assert.ok(git.calls.some((args) => args[1] === CLONE && args.includes("remove")), "the worktree is removed from the clone");
  assert.ok(git.calls.some((args) => args[1] === CLONE && args.includes("update-ref") && args.includes("refs/review/agent-org/pr-6")));
  // A keyed instance whose key the project does not declare gets NO tree and NO git at all.
  const none = fakeGit();
  assert.match(String((prepareReviewCheckout({ pr: 6, session: "reviewer-other-6", ...none.seams }) as { refusal: string }).refusal), /no review checkout/);
  assert.deepEqual(none.calls, [], "nothing is fetched for the wrong repository");
});

/** The filesystem `linkKeyedDependencies` reads, as a map of file contents and a list of directories; `made` records every symlink. */
function keyedFs(files: Record<string, string>, dirs: string[]) {
  const made: string[] = [];
  const entriesOf = (dir: string) => dirs.filter((d) => d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes("/")).map((d) => d.slice(dir.length + 1));
  const fs = { existsSync: (p: string) => p in files || dirs.includes(p), readFileSync: (p: string) => files[p], mkdirSync: () => undefined,
    readdirSync: (p: string) => entriesOf(p), lstatSync: () => undefined, readlinkSync: () => "",
    symlinkSync: (target: string, link: string) => { made.push(`${link} -> ${target}`); }, rmSync: () => undefined };
  return { fs: fs as never, made };
}
const manifest = (extra: Record<string, unknown>) => ({ "/t/package.json": JSON.stringify({ name: "agent-org", ...extra }) });
const CI_PINS = { tsx: "^4.22.4", yaml: "^2.9.0", typescript: "^6.0.3" };

test("(2) a keyed tree links no `packages/`: a clone with every declared dependency is linked plainly, as before", () => {
  const { fs, made } = keyedFs(manifest({ devDependencies: CI_PINS }), ["/c/node_modules", "/c/node_modules/tsx", "/c/node_modules/yaml",
    "/c/node_modules/typescript", "/c/node_modules/.cache", "/c/node_modules/.bin"]);
  assert.equal(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs }), null);
  assert.deepEqual(made, ["/t/node_modules/tsx -> /c/node_modules/tsx", "/t/node_modules/yaml -> /c/node_modules/yaml",
    "/t/node_modules/typescript -> /c/node_modules/typescript", "/t/node_modules/.bin -> /c/node_modules/.bin"], "`.cache` is skipped, as it is for the primary");
});

test("(2) a repository that declares nothing still yields a tree: no `node_modules` and no manifest, or a manifest with only peers, need nothing", () => {
  for (const files of [{}, manifest({}), manifest({ peerDependencies: { typescript: "^6.0.3" } })]) {
    const { fs, made } = keyedFs(files, []);
    assert.equal(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs }), null);
    assert.deepEqual(made, [], "nothing to link");
  }
  // POSITIVE CONTROL for the refusals below: the SAME clone with a declaration is not a tree, so the three cases above are not vacuous.
  assert.match(String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: keyedFs(manifest({ dependencies: { yaml: "^2.9.0" } }), []).fs })), /yaml/);
});

test("(2) a declared dependency missing from the clone's `node_modules` is a REFUSAL naming it and the command that supplies it, not `null`", () => {
  // The #3110 clone: the manifest declares three packages and the clone holds one of them.
  const partial = keyedFs(manifest({ devDependencies: CI_PINS }), ["/c/node_modules", "/c/node_modules/typescript"]);
  const reason = String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: partial.fs }));
  assert.match(reason, /`tsx` and `yaml`/, "names what is missing");
  assert.doesNotMatch(reason, /`typescript`/, "and only what is missing");
  assert.match(reason, /cd \/c && pnpm install --no-lockfile/, "and the command: pnpm, reading the versions the manifest declares, writing no lockfile into a shared clone");
  assert.doesNotMatch(reason, /\bnpm\b/, "and no npm spelling of it (#2896)");
  assert.deepEqual(partial.made, [], "nothing is linked into a tree that cannot run");
  // No `node_modules` at all is the same refusal -- the exact shape that killed agent-org#86's reviewer on `tsx`.
  const none = keyedFs(manifest({ devDependencies: CI_PINS }), []);
  assert.match(String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: none.fs })), /`tsx`, `yaml` and `typescript`/);
  // A scoped package is looked for under its scope, and `dependencies` are read as well as `devDependencies`.
  const scoped = keyedFs(manifest({ dependencies: { "@a/b": "^1.0.0" } }), ["/c/node_modules", "/c/node_modules/@a"]);
  assert.match(String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: scoped.fs })), /`@a\/b`/);
  // A manifest that cannot be read is not "declares nothing".
  const broken = keyedFs({ "/t/package.json": "{ not json" }, ["/c/node_modules"]);
  assert.match(String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: broken.fs })), /\/t\/package\.json cannot be read as a manifest/);
});

test("(2) `prepareReviewCheckout` hands a keyed reviewer no tree when the clone lacks a dependency the pull request's head declares", () => {
  const dir = mkdtempSync(join(tmpdir(), "keyed-deps-"));
  try {
    const clone = join(dir, "clone");
    mkdirSync(join(clone, "node_modules", "yaml"), { recursive: true });
    const base = fakeGit();
    // The tree's own manifest is the PULL REQUEST HEAD's: `worktree add` is where it appears, as it would in a real checkout.
    const git = (cmd: string, args: string[]) => {
      if (args.join(" ").includes("worktree add")) {
        mkdirSync(args[args.length - 2], { recursive: true });
        writeFileSync(join(args[args.length - 2], "package.json"), JSON.stringify({ devDependencies: { yaml: "^2.9.0", tsx: "^4.22.4" } }));
      }
      return base.seams.git(cmd, args);
    };
    const refused = prepareReviewCheckout({ pr: 6, session: SESSION, ...base.seams, git, root: join(dir, "reviews"), repoRoot: clone, link: undefined });
    assert.match(String((refused as { refusal: string }).refusal), /no review dependencies for PR #6 .*`tsx`/);
    // POSITIVE CONTROL: with `tsx` present the same call yields a tree, so the refusal above was the missing package and nothing else.
    mkdirSync(join(clone, "node_modules", "tsx"));
    base.trees.clear();
    const made = prepareReviewCheckout({ pr: 6, session: SESSION, ...base.seams, git, root: join(dir, "reviews"), repoRoot: clone, link: undefined });
    assert.deepEqual(made, { path: join(dir, "reviews", SESSION), head: HEAD });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2991: a live KEYED reviewer is re-pointed to the pull request's current head, from the clone into the keyed ref", () => {
  const git = fakeGit();
  const { prompt } = repointedForReviewer({ session: SESSION, prompt: "Pushed a fix." }, git.seams);
  const fetched = git.calls.find((args) => args.includes("fetch"));
  // POSITIVE CONTROL: a fetch was made, or the assertions on its absence below could never have failed.
  assert.deepEqual(fetched, ["-C", CLONE, "fetch", "--quiet", "origin", "+refs/pull/6/head:refs/review/agent-org/pr-6"]);
  assert.match(prompt, /^Pushed a fix\./);
  assert.match(prompt, new RegExp(`Your checkout of #6, \`/reviews-root/${SESSION}\`, has just been re-pointed to the pull request's current head \`${HEAD.slice(0, 8)}\``));
  assert.equal(git.calls.filter((args) => args[1] === REPO_ROOT).length, 0, "the primary's checkout is never asked");
});

test("#2991: an UNDECLARED key is returned unchanged and nothing is fetched", () => {
  const none = fakeGit();
  assert.deepEqual(repointedForReviewer({ session: "reviewer-other-6", prompt: "p" }, none.seams), { prompt: "p" });
  assert.deepEqual(none.calls, [], "nothing is fetched for the wrong repository");
});

// --- (3) THE DOOR -----------------------------------------------------------------------------------------------------------------

test("(3) the keyed reviewer's order and environment carry `GH_REPO=a11ign/agent-org`, the primary's carry none", () => {
  const checkout = { path: `/reviews-root/${SESSION}`, head: HEAD };
  const keyed = withReviewCheckout({ session: SESSION, prompt: "p" }, checkout, 6).prompt;
  assert.match(keyed, /`GH_REPO=a11ign\/agent-org A11Y_REVIEWER_SESSION=reviewer-agent-org-6 pr-review-verdict <n> <convinced\|not-convinced> <file>`/);
  assert.match(keyed, /every `gh` call and the door itself need `GH_REPO=a11ign\/agent-org`/);
  assert.equal(reviewerEnvironment(SESSION).GH_REPO, "a11ign/agent-org");
  assert.equal(reviewerEnvironment(SESSION, { GH_REPO: "x/y" }).GH_REPO, "x/y", "an override still wins, key by key");
  assert.equal("GH_REPO" in reviewerEnvironment("reviewer-6"), false);
  assert.doesNotMatch(withReviewCheckout({ session: "reviewer-6", prompt: "p" }, { path: "/reviews-root/reviewer-6", head: HEAD }, 6).prompt, /GH_REPO/);
});

test("(3) end to end: `deliver` makes the keyed tree from the clone, starts the pane with `GH_REPO`, and types the door line", () => {
  const git = fakeGit();
  const sent: string[][] = [];
  const registered: string[] = [];
  const order = ordersOf("agent-org", [readyPr(6)]).orders.find((o) => o.session === SESSION)!;
  const out = deliver([order], [], [], { run: (args) => { sent.push(args); return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" },
    workspace: { workspace_id: "wB" } } }); }, checkout: git.seams, reviewerEnv: {}, registerReviewer: (s) => registered.push(s) });
  assert.deepEqual(out.refused, []);
  assert.deepEqual(registered, [SESSION], "POSITIVE CONTROL: an instance was started");
  assert.deepEqual(git.calls.find((args) => args.includes("fetch")), ["-C", CLONE, "fetch", "--quiet", "origin", "+refs/pull/6/head:refs/review/agent-org/pr-6"]);
  assert.ok(sent.some((args) => args.join(" ").includes("GH_REPO=a11ign/agent-org A11Y_REVIEWER_SESSION=reviewer-agent-org-6 pr-review-verdict")),
    "the order that was typed names the door with the repository");
});

// --- THE PRIMARY IS UNTOUCHED -----------------------------------------------------------------------------------------------------

test("the primary's instance is byte-identical to before: seat, fetch root, ref, prompt and environment", () => {
  const scopes = scopesOf([homeProjectDeclaration()]);
  assert.deepEqual(scopes[0], { key: "", code: { repo: "a11ign/a11ign" }, tracker: { repo: "a11ign/a11ign" } });
  const git = fakeGit();
  prepareReviewCheckout({ pr: 6, session: "reviewer-6", ...git.seams });
  assert.deepEqual(git.calls.find((args) => args.includes("fetch")), ["-C", REPO_ROOT, "fetch", "--quiet", "origin", "+refs/pull/6/head:refs/review/pr-6"]);
  const prompt = withReviewCheckout({ session: "reviewer-6", prompt: "p" }, { path: "/r/reviewer-6", head: HEAD }, 6).prompt;
  assert.ok(prompt.endsWith("post the verdict as `A11Y_REVIEWER_SESSION=reviewer-6 pr-review-verdict <n> <convinced|not-convinced> <file>` "
    + "and the verdict line's `by` names you."), "the door line is the one it always was, with nothing after it");
  assert.deepEqual(Object.keys(reviewerEnvironment("reviewer-6")).sort(), ["A11Y_REVIEWER_SESSION", "GH_CONFIG_DIR", "npm_config_cache"]);
});

// --- (4) NOBODY OWNS IT -----------------------------------------------------------------------------------------------------------

test("(4) a keyed pull request with no `session:` label and no row falls to `ceo`, never to nobody", () => {
  const unowned = { ...readyPr(6), repoKey: "agent-org", repo: "a11ign/agent-org" };
  assert.deepEqual(ownerOfPr(unowned), { session: "ceo", source: "ceo" });
  assert.deepEqual(ownerOfPr({ ...unowned, labels: [{ name: "session:worker-9" }] }), { session: "worker-9", source: "label" }, "POSITIVE CONTROL: a label still wins");
});

// --- THE CLAIM'S OVERLAP CHECK READS THE NEW REPOSITORY TOO ----------------------------------------------------------------------

test("a consequence of declaring it: a claim's file-overlap lookup reads the open pull requests of BOTH declared repositories (#2617)", () => {
  const asked: string[] = [];
  const run = (args: string[]) => { asked.push(args[args.indexOf("--repo") + 1]); return "[]"; };
  assert.deepEqual(lookupOpenPrFiles({ run, log: () => {} }), []);
  const declared = scopesOf([homeProjectDeclaration()]).flatMap((scope) => (scope.code ? [scope.code.repo] : []));
  assert.deepEqual(asked.slice(0, 2), ["a11ign/a11ign", "a11ign/agent-org"], "the primary's first, then `agent-org`'s: one call each");
  assert.deepEqual(asked, declared, "and every declared code repository after them, once, in declaration order");
});
