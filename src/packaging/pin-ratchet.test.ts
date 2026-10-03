/**
 * (#3232) THE RATCHET (`lib/pin-ratchet.mjs`) SHOWN ON THE FAILURE IT EXISTS FOR: two pull requests that each add ONE entry to a pinned
 * population are each green against their own base and must still be green merged, in EITHER order.
 *
 * A throwaway repository holds a population (`pop/<name>`), its declarations (`declared.txt`, one `name: reason` per line, sorted, so two
 * branches that insert at different places merge without a textual conflict) and the OLD form's shared total (`count.txt`). Two branches add a
 * different entry each, declared, and bump the total the way each author honestly would. They are merged in both orders and each merge result
 * is judged against ITS first parent, which is what `merge_group` hands the gate (`HEAD^1`).
 *
 *   - the ratchet is GREEN at every merge, in both orders (the done-when);
 *   - `LEGACY_EXACT`, the old equality against a shared total, is RED at the SECOND merge in both orders: both authors changed `3` to `4`
 *     identically, which git merges without complaint into a total that is one short;
 *   - POSITIVE CONTROLS: an UNDECLARED entry is red under the ratchet, an entry whose declaration has no reason is red, and a branch that
 *     REMOVES one is green (`LEGACY_EXACT` is red on it, which is the second fault the ratchet drops);
 *   - the base is READ: an entry held at the base with no declaration passes only where a base was readable, so a green ratchet is not
 *     the strict form wearing its name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgePin, resolveBase, type Declaration } from "../lib/pin-ratchet.mjs";
import { withGitSandbox, type GitSandbox } from "../lib/git-sandbox.ts";

const QUEUE = { GITHUB_EVENT_NAME: "merge_group" };
const SEED = ["b", "m", "y"];

const scan = (root: string): string[] => readdirSync(join(root, "pop")).sort();

function declarationsIn(dir: string): Declaration[] {
  return readFileSync(join(dir, "declared.txt"), "utf8").split("\n").filter(Boolean).map((line) => {
    const [name, ...reason] = line.split(": ");
    return { name, reason: reason.join(": ") };
  });
}

/** The converted check at the tree `dir` holds, against its first parent. */
function ratchetAt(dir: string, env: NodeJS.ProcessEnv = QUEUE) {
  return judgePin({ repo: dir, paths: ["pop"], scan, current: scan(dir), declared: declarationsIn(dir), env });
}

/** The OLD form, kept so the pair above can be shown red under it: the population must EQUAL the shared total. */
const LEGACY_EXACT = (dir: string): string[] =>
  scan(dir).length === Number(readFileSync(join(dir, "count.txt"), "utf8")) ? [] : [`${scan(dir).length} entries, ${readFileSync(join(dir, "count.txt"), "utf8").trim()} recorded`];

function write(box: GitSandbox, path: string, text: string): void {
  mkdirSync(join(box.dir, path, ".."), { recursive: true });
  writeFileSync(join(box.dir, path), text);
}

function declare(box: GitSandbox, lines: string[]): void {
  write(box, "declared.txt", `${[...lines].sort().join("\n")}\n`);
}

/** `main` holds `SEED`, each declared with a reason, and a total of 3. */
function seed(box: GitSandbox): void {
  box.run(["init", "-q", "-b", "main"]);
  for (const name of SEED) write(box, `pop/${name}`, "");
  declare(box, SEED.map((name) => `${name}: reason for ${name}`));
  write(box, "count.txt", "3\n");
  box.run(["add", "-A"]);
  box.commit("seed");
}

/** A branch off `main` adding ONE entry, declared unless `reason` is null, and bumping the shared total as its author honestly would. */
function branchAdding(box: GitSandbox, branch: string, name: string, reason: string | null = `reason for ${name}`): void {
  box.run(["checkout", "-q", "-b", branch, "main"]);
  write(box, `pop/${name}`, "");
  declare(box, [...declarationsIn(box.dir).map((d) => `${d.name}: ${d.reason}`), ...(reason === null ? [] : [`${name}: ${reason}`])]);
  write(box, "count.txt", `${scan(box.dir).length}\n`);
  box.run(["add", "-A"]);
  box.commit(`add ${name}`);
}

