// no-token: gh -- the code host is the in-memory fake, git is a recorder, and the checkouts are scratch folders each holding a `.git/config`; nothing reaches `gh` or `git`
// A11-355: the organisation's repositories, listed live, and the clone of one the host has not got
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { addCloneToHostFile, cloneKeyOf, cloneRoot, ensureCloned, namedIn, ownersOf, readOrganisation, unclonedOf } from "./org-repos.ts";
import type { Git } from "./worktree.ts";

/** A checkout of `fullName` at `path`: a folder whose `.git/config` names its origin, which is all the board reads of a clone. */
function checkout(path: string, fullName: string): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/${fullName}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return path;
}

/** A machine with clones of acme/web (held as `main-app`) and acme/tools, and an organisation that also holds acme/corpus, acme/.github and an archived repository the listing leaves out. */
function machine() {
  const root = tmpDir("org-repos-");
  const clones: Record<string, string> = { "main-app": checkout(join(root, "repos", "web"), "acme/web"), tools: checkout(join(root, "repos", "tools"), "acme/tools") };
  const host = createFakeCodeHost("worker");
  host.seedRepositories("acme", ["acme/web", "acme/tools", "acme/corpus", "acme/.github"]);
  const hostFile = join(root, "host.json");
  writeFileSync(hostFile, `${JSON.stringify({ _prose: "kept", clones }, null, 2)}\n`);
  const calls: string[][] = [];
  const git: Git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === "clone") checkout(args[args.length - 1], /github\.com\/(.+?)\.git$/.exec(args[args.length - 2])![1]);
    return "";
  };
  return { root, clones, host, hostFile, git, calls };
}

test("the organisation is the owner of the clones' origins, listed live: every repository the code host gives", () => {
  const { clones, host } = machine();
  const read = readOrganisation(clones, host);
  assert.ok("repositories" in read);
  assert.deepEqual(read.repositories.map(({ fullName }) => fullName), ["acme/web", "acme/tools", "acme/corpus", "acme/.github"]);
});

test("a repository is cloned when no key names it and no clone's origin is it: a clone held under another key counts", () => {
  const { clones, host } = machine();
  const read = readOrganisation(clones, host);
  assert.ok("repositories" in read);
  assert.deepEqual(unclonedOf(read.repositories, clones, host).map(({ fullName }) => fullName), ["acme/corpus", "acme/.github"], "acme/web is held as `main-app`, which its origin says");
  assert.equal(cloneKeyOf({ name: "web", fullName: "acme/web" }, clones, host), "main-app");
  assert.equal(cloneKeyOf({ name: "tools", fullName: "acme/tools" }, clones, host), "tools");
  assert.equal(cloneKeyOf({ name: "corpus", fullName: "acme/corpus" }, clones, host), null);
});

test("an organisation that cannot be listed is unreadable, never empty: no origin, a code host that lists none, and a list the host would not give", () => {
  const { clones, host, root } = machine();
  assert.match(String((readOrganisation({ lone: join(root, "nowhere") }, host) as { unreadable: string }).unreadable), /no clone names the organisation/);
  const silent = createFakeCodeHost("worker");
  assert.match((readOrganisation(clones, silent) as { unreadable: string }).unreadable, /repositories of acme could not be listed/, "the fake cannot be asked about an owner it was not told of");
  assert.match((readOrganisation(clones, { ...host, repositories: undefined }) as { unreadable: string }).unreadable, /lists no repositories/);
});

test("a worker's sentence names a repository by its first word: owner/name, a bare name, or the key of a clone; an outsider or an unknown one names none", () => {
  const { clones, host } = machine();
  const read = readOrganisation(clones, host);
  assert.ok("repositories" in read);
  const named = (text: string) => namedIn(text, read.repositories, clones, host)?.fullName ?? null;
  assert.equal(named("acme/corpus: the backups code lives there"), "acme/corpus");
  assert.equal(named("ACME/Corpus"), "acme/corpus");
  assert.equal(named("corpus"), "acme/corpus");
  assert.equal(named("https://github.com/acme/corpus.git"), "acme/corpus");
  assert.equal(named("main-app: the clone is held under another key"), "acme/web");
  assert.equal(named(".github"), "acme/.github");
  assert.equal(named("corpus: the backups code lives there"), "acme/corpus", "a bare name before a colon");
  assert.equal(named("Corpus Backups belong to another team"), null, "a sentence that starts with a repository's name names none");
  assert.equal(named("Tools are not the problem here"), null);
  assert.equal(named("other-org/corpus: not ours"), null);
  assert.equal(named("acme/old-archive"), null, "an archived repository is not in the listing");
  assert.equal(named("a backend service"), null);
  assert.equal(named(""), null);
});

