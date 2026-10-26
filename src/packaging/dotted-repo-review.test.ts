// no-token: none -- the host file, the project declaration and git are all fakes or a temporary directory; nothing is spawned and no pull request is read (A11-292)
/**
 * A11-292: A DECLARED REPOSITORY WHOSE NAME HOLDS WHAT A KEY CANNOT (`a11ign/.github`) WAS NEVER REVIEWED.
 *
 * The project declares it under the key `github` (a key is `[a-z0-9-]`), so its reviewer's seat is `reviewer-github-6`; the host lists its clone under the repository's NAME, `.github`
 * (what `git clone` makes). The clone was looked up by the key alone, so `reviewCloneOf("github")` refused -- `declares no absolute \`clones.github\` path` -- every tick, and .github #6
 * waited more than twenty hours. Until this was fixed the chairman's session had `clones.github` added by hand.
 *
 * The project this file runs against is the recorded keyed-repo-review fixture with `github` declared in a temporary copy, and the host is a temporary file: neither is a11ign's live file (#3233).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOT_CLONE = "/repos/github";
const SCRATCH = mkdtempSync(join(tmpdir(), "dotted-repo-review-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/keyed-repo-review/project", import.meta.url)), PROJECT, { recursive: true });
const DECLARATION = join(PROJECT, ".agent-org", "project.json");
const declaration = JSON.parse(readFileSync(DECLARATION, "utf8"));
declaration.code.push({ key: "github", repo: "a11ign/.github" });
writeFileSync(DECLARATION, JSON.stringify(declaration));
/** A host declaration `host-config.ts` accepts, with `clones` as given. */
const hostFile = (clones: Record<string, string>) => JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", clones,
  projects: [{ id: "fixture", checkout: PROJECT }], gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, hostFile({ ".github": DOT_CLONE, "agent-org": "/repos/agent-org" }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { cloneOfKey } = await import("../claim-stall/stall-causes-and-claim-readings.ts");
const { noReviewCheckoutFor, prepareReviewCheckout, removeReviewCheckout, reviewCloneOf } = await import("../wake/reviewer-tokens-and-checkouts.ts");
const { cloneOfDeclared } = await import("../declared-clone.ts");
const { verifyCheckoutOf } = await import("../verify-stamp.ts");
const { reviewerInstance, reviewerSeat } = await import("../review-attribution.ts");

const SESSION = "reviewer-github-6";
const HEAD = "abc12345deadbeefcafe000011112222";
/** A `git` that answers the commands a review checkout makes, and records each argv. */
function fakeGit() {
  const calls: string[][] = [];
  const trees = new Set<string>();
  const git = (_cmd: string, args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.includes("rev-parse --verify")) return `${HEAD}\n`;
    if (line.includes("worktree add")) { trees.add(args[args.length - 2]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${HEAD}\n`;
    if (line.includes("worktree remove")) { trees.delete(args[args.length - 1]); return ""; }
    if (line.includes("update-ref -d") || line.includes(" fetch ")) return "";
    throw new Error(`unexpected git ${line}`);
  };
  return { calls, seams: { git, exists: (p: string) => trees.has(p), root: "/reviews-root", link: () => null } };
}
/** A reader of a host file whose `clones` are as given, and the project's declaration as the fixture holds it. */
const hostOf = (clones: Record<string, string>) => ({ path: "/h.json", read: (() => hostFile(clones)) as never });
const refusalOf = (answer: { clone: string } | { refusal: string }) => ("refusal" in answer ? answer.refusal : undefined);

test("A11-292: the reviewer's seat for a pull request of .github carries the declared key, which the label reads back", () => {
  const label = reviewerSeat({ repoKey: "github", number: 6 });
  assert.equal(label, SESSION);
  assert.deepEqual(reviewerInstance(label), { key: "github", number: 6 });
});

test("A11-292: a reviewer of .github is checked out from clones[\".github\"]: the key finds the clone by the repository's name", () => {
  const git = fakeGit();
  const made = prepareReviewCheckout({ pr: 6, session: SESSION, ...git.seams });
  assert.deepEqual(made, { path: `/reviews-root/${SESSION}`, head: HEAD });
  const fetched = git.calls.find((args) => args.includes("fetch"));
  assert.deepEqual(fetched, ["-C", DOT_CLONE, "fetch", "--quiet", "origin", "+refs/pull/6/head:refs/review/github/pr-6"], "fetched from the clone the host lists under `.github`, into the key's ref");
  assert.ok(git.calls.some((args) => args.includes("worktree") && args[1] === DOT_CLONE && args.includes("add")), "the worktree is added IN that clone");
  assert.equal(noReviewCheckoutFor(SESSION), null);
  assert.equal(removeReviewCheckout({ pr: 6, session: SESSION, key: "github", ...git.seams, record: () => {} }), null);
  assert.ok(git.calls.some((args) => args[1] === DOT_CLONE && args.includes("update-ref") && args.includes("refs/review/github/pr-6")), "and taken down from the same clone");
});

test("A11-292: the key's own clone is asked first, so the hand-added alias `clones.github` still wins until it is removed", () => {
  assert.deepEqual(reviewCloneOf("github", hostOf({ ".github": DOT_CLONE, github: "/repos/alias" })), { clone: "/repos/alias" });
  assert.deepEqual(reviewCloneOf("github", hostOf({ github: "/repos/alias" })), { clone: "/repos/alias" });
});

test("A11-292: the name finds a clone only for the repository the key declares, and never the primary's or another declared repository's", () => {
  // The primary has no declared clone: its repository is `a11ign/a11ign`, and a clone named `a11ign` is not its reviewer's checkout.
  assert.match(String(refusalOf(reviewCloneOf("", hostOf({ a11ign: "/repos/a11y-witness" })))), /declares no absolute `clones.` path/);
  // A key that names no declared repository falls back to nothing.
  assert.match(String(refusalOf(reviewCloneOf("nothing", hostOf({ ".github": DOT_CLONE })))), /declares no absolute `clones.nothing` path$/);
  // The refusal for a declared key says both names it looked under.
  assert.match(String(refusalOf(reviewCloneOf("github", hostOf({})))), /declares no absolute `clones.github` path \(nor `clones..github`, the name of the declared repository\)$/);
  assert.match(String(refusalOf(cloneOfKey("github", { ...hostOf({}), declared: () => [] }))), /declares no absolute `clones.github` path$/, "with no declaration to read, the key alone is asked");
});

test("A11-292: a repository name that is another declared repository's key finds no clone", () => {
  const code = [{ key: "lib", repo: "a11ign/other" }, { key: "tools", repo: "a11ign/lib" }];
  assert.deepEqual(cloneOfDeclared({ lib: "/repos/other" }, "tools", code), { tried: ["tools"] }, "clones.lib is the checkout of the key `lib`, not of a11ign/lib");
  // ... nor a clone named for the PRIMARY's repository, nor for another declared repository of the same name under another owner.
  const primary = [{ key: "", repo: "a11ign/a11ign" }, { key: "x", repo: "other/a11ign" }, { key: "y", repo: "one/same" }, { key: "z", repo: "two/same" }];
  assert.deepEqual(cloneOfDeclared({ a11ign: "/repos/a11y-witness", same: "/repos/same" }, "x", primary), { tried: ["x"] }, "clones.a11ign is the primary's checkout");
  assert.deepEqual(cloneOfDeclared({ same: "/repos/same" }, "y", primary), { tried: ["y"] }, "two repositories of one name share no clone");
  assert.deepEqual(cloneOfDeclared({ lib: "/repos/other" }, "lib", code), { clone: "/repos/other" });
  assert.deepEqual(cloneOfDeclared({ ".github": DOT_CLONE }, "github", [{ key: "github", repo: "a11ign/.github" }]), { clone: DOT_CLONE });
  assert.deepEqual(cloneOfDeclared(undefined, "github", [{ key: "github", repo: "a11ign/.github" }]), { tried: ["github", ".github"] });
});

test("A11-292: the verify stamps of a .github pull request are looked for in the same clone", () => {
  const code = () => [{ key: "github", repo: "a11ign/.github" }];
  assert.equal(verifyCheckoutOf("github", () => ({ clones: { ".github": DOT_CLONE } }), code), DOT_CLONE);
  assert.equal(verifyCheckoutOf("github", () => ({ clones: {} }), code), undefined, "no clone is no checkout, never a guess");
  assert.equal(verifyCheckoutOf("agent-org", () => ({ clones: { "agent-org": "/repos/agent-org" } }), () => []), "/repos/agent-org", "a declaration that names nothing leaves the key's own clone found, as before");
});
