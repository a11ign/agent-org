// no-token: gh -- every `gh`, `git`, `herdr` and `row-claim` call here is an injected seam, and nothing is written (a11ign/agent-org#834)
/**
 * agent-org#834: A STALL RELEASE FOR A CLAIMED ROW IN A SECOND DECLARED TRACKER LANDS. `stillHolds` read the HOME repository's row and `row-claim decline` was run
 * without `--tracker=`, so a release of `agent-org#476` read home #476, found no `session:` label on it and was refused as stale on every tick.
 *
 * EVERY "NOTHING WAS DONE" ASSERTION HAS A TWIN, the same request with ONE thing changed that IS done: a performer that never releases turns the twins red, and
 * one that always releases turns the controls red.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { performRelease } from "./wake/ci-class-and-spares.ts";
import { REPO } from "./project-identity.ts";

type Request = Parameters<typeof performRelease>[0];
type Deps = Parameters<typeof performRelease>[1];

const NOW = Date.parse("2026-10-11T10:00:00Z");
const PRIMARY = "/home/agent/repos/a11y-witness";
const CLONE = "/home/agent/repos/agent-org";
const OTHER_REPO = "a11ign/agent-org";
const HOLDER = "worker-agent-org-476";

const KEYED: Request = { row: 476, tracker: "agent-org", session: HOLDER, why: "stalled", branch: "agent/x-agent-org-476", worktree: "/home/agent/repos/wt-agent-org-476",
  idleMinutes: 250, nudgedAt: NOW - 130 * 60_000 };
const HOME: Request = { row: 476, session: "worker-476", why: "stalled", branch: "agent/x-476", worktree: "/home/agent/repos/wt-476", idleMinutes: 250, nudgedAt: NOW - 130 * 60_000 };

/**
 * A release host. `labels` answers `gh issue view` by the repository it was asked in (`null` is a read that fails), `onOrigin` names the checkout in which the
 * holder's branch is on `origin`, so a tree read in the wrong checkout reads as "nothing to keep".
 */
function host({ labels = {}, onOrigin = [CLONE], clone = { clone: CLONE } as { clone: string } | { refusal: string } }:
  { labels?: Record<string, string[] | null>; onOrigin?: string[]; clone?: { clone: string } | { refusal: string } } = {}) {
  const gh: string[][] = [];
  const execs: { cmd: string; args: string[]; cwd: string }[] = [];
  const git: { dir: string; args: string[] }[] = [];
  const closed: string[][] = [];
  const kept: [number, unknown][] = [];
  const cycles: unknown[] = [];
  const deps: Deps = {
    run: (args) => {
      if (args.includes("list")) return JSON.stringify({ result: { workspaces: [{ label: HOLDER, workspace_id: "w1", agent_status: "idle" }, { label: "worker-476", workspace_id: "w2", agent_status: "idle" }] } });
      if (args.includes("close")) closed.push(args);
      return "";
    },
    exec: (cmd, args, opts) => {
      execs.push({ cmd, args, cwd: opts.cwd });
      return cmd === "node" && args[1] === "decline" ? { status: 0, output: "DECLINED -- unclaimed again and restored to `ready`\n" } : { status: 0, output: "" };
    },
    io: {
      git: (dir, args) => {
        git.push({ dir, args });
        if (args[0] === "rev-parse") return { status: onOrigin.includes(dir) ? 0 : 1, out: "" };
        return { status: 0, out: args[0] === "rev-list" ? "0\n" : "" };
      },
      exists: () => true, mtime: () => null },
    now: NOW, agents: [{ label: HOLDER, status: "idle" }, { label: "worker-476", status: "idle" }], isSpare: () => true,
    host: { worktreesDir: "/home/agent/repos", primary: PRIMARY, exists: () => true }, env: {}, warn: () => {},
    gh: (args) => {
      gh.push(args);
      if (args[1] !== "view") return "";
      const repo = args[args.indexOf("--repo") + 1];
      const named = labels[repo] === undefined ? ["in-progress", `session:${HOLDER}`, "session:worker-476"] : labels[repo];
      if (named === null) throw new Error("gh: refused");
      return JSON.stringify({ labels: named.map((name) => ({ name })) });
    },
    cycle: (c) => { cycles.push(c); }, dropInstance: () => ({ spawnedAt: 1, rows: [476] }), keepInstance: (_role, row) => ({ spawnedAt: 1, rows: [row] }),
    remember: (row, k) => { kept.push([row, k]); },
    trackerRepo: (key) => (key === "agent-org" ? OTHER_REPO : null), cloneOf: () => clone,
  };
  const decline = () => execs.find((e) => e.cmd === "node" && e.args[1] === "decline");
  const reads = () => gh.filter((a) => a[1] === "view").map((a) => a[a.indexOf("--repo") + 1]);
  const comments = () => gh.filter((a) => a[1] === "comment");
  return { deps, gh, execs, git, closed, kept, cycles, decline, reads, comments };
}