test("the clone root is the folder most clones are in", () => {
  assert.equal(cloneRoot({ a: "/r/a", b: "/r/b", c: "/elsewhere/c" }), "/r");
  assert.equal(cloneRoot({}), null);
});

test("cloning on demand: git clones the https address beside the others, the host file and the clones record it, and every other byte of the host file is kept", async () => {
  const { clones, host, hostFile, git, calls, root } = machine();
  const before = readFileSync(hostFile, "utf8");
  const key = await ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones, hostFile, codeHost: host, git });
  assert.equal(key, "corpus");
  assert.deepEqual(calls, [[join(root, "repos"), "clone", "--quiet", "https://github.com/acme/corpus.git", join(root, "repos", ".corpus.cloning")]], "git clones into a staging folder");
  assert.ok(existsSync(join(root, "repos", "corpus", ".git")) && !existsSync(join(root, "repos", ".corpus.cloning")), "which is renamed to the repository's folder once git is done");
  assert.equal(clones.corpus, join(root, "repos", "corpus"));
  const after = JSON.parse(readFileSync(hostFile, "utf8")) as { _prose: string; clones: Record<string, string> };
  assert.equal(after.clones.corpus, join(root, "repos", "corpus"));
  assert.equal(after._prose, "kept");
  assert.deepEqual(Object.keys(after.clones), ["main-app", "tools", "corpus"], "the others keep their keys and order");
  assert.ok(readFileSync(hostFile, "utf8").endsWith("\n") && before.endsWith("\n"));
});

test("a repository the host already holds is not cloned again, under whichever key it is held", async () => {
  const { clones, host, hostFile, git, calls } = machine();
  assert.equal(await ensureCloned({ name: "web", fullName: "acme/web" }, { clones, hostFile, codeHost: host, git }), "main-app");
  assert.equal(await ensureCloned({ name: "tools", fullName: "acme/tools" }, { clones, hostFile, codeHost: host, git }), "tools");
  assert.deepEqual(calls, []);
});

test("a folder named for a dot-repository is made without the dot, as `.github` is `github` here", async () => {
  const { clones, host, hostFile, git, root } = machine();
  assert.equal(await ensureCloned({ name: ".github", fullName: "acme/.github" }, { clones, hostFile, codeHost: host, git }), ".github");
  assert.equal(clones[".github"], join(root, "repos", "github"));
  assert.ok(existsSync(join(root, "repos", "github", ".git")));
});

test("a clone an earlier call made and never recorded is adopted, not cloned over; a folder that is something else is refused", async () => {
  const { clones, host, hostFile, git, calls, root } = machine();
  checkout(join(root, "repos", "corpus"), "acme/corpus");
  assert.equal(await ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones, hostFile, codeHost: host, git }), "corpus");
  assert.deepEqual(calls, [], "git was not run");
  assert.equal(JSON.parse(readFileSync(hostFile, "utf8")).clones.corpus, join(root, "repos", "corpus"));
  mkdirSync(join(root, "repos", "other"), { recursive: true });
  await assert.rejects(ensureCloned({ name: "other", fullName: "acme/other" }, { clones, hostFile, codeHost: host, git }), /exists and is not a clone of it/);
  assert.equal(clones.other, undefined, "nothing is recorded for a clone that was refused");
});

test("a clone git refuses is not recorded, and a name no folder can be made from is refused before git runs", async () => {
  const { clones, host, hostFile, calls, root } = machine();
  const refusing: Git = async () => { throw new Error("fatal: repository 'https://github.com/acme/corpus.git/' not found"); };
  await assert.rejects(ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones, hostFile, codeHost: host, git: refusing }), /not found/);
  assert.equal(clones.corpus, undefined);
  assert.equal(JSON.parse(readFileSync(hostFile, "utf8")).clones.corpus, undefined);
  for (const name of ["../escape", "a/b", "-flag", "", "..", "."]) {
    await assert.rejects(ensureCloned({ name, fullName: `acme/${name}` }, { clones, hostFile, codeHost: host, git: async () => { calls.push(["ran"]); return ""; } }), /cannot be cloned/, name);
  }
  assert.deepEqual(calls, [], "git never ran for those");
  assert.ok(!existsSync(join(root, "escape")));
});

