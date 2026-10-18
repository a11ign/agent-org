// no-token: gh -- a fixture git repository in a temp directory, an injected herdr listing and recorders; nothing real is touched (a11ign#5127)
// #5127: after a hard crash the host restores truncated tracked files, moves empty git files aside and refetches, resumes dead panes with the right flags,
// and does NOTHING on a clean boot. EACH "does nothing" ASSERTION SHARES A FIXTURE WITH ITS POSITIVE TWIN: the same tree with one thing changed that DOES fire.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { sandboxGitEnv } from "./lib/git-env.ts";
import {
  crashRecoverEnabled, detectUncleanBoot, emptyGitFiles, lastTurnProfiles, planPaneActions, recover, repairGit, repeatCrash, restoreTruncated, resumeCommand,
  withLaunchFlags, writeFileAtomic, type HerdrAgent, type Ports,
} from "./crash-recover.ts";

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, args: string[]) => {
  try { return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { ok: false, out: String(e) }; }
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }) });

/** An `origin` and a clone of it, with `project.json` and `notes.md` committed non-empty. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "crash-recover-"));
  made.push(root);
  const origin = join(root, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "project.json"), '{"a":1}\n');
  writeFileSync(join(origin, "notes.md"), "notes\n");
  writeFileSync(join(origin, "empty-by-design.txt"), "");
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "init");
  const clone = join(root, "clone");
  sh(root, "clone", "-q", origin, clone);
  return { root, origin, clone };
}

const agent = (name: string, over: Partial<HerdrAgent> = {}): HerdrAgent => ({
  name, pane_id: `p-${name}`, agent: null, agent_session: { agent: "claude", value: "11111111-2222-3333-4444-555555555555" }, ...over,
});

function ports(over: Partial<Omit<Ports, "checkouts">> & { checkouts: string[]; agents?: HerdrAgent[]; unclean?: boolean }): { p: Ports; calls: string[][]; said: string[]; woke: string[] } {
  const calls: string[][] = [];
  const said: string[] = [];
  const woke: string[] = [];
  let seen: { id: string; at: number }[] = [];
  const { checkouts: _c, agents: _a, unclean: _u, ...rest } = over;
  const p: Ports = {
    now: () => 1_000_000, pstoreIds: () => (over.unclean ? ["1791741935"] : []), readPstore: () => "a\nb\nlast words\n", journalText: () => "",
    git, checkouts: () => over.checkouts, asideDir: join(over.checkouts[0], "..", "aside"), seenPath: "", readSeen: () => seen, writeSeen: (s) => { seen = s; },
    herdrAgents: () => over.agents ?? [], herdr: (a) => { calls.push(a); },
    seatProfiles: () => new Map([["ceo", { model: "opus", effort: "high" }]]), traced: () => new Map(),
    prepare: async () => {}, flagsFor: (a) => (a.role === "seat" ? ["--seat-flags"] : ["--worker-flags"]), hostPath: () => "/fixture/host.json",
    resetFailed: () => { calls.push(["reset-failed"]); }, announce: (t) => { said.push(t); }, fileIncident: () => {}, wakeCeo: (t) => { woke.push(t); }, log: () => {},
    ...rest,
  } as Ports;
  return { p, calls, said, woke };
}

test("a 0-byte tracked file that is non-empty at HEAD is restored; a file empty at HEAD, and an untracked empty file, are not", () => {
  const { clone } = fixture();
  writeFileSync(join(clone, "project.json"), "");
  writeFileSync(join(clone, "untracked-empty"), "");
  assert.deepEqual(restoreTruncated(clone, git), ["project.json"]);
  assert.equal(readFileSync(join(clone, "project.json"), "utf8"), '{"a":1}\n');
  assert.equal(existsSync(join(clone, "untracked-empty")), true);
  assert.deepEqual(restoreTruncated(clone, git), [], "idempotent: nothing left to restore");
});

test("an edited (non-empty) tracked file is never touched", () => {
  const { clone } = fixture();
  writeFileSync(join(clone, "notes.md"), "my uncommitted edit\n");
  assert.deepEqual(restoreTruncated(clone, git), []);
  assert.equal(readFileSync(join(clone, "notes.md"), "utf8"), "my uncommitted edit\n");
});

test("an empty loose object is moved aside and refetched, fsck is clean, and the moved file is kept", () => {
  const { root, clone } = fixture();
  const sha = sh(clone, "rev-parse", "HEAD:notes.md").trim();
  const loose = join(clone, ".git/objects", sha.slice(0, 2), sha.slice(2));
  rmSync(loose); // git writes objects read-only; the crash left a fresh empty file in its place
  writeFileSync(loose, "");
  assert.equal(git(clone, ["cat-file", "-p", sha]).ok, false, "control: the corruption is real before the repair");
  assert.deepEqual(emptyGitFiles(join(clone, ".git")).filter((f) => f === loose), [loose]);
  const repair = repairGit({ checkout: clone, git, aside: join(root, "aside") });
  assert.equal(repair.moved >= 1, true);
  assert.equal(repair.fetched, true);
  assert.equal(repair.fsck, "clean");
  assert.equal(git(clone, ["cat-file", "-p", sha]).out, "notes\n", "the object is back");
  assert.equal(readdirSync(join(root, "aside", "clone")).some((n) => n.includes(sha.slice(2))), true, "moved aside, not deleted");
});

test("a checkout with no empty git file is left alone: no fetch, no move", () => {
  const { root, clone } = fixture();
  assert.deepEqual(repairGit({ checkout: clone, git, aside: join(root, "aside") }), { checkout: clone, moved: 0, fetched: false, fsck: "skipped" });
});

test("a dead seat resumes with the seat flags, a dead worker with the worker flags, a reviewer pane is closed, a session-less pane is named and skipped", () => {
  const actions = planPaneActions({
    agents: [agent("ceo"), agent("worker-5127"), agent("reviewer-9", { agent_session: { agent: "codex", value: "x" } }), agent("worker-1", { agent_session: null }), agent("alive", { agent: "claude" })],
    seatProfiles: new Map([["ceo", { model: "opus" }]]), traced: new Map([["11111111-2222-3333-4444-555555555555", { model: "sonnet", effort: "high" }]]),
  });
  assert.deepEqual(actions.map((a) => `${a.kind}:${a.name}`), ["resume:ceo", "resume:worker-5127", "close:reviewer-9", "skip:worker-1"]);
  const ceo = actions[0] as Extract<(typeof actions)[number], { kind: "resume" }>;
  assert.equal(ceo.role, "seat");
  assert.equal(resumeCommand(ceo, ["--model", "opus"]), "claude --resume 11111111-2222-3333-4444-555555555555 --model opus");
  assert.equal((actions[1] as typeof ceo).role, "worker");
});

test("a resumed seat and a resumed worker both type AGENT_ORG_HOST in front of the resume, so a pane started after a crash has the host declaration (#1484)", () => {
  const actions = planPaneActions({
    agents: [agent("ceo"), agent("worker-5127")], seatProfiles: new Map([["ceo", { model: "opus" }]]), traced: new Map(),
  });
  const [seat, worker] = actions as Extract<(typeof actions)[number], { kind: "resume" }>[];
  assert.equal(resumeCommand(seat, ["--model", "opus"], "/home/agent/repos/a11y-witness/.agent-org/host.json"),
    "AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json claude --resume 11111111-2222-3333-4444-555555555555 --model opus");
  assert.equal(resumeCommand(worker, ["--worker-flags"], "/home/agent/repos/a11y-witness/.agent-org/host.json"),
    "AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json claude --resume 11111111-2222-3333-4444-555555555555 --worker-flags");
  assert.equal(resumeCommand(worker, ["--worker-flags"], "/srv/my host/host.json"),
    "AGENT_ORG_HOST='/srv/my host/host.json' claude --resume 11111111-2222-3333-4444-555555555555 --worker-flags", "a path with a space is quoted, not split");
});

test("the production launch wiring takes the host path from host-config.ts, so a resumed pane is never typed without AGENT_ORG_HOST (#1484)", async () => {
  const tool = mkdtempSync(join(tmpdir(), "crash-tool-"));
  made.push(tool);
  mkdirSync(join(tool, "src"), { recursive: true });
  writeFileSync(join(tool, "src/wake.ts"), "export {};\n");
  mkdirSync(join(tool, "src/wake"));
  writeFileSync(join(tool, "src/wake/is-release-line.ts"), "export {};\n");
  writeFileSync(join(tool, "src/worker-profile.ts"), "export {};\n");
  writeFileSync(join(tool, "src/host-config.ts"), "export function hostConfigPath() { return \"/fixture/tool/host.json\"; }\n");
  const wired = withLaunchFlags(ports({ checkouts: [tool] }).p, tool);
  await wired.prepare();
  assert.equal(wired.hostPath(), "/fixture/tool/host.json", "the path comes from the tool's own host-config.ts, not a second copy of the resolution");
});

test("recover on an unclean boot restores, resumes with role flags, closes reviewers, resets failed units and announces once", async () => {
  const { clone } = fixture();
  writeFileSync(join(clone, "project.json"), "");
  const { p, calls, said } = ports({ checkouts: [clone], unclean: true, agents: [agent("ceo"), agent("worker-7"), agent("reviewer-3", { agent_session: { agent: "codex", value: "z" } })] });
  const report = await recover(p);
  assert.deepEqual(report.restored, ["clone:project.json"]);
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(" ")), ["pane run", "pane run", "pane close", "reset-failed"]);
  assert.match(calls[0][3], /--seat-flags$/);
  assert.match(calls[1][3], /--worker-flags$/);
  assert.match(calls[0][3], /^AGENT_ORG_HOST=\/fixture\/host\.json claude --resume /);
  assert.equal(said.length, 1);
  assert.match(said[0], /Restored 1 truncated/);
});

test("recover on a clean boot does nothing, even with a truncated file and a dead pane present (the twin of the case above)", async () => {
  const { clone } = fixture();
  writeFileSync(join(clone, "project.json"), "");
  const { p, calls, said } = ports({ checkouts: [clone], unclean: false, agents: [agent("ceo")] });
  const report = await recover(p);
  assert.deepEqual(calls, []);
  assert.deepEqual(said, []);
  assert.equal(report.detection.unclean, false);
  assert.equal(readFileSync(join(clone, "project.json"), "utf8"), "");
});

test("an unclean boot is detected from journald alone or from a new pstore record, and a pstore record already seen is not a new crash", () => {
  assert.equal(detectUncleanBoot({ pstoreIds: [], seen: new Set(), journalText: "x uncleanly shut down y" }).unclean, true);
  assert.equal(detectUncleanBoot({ pstoreIds: ["1"], seen: new Set(), journalText: "" }).unclean, true);
  assert.equal(detectUncleanBoot({ pstoreIds: ["1"], seen: new Set(["1"]), journalText: "" }).unclean, false);
});

test("a second hard crash inside seven days wakes ceo; a first one, or two a month apart, does not", async () => {
  const DAY = 86_400_000;
  assert.equal(repeatCrash([0, 3 * DAY], 4 * DAY), true);
  assert.equal(repeatCrash([0, 30 * DAY], 31 * DAY), false);
  assert.equal(repeatCrash([30 * DAY], 31 * DAY), false);
  const { clone } = fixture();
  const first = ports({ checkouts: [clone], unclean: true });
  first.p.readSeen = () => [{ id: "1790893277", at: 1_000_000 - 4 * DAY }];
  await recover(first.p);
  assert.equal(first.woke.length, 1);
  const lone = ports({ checkouts: [clone], unclean: true });
  await recover(lone.p);
  assert.equal(lone.woke.length, 0);
});

test("the flag is on unless it is exactly false; a torn trace line is skipped; an atomic write leaves the whole file", () => {
  assert.equal(crashRecoverEnabled({}), true);
  assert.equal(crashRecoverEnabled({ crashRecover: false }), false);
  assert.deepEqual([...lastTurnProfiles('{"kind":"turn","transcript":"t","model":"opus","effort":"max"}\n{"kind":"turn","tran')], [["t", { model: "opus", effort: "max" }]]);
  const dir = mkdtempSync(join(tmpdir(), "crash-atomic-"));
  made.push(dir);
  writeFileAtomic(join(dir, "state.json"), "{}\n");
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{}\n");
  assert.deepEqual(readdirSync(dir), ["state.json"], "no temp file left behind");
});
