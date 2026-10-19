// no-token: gh -- the child processes refuse before any `gh` call: the ticket they name cannot be read, so nothing reaches GitHub or the tracker
/**
 * A ticket worker's `pr:open` on a machine that runs only the ticket board. Its host file keeps `clones` and `tickets` and declares no `primary`
 * project, so on 2026-10-19 every worker's `pr:open` died loading the project (`host.json has no primary field`) and no ticket pull request opened.
 * These tests pin that a ticket run on such a host loads and reaches the ticket's own checks, that any other run still refuses by name,
 * that the diff base follows the repository's default branch, and that no acceptance report is demanded where no project's CI reads one.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffBaseOf } from "../pr-open.ts";
import { isTicketOnlyRun } from "../project-config.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { DEFAULT_KEYWORDS } from "./source.ts";
import { ticketBodyReports } from "./pr-open-ticket.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ticket-only-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const hostFile = (name: string, host: object): string => {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(host));
  return path;
};
const TICKET_ONLY = hostFile("ticket-only.json", { clones: { app: "/work/app" }, tickets: { max: 1 } });
const WITH_PROJECT = hostFile("with-project.json", { primary: "p", projects: [], tickets: { max: 1 } });
const NO_TICKETS = hostFile("no-tickets.json", { clones: {} });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, env: sandboxGitEnv() });

/** A linked worktree, which is where a worker runs: `pr:open` refuses to launch from a primary checkout, or from a directory that is no checkout. */
const primary = join(scratch, "primary");
const worktree = join(scratch, "worker-worktree");
mkdirSync(primary);
writeFileSync(join(primary, "a.txt"), "x\n");
git(primary, "init", "-q", "-b", "main");
git(primary, "add", ".");
git(primary, "commit", "-q", "-m", "init");
git(primary, "worktree", "add", "-q", "-b", "agent/x-1", worktree);

/** `pr:open create` in a child process, from the worker's worktree, with the env a test names. */
function prOpen(env: Record<string, string>): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [BIN, "pr:open", "create", "--draft", "--title", "t", "--body", "b"], {
    cwd: worktree, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env },
  });
  return { status: run.status, stderr: run.stderr };
}

test("isTicketOnlyRun: a worker on a host with `tickets` and no `primary`", () => {
  assert.equal(isTicketOnlyRun(TICKET_ONLY, { AGENT_ORG_TICKET: "NBF-1" }), true);
});

test("isTicketOnlyRun: not outside a ticket run, with a `primary`, with no `tickets`, or with an unreadable host file", () => {
  assert.equal(isTicketOnlyRun(TICKET_ONLY, {}), false);
  assert.equal(isTicketOnlyRun(WITH_PROJECT, { AGENT_ORG_TICKET: "NBF-1" }), false);
  assert.equal(isTicketOnlyRun(NO_TICKETS, { AGENT_ORG_TICKET: "NBF-1" }), false);
  assert.equal(isTicketOnlyRun(join(scratch, "missing.json"), { AGENT_ORG_TICKET: "NBF-1" }), false);
});

test("pr:open in a ticket run on a ticket-only host loads, and reaches the ticket's own read", () => {
  const { stderr } = prOpen({ AGENT_ORG_HOST: TICKET_ONLY, AGENT_ORG_TICKET: "NBF-1" });
  assert.match(stderr, /pr-open: REFUSED -- the ticket could not be read/);
  assert.doesNotMatch(stderr, /primary/);
});

test("pr:open outside a ticket run on the same host still refuses for the missing `primary`, by name", () => {
  const { status, stderr } = prOpen({ AGENT_ORG_HOST: TICKET_ONLY });
  assert.notEqual(status, 0);
  assert.match(stderr, /field `primary` REFUSED/);
});

test("diffBaseOf: `--base` wins, then the branch origin/HEAD names, then main", () => {
  const develop = () => "origin/develop\n";
  const unset = () => { throw new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref"); };
  assert.equal(diffBaseOf(["--base", "release"], develop), "origin/release");
  assert.equal(diffBaseOf([], develop), "origin/develop");
  assert.equal(diffBaseOf([], unset), "origin/main");
});

test("ticketBodyReports: the acceptance report is CI's by default and left out when no project's CI reads one", () => {
  const names = (reports: ReturnType<typeof ticketBodyReports>) => reports.map((report) => report.name);
  assert.ok(names(ticketBodyReports("NBF-1", null, DEFAULT_KEYWORDS)).includes("acceptance"));
  assert.ok(!names(ticketBodyReports("NBF-1", null, DEFAULT_KEYWORDS, { acceptance: false })).includes("acceptance"));
});

test("the region read in a ticket run on a ticket-only host reads the worker's own tree, there being no project checkout", () => {
  const tree = join(scratch, "worker-tree");
  mkdirSync(join(tree, "packages"), { recursive: true });
  writeFileSync(join(tree, "packages", "a.ts"), "x\n");
  git(tree, "init", "-q", "-b", "main");
  git(tree, "add", ".");
  git(tree, "commit", "-q", "-m", "init");
  const read = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { trackedTopLevelDirs } from ${JSON.stringify(new URL("../region-paths.ts", import.meta.url).href)}; console.log(JSON.stringify(trackedTopLevelDirs()));`], {
    cwd: tree, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, AGENT_ORG_HOST: TICKET_ONLY, AGENT_ORG_TICKET: "NBF-1" },
  });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), ["packages"]);
});