test("a release of a second tracker's row reads THAT tracker's labels and declines with `--tracker=<key>`, from the tracker's clone (twin: the home row, without the flag)", () => {
  const r = host();
  const got = performRelease(KEYED, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.deepEqual(r.reads(), [OTHER_REPO], "the row was read in the tracker's repository, and in no other");
  const decline = r.decline();
  assert.ok(decline, "and declined");
  assert.deepEqual(decline.args.slice(1), ["decline", "476", `--session=${HOLDER}`, "--tracker=agent-org", "--keep-worktree", "--predecessor-gone"],
    "with the tracker's key; the branch is on origin IN THE CLONE, so the tree is kept (a read in the primary would have said nothing to keep)");
  assert.match(decline.cwd, /\/role-worker-agent-org-476$/, "from the holder's launch worktree");
  assert.ok(r.execs.some((e) => e.cmd === "git" && e.cwd === CLONE && e.args[0] === "fetch"), "which is made from the tracker's clone, as the spawn's is");
  assert.equal(r.execs.some((e) => e.cmd === "git" && e.cwd === PRIMARY), false, "and the primary's checkout was not touched");
  assert.match(got.why, /^agent-org#476 \(worker-agent-org-476, stalled\)/, "the line names the row with its tracker, so it is not read as home #476");

  const twin = host();
  assert.equal(performRelease(HOME, twin.deps).released, true);
  assert.deepEqual(twin.reads(), [REPO], "twin: the home row is read in the home repository");
  assert.deepEqual(twin.decline()!.args.slice(1), ["decline", "476", "--session=worker-476"], "twin: without the flag, and nothing on origin in the primary, so no tree kept");
  assert.equal(twin.decline()!.args.some((a) => a.startsWith("--tracker")), false);
});

test("the comment goes on the tracker's row and the kept-tree ledger is not written for it (twin: the home row's comment and record)", () => {
  const r = host();
  performRelease(KEYED, r.deps);
  assert.deepEqual(r.comments().map((a) => a[a.indexOf("--repo") + 1]), [OTHER_REPO], "the home tracker's #476 is not commented on");
  assert.match(r.comments()[0].join(" "), /Claim released by the gate \(#2470\)\..*`worker-agent-org-476`/s);
  assert.deepEqual(r.kept, [], "the kept-tree ledger is keyed by the home tracker's row number, so a keyed release neither writes nor deletes under it");

  const twin = host({ onOrigin: [PRIMARY] });
  performRelease(HOME, twin.deps);
  assert.deepEqual(twin.comments().map((a) => a[a.indexOf("--repo") + 1]), [REPO], "twin: the home row's comment is in the home repository");
  assert.equal(twin.kept.length, 1, "twin: and the home row's tree is recorded");
  assert.deepEqual([twin.kept[0][0], (twin.kept[0][1] as { worktree: string }).worktree], [476, HOME.worktree]);
});

test("a second tracker's row whose label no longer names the holder is refused as STALE: nothing closed, declined or commented (twin: the label present)", () => {
  const r = host({ labels: { [OTHER_REPO]: ["in-progress", "session:worker-agent-org-999"] } });
  const got = performRelease(KEYED, r.deps);
  assert.equal(got.released, false);
  assert.match(got.why, /`session:worker-agent-org-476` is no longer on agent-org#476 -- a stale order/);
  assert.deepEqual(r.reads(), [OTHER_REPO], "it was read THERE: the home row, which does carry a session label, did not answer for it");
  assert.equal(r.decline(), undefined, "no decline");
  assert.deepEqual(r.closed, [], "and the holder's workspace was not ended");
  assert.deepEqual(r.comments(), [], "and no comment");

  // THE HOME ROW CARRIES THE LABEL IN THIS FIXTURE (`labels` default), which is how a read in the wrong repository would have released it
  assert.equal(performRelease(KEYED, host().deps).released, true, "twin: the same request with the label on the tracker's row is released");
});

test("an UNREADABLE second tracker is `null`: no decline, nothing closed, and a reason that says it will be retried (twin: readable)", () => {
  const r = host({ labels: { [OTHER_REPO]: null } });
  const got = performRelease(KEYED, r.deps);
  assert.equal(got.released, false);
  assert.match(got.why, /could not read agent-org#476's labels -- not released, retried next tick/);
  assert.doesNotMatch(got.why, /stale/, "an unread tracker is not a row that is no longer held");
  assert.equal(r.decline(), undefined);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.comments(), []);
  assert.equal(performRelease(KEYED, host().deps).released, true, "twin: read, the same request lands");
});

test("a tracker the project does not declare, or whose clone the host does not give, is refused BEFORE anything is read or written (twin: declared with a clone)", () => {
  const undeclared = host();
  const got = performRelease({ ...KEYED, tracker: "no-such-tracker" }, undeclared.deps);
  assert.equal(got.released, false);
  assert.match(got.why, /no-such-tracker#476: the project declares no tracker `no-such-tracker` -- not released, retried next tick/);
  assert.deepEqual([undeclared.gh, undeclared.execs, undeclared.closed], [[], [], []], "nothing asked, nothing run, and the home row of that number untouched");

  // the LIVE declaration answers when the seam is not given: a key the project does not declare is no tracker, whatever the home one is
  const live = host();
  const { trackerRepo: _trackerRepo, ...liveDeps } = live.deps;
  assert.match(performRelease({ ...KEYED, tracker: "no-such-tracker" }, liveDeps).why, /the project declares no tracker/);
  assert.deepEqual(live.gh, []);

  const noClone = host({ clone: { refusal: "host.json declares no absolute `clones.agent-org` path" } });
  const refused = performRelease(KEYED, noClone.deps);
  assert.deepEqual([noClone.gh, noClone.execs, noClone.closed], [[], [], []], "the clone is asked before the row is read, so a refusal changes nothing");
  assert.equal(refused.released, false);
  assert.match(refused.why, /agent-org#476: no clone of tracker `agent-org` to read its tree in \(host\.json declares no absolute `clones\.agent-org` path\)/);

  assert.equal(performRelease(KEYED, host().deps).released, true, "twin: declared, with a clone");
});

test("`tracker: \"\"` is the home tracker's key, spelled out: it reads, comments and declines as an absent one does", () => {
  const r = host();
  assert.equal(performRelease({ ...HOME, tracker: "" }, r.deps).released, true);
  assert.deepEqual(r.reads(), [REPO]);
  assert.equal(r.decline()!.args.some((a) => a.startsWith("--tracker")), false);
});