function merge(box: GitSandbox, branch: string): void {
  box.run(["-c", "user.name=Git Sandbox Test", "-c", "user.email=git-sandbox-test@example.invalid", "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch]);
}

/** Merge `branches` into `main` one after another, returning each merge result's verdicts. */
function mergeInOrder(box: GitSandbox, branches: string[]) {
  box.run(["checkout", "-q", "main"]);
  return branches.map((branch) => {
    merge(box, branch);
    return { branch, ratchet: ratchetAt(box.dir), legacy: LEGACY_EXACT(box.dir), population: scan(box.dir) };
  });
}

function twoBranches(box: GitSandbox): void {
  seed(box);
  branchAdding(box, "adds-c", "c");
  branchAdding(box, "adds-p", "p");
}

test("POSITIVE CONTROL: the seed is green under both forms, and the ratchet read a BASE", () => {
  withGitSandbox((box) => {
    seed(box);
    box.run(["checkout", "-q", "-b", "next"]);
    write(box, "note", "x");
    box.run(["add", "-A"]);
    box.commit("a change that adds nothing to the population");
    const verdict = ratchetAt(box.dir);
    assert.deepEqual(verdict.undeclared, []);
    assert.match(verdict.judged, /^as a ratchet against /, "the base was not read, so the green below would be the strict form");
    assert.deepEqual(LEGACY_EXACT(box.dir), []);
    assert.deepEqual(scan(box.dir), SEED, "an empty population would make every verdict here vacuously green");
  });
});

for (const order of [["adds-c", "adds-p"], ["adds-p", "adds-c"]]) {
  test(`two changes that each add one declared entry: the RATCHET is green at both merges, ${order.join(" then ")}`, () => {
    withGitSandbox((box) => {
      twoBranches(box);
      const results = mergeInOrder(box, order);
      assert.deepEqual(results.map((r) => r.population.length), [4, 5], "the second merge must hold BOTH additions");
      for (const { branch, ratchet } of results) {
        assert.deepEqual(ratchet.undeclared, [], `merge of ${branch}: ${ratchet.judged}`);
        assert.match(ratchet.judged, /^as a ratchet against /);
      }
    });
  });

  test(`the same pair under LEGACY_EXACT is green at the first merge and RED at the second, ${order.join(" then ")}`, () => {
    withGitSandbox((box) => {
      twoBranches(box);
      const [first, second] = mergeInOrder(box, order);
      assert.deepEqual(first.legacy, [], "the first merge is an honest single change, green under the old form too");
      assert.equal(second.legacy.length, 1, "both authors changed the total 3 to 4 identically, so it merged to 4 beside a population of 5");
      assert.match(second.legacy[0], /5 entries, 4 recorded/);
    });
  });
}

test("POSITIVE CONTROL: ONE change adding an UNDECLARED entry is red under the ratchet, naming it", () => {
  withGitSandbox((box) => {
    seed(box);
    branchAdding(box, "adds-q", "q", null);
    box.run(["checkout", "-q", "main"]);
    merge(box, "adds-q");
    assert.deepEqual(ratchetAt(box.dir).undeclared, ["q"]);
  });
});

test("POSITIVE CONTROL: a declaration with no reason does not declare", () => {
  withGitSandbox((box) => {
    seed(box);
    branchAdding(box, "adds-q", "q", "  ");
    box.run(["checkout", "-q", "main"]);
    merge(box, "adds-q");
    assert.deepEqual(ratchetAt(box.dir).undeclared, ["q"]);
  });
});

test("POSITIVE CONTROL: a change that REMOVES an entry is green under the ratchet and red under LEGACY_EXACT", () => {
  withGitSandbox((box) => {
    seed(box);
    box.run(["checkout", "-q", "-b", "removes-b", "main"]);
    rmSync(join(box.dir, "pop/b"));
    box.run(["add", "-A"]);
    box.commit("remove b");
    box.run(["checkout", "-q", "main"]);
    merge(box, "removes-b");
    assert.deepEqual(scan(box.dir), ["m", "y"]);
    assert.deepEqual(ratchetAt(box.dir).undeclared, []);
    assert.equal(LEGACY_EXACT(box.dir).length, 1, "the old form fails on a shrink, which is a fault nobody has");
  });
});

function legacyEntryHeldAtBase(box: GitSandbox): void {
  seed(box);
  write(box, "pop/legacy-entry", "");
  box.run(["add", "-A"]);
  box.commit("an entry that predates the ratchet, undeclared");
  box.run(["checkout", "-q", "-b", "next"]);
  write(box, "note", "x");
  box.run(["add", "-A"]);
  box.commit("a later change");
  box.run(["update-ref", "refs/remotes/origin/main", "main"]);
}

test("an entry the BASE already held needs no declaration, because the base was read", () => {
  withGitSandbox((box) => {
    legacyEntryHeldAtBase(box);
    const ratchet = ratchetAt(box.dir, {});
    assert.match(ratchet.judged, /^as a ratchet against /);
    assert.deepEqual(ratchet.undeclared, [], ratchet.judged);
  });
});

test("POSITIVE CONTROL: the STRICT form, where no base can be read, grandfathers nothing and says why it ran", () => {
  withGitSandbox((box) => {
    legacyEntryHeldAtBase(box);
    const inside = join(box.dir, "pop");
    const strict = judgePin({ repo: inside, paths: ["pop"], scan, current: scan(box.dir), declared: declarationsIn(box.dir), env: QUEUE });
    assert.match(strict.judged, /^strictly, with nothing grandfathered \(.*not a repository of its own/);
    assert.ok(strict.undeclared.includes("legacy-entry"), "an entry nobody declared is refused when there is no base to excuse it");
  });
});

test("resolveBase: HEAD^1 on merge_group, the merge-base with origin/main on a pull request, and a REASON where neither can be read", () => {
  withGitSandbox((box) => {
    twoBranches(box);
    box.run(["update-ref", "refs/remotes/origin/main", "main"]);
    const main = box.run(["rev-parse", "main"]).trim();
    box.run(["checkout", "-q", "adds-c"]);
    assert.deepEqual(resolveBase(box.dir, {}), { ref: main }, "a pull request branch's base is where it left origin/main");
    box.run(["checkout", "-q", "main"]);
    merge(box, "adds-c");
    const afterC = box.run(["rev-parse", "HEAD"]).trim();
    merge(box, "adds-p");
    assert.deepEqual(resolveBase(box.dir, QUEUE), { ref: afterC }, "the queue's merge commit names the tip it merged into as its first parent");
    box.run(["update-ref", "-d", "refs/remotes/origin/main"]);
    const unreadable = resolveBase(box.dir, {});
    assert.ok("unreadable" in unreadable && /origin\/main/.test(unreadable.unreadable), JSON.stringify(unreadable));
  });
});