test("a board with no host file, or no clone to say where clones go, says so and clones nothing", async () => {
  const { clones, host, git, calls } = machine();
  await assert.rejects(ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones, hostFile: undefined, codeHost: host, git }), /does not know its host file/);
  await assert.rejects(ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones: {}, hostFile: "/x", codeHost: host, git }), /holds no clone to say where/);
  assert.deepEqual(calls, []);
});

test("the host file is written whole and renamed over with its mode kept, and a key already there is replaced in place", () => {
  const { hostFile } = machine();
  chmodSync(hostFile, 0o640);
  addCloneToHostFile(hostFile, "tools", "/elsewhere/tools");
  assert.equal(JSON.parse(readFileSync(hostFile, "utf8")).clones.tools, "/elsewhere/tools");
  assert.equal(statSync(hostFile).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(dirname(hostFile)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
});

test("a key that shares only a name with another repository is not a clone of it, and a clone of a person's fork does not make the person an organisation", () => {
  const { clones, host, root } = machine();
  assert.equal(cloneKeyOf({ name: "tools", fullName: "acme/tools-fork" }, clones, host), null, "`tools` is the clone of acme/tools, not of acme/tools-fork");
  assert.equal(cloneKeyOf({ name: "tools", fullName: "other/tools" }, clones, host), null);
  const withFork = { ...clones, mine: checkout(join(root, "repos", "mine"), "someone/mine") };
  assert.deepEqual(ownersOf(withFork, host), ["acme"], "one clone of a fork beside the organisation's two");
  assert.deepEqual(ownersOf({ only: withFork.mine }, host), ["someone"], "the only owner is the organisation, whatever it is");
  assert.deepEqual(ownersOf({ a: checkout(join(root, "x", "a"), "p/a"), b: checkout(join(root, "x", "b"), "q/b") }, host), ["p", "q"], "no owner has more than one clone: all are kept");
});

test("a clone that stalls is given up on after the time it is given, but its folder stays taken until git ends: a second clone is refused meanwhile, and the abandoned folder is cleared when git ends", async () => {
  const { clones, host, hostFile, git, calls, root } = machine();
  const staging = join(root, "repos", ".corpus.cloning");
  const ends: { stop: () => void } = { stop: () => undefined };
  const stalled: Git = async (_cwd, args) => { checkout(args[args.length - 1], "acme/corpus"); return new Promise<string>((resolve) => { ends.stop = () => { resolve(""); }; }); };
  const repository = { name: "corpus", fullName: "acme/corpus" };
  await assert.rejects(ensureCloned(repository, { clones, hostFile, codeHost: host, git: stalled, timeoutMs: 20 }), /the clone of acme\/corpus took more than 20 ms/);
  assert.equal(clones.corpus, undefined);
  assert.ok(existsSync(staging), "git is still writing there, so nothing is removed under it");
  await assert.rejects(ensureCloned(repository, { clones, hostFile, codeHost: host, git, timeoutMs: 20 }), /an earlier clone of it is still running/);
  assert.deepEqual(calls, [], "no second git was started beside the first");
  ends.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!existsSync(staging), "the abandoned clone is cleared once git has ended");
  assert.equal(await ensureCloned(repository, { clones, hostFile, codeHost: host, git }), "corpus", "and the folder is free for a clone again");
  assert.equal(calls.length, 1);
});

test("a staging folder an earlier clone left is never taken for a clone: it is cleared, and the clone is made again", async () => {
  const { clones, host, hostFile, git, calls, root } = machine();
  checkout(join(root, "repos", ".corpus.cloning"), "acme/corpus");
  writeFileSync(join(root, "repos", ".corpus.cloning", "half-made"), "x");
  assert.equal(await ensureCloned({ name: "corpus", fullName: "acme/corpus" }, { clones, hostFile, codeHost: host, git }), "corpus");
  assert.equal(calls.length, 1, "cloned afresh");
  assert.ok(!existsSync(join(root, "repos", "corpus", "half-made")));
});

test("a host file that is a link is written where it points, and stays a link", () => {
  const { hostFile, root } = machine();
  const target = join(root, "real-host.json");
  writeFileSync(target, readFileSync(hostFile, "utf8"));
  const link = join(root, "linked-host.json");
  symlinkSync(target, link);
  addCloneToHostFile(link, "corpus", "/elsewhere/corpus");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(target, "utf8")).clones.corpus, "/elsewhere/corpus");
});
