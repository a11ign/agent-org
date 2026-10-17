// no-token: gh -- `main` is handed `run`, `git`, `runAcceptance`, `readFile` and `rowBody` as seams, and a ticket's source is a fake; nothing reaches `gh` or the tracker
/**
 * A11-74: `pr:open` in a ticket-mode run checks its pull request against the ticket, read through the tracker, where a row's checks read the row.
 * A ticket worker's pull request was refused by `pr:open` on 2026-10-17 (A11-31) because there is no row, claim or session for it. These tests pin the
 * checks that replace the row's: the Region, the `Refs`/`Closes` declaration, the owner, the draft policy and the changeset, and that a create in a
 * ticket run is sent once, with nothing armed and nothing labelled. The last test is the GitHub-row path, which must not change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceFileForBranch } from "../acceptance-file.ts";
import { main, runFromCli, EXIT_NOTHING_SENT, sendToGitHub } from "../pr-open.ts";
import { QUEUED_EXIT as EXIT_QUEUED } from "../gh-ledger.ts";
import { REPO } from "../project-identity.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { readTicketContext, ticketClosesReport, treeKeyUnder, type TicketContext } from "./pr-open-ticket.ts";
import { READY_FILE } from "./worker-files.ts";

const KEY = "A11-74";
const BRANCH = "admin/a11-74-propen-works-in-ticket-mode-it-reads-the-ticket-through-the";
const FOLDER = "/work/.tickets/A11-74";
const TREE = `${FOLDER}/agent-org`;
const REGION = "## Region\n\n```\nsrc/x.ts\n```\n";
const CHANGED = "src/x.ts";
const ACCEPTANCE_FILE = acceptanceFileForBranch(BRANCH);
const ACCEPTANCE = "## Acceptance\n\nnode -e \"process.exit(0)\"\n";
/** A body a ticket worker would send: it names its ticket with `Refs`, and carries the Mutation line the checks expect. */
const BODY = `Refs ${KEY}\n\nMutation: none -- these tests drive the ticket checks\n`;

/** The run a test starts from: a ready machine (`tickets.drafts: false`), so a create needs no `--draft`, and a test of drafts says otherwise. */
const ticket = (over: Partial<TicketContext> = {}): TicketContext => ({
  key: KEY, branch: BRANCH, folder: FOLDER, treeKey: "agent-org", regionText: REGION, readyRun: true, hasChangesets: false, ...over,
});

/** `git` in a ticket's tree: the diff's files and the added ones, the tree's root, and its checked-out branch. */
const gitFor = ({ branch = BRANCH, top = TREE, files = [CHANGED], added = [ACCEPTANCE_FILE] }: { branch?: string; top?: string; files?: string[]; added?: string[]; } = {}) =>
  (args: string[]): string => {
    if (args[0] === "diff") return (args.includes("--diff-filter=A") ? added : files).join("\0");
    if (args[0] === "remote") return `https://github.com/${REPO}.git`;
    if (args.includes("--abbrev-ref")) return branch;
    if (args.includes("--show-toplevel")) return top;
    return "abc1234";
  };

/** `main` in a ticket run, with the seams a test drives, and what it sent and said. */
function open(args: string[], over: Partial<Parameters<typeof main>[1]> = {}) {
  const sent: string[][] = [];
  const said: string[] = [];
  const refused: string[] = [];
  const code = main(["create", ...args], {
    ticket: ticket(), git: gitFor(), run: (argv) => { sent.push(argv); }, runAcceptance: () => 0, readFile: () => ACCEPTANCE,
    rootFiles: new Set<string>(), lanes: { lanes: [] }, login: () => "a11ign-ai-workers",
    out: (line) => { said.push(line); }, err: (line) => { refused.push(line); }, ...over,
  });
  return { code, sent, said: said.join(""), refused: refused.join("") };
}

test("A11-74: a ticket run's pull request is checked and sent once, its checks printed, and nothing is armed or labelled", () => {
  const r = open(["--body", BODY, "--title", "fix: the thing"]);
  assert.equal(r.code, 0, r.refused);
  assert.equal(r.sent.length, 1, "one create, and nothing after it");
  assert.deepEqual(r.sent[0], ["pr", "create", "--body", BODY, "--title", "fix: the thing"], "the create is sent as given: pr:open adds no flag");
  assert.ok(r.sent.every((argv) => argv[1] === "create"), "no pr merge (arming) and no pr edit (a session label)");
  assert.match(r.said, /CLOSES: A11-74 -- `Refs` links it, and does not complete it/);
  assert.match(r.said, /REGION: 1 changed path\(s\) against A11-74's Region .* 1 inside/);
  assert.match(r.said, /CHANGESET: not checked -- this repository has no \.changeset\/config\.json/);
});

test("A11-74: a changed path outside the ticket's Region is refused with the path named, and nothing is sent", () => {
  const outside = open(["--body", BODY, "--title", "t"], { git: gitFor({ files: [CHANGED, "src/other.ts"] }) });
  assert.equal(outside.code, EXIT_NOTHING_SENT);
  assert.match(outside.refused, /REFUSED -- 1 path\(s\) changed outside A11-74's Region/);
  assert.match(outside.refused, /^  src\/other\.ts$/m);
  assert.equal(outside.sent.length, 0, "nothing sent");

  const declared = BODY + "\nOutside-Region: src/other.ts — generated by the fixture the test reads\n";
  const cleared = open(["--body", declared, "--title", "t"], { git: gitFor({ files: [CHANGED, "src/other.ts"] }) });
  assert.equal(cleared.code, 0, cleared.refused);
  assert.match(cleared.said, /1 cleared by an Outside-Region line/);

  const hyphen = BODY + "\nOutside-Region: src/other.ts - generated by the fixture\n";
  const hyphenated = open(["--body", hyphen, "--title", "t"], { git: gitFor({ files: [CHANGED, "src/other.ts"] }) });
  assert.equal(hyphenated.code, EXIT_NOTHING_SENT, "a hyphen does not clear the path");
  assert.match(hyphenated.refused, /IGNORED, not the declared shape/);
  assert.equal(hyphenated.sent.length, 0);
});

test("A11-74: a Region entry keyed to another repository covers nothing in this tree, and one keyed to this tree covers its path", () => {
  const otherRepo = ticket({ regionText: "## Region\n\n```\ncontrol:src/x.ts\n```\n" });
  const refused = open(["--body", BODY, "--title", "t"], { ticket: otherRepo });
  assert.equal(refused.code, EXIT_NOTHING_SENT, "control:src/x.ts is not this tree's src/x.ts");
  assert.match(refused.refused, /changed outside A11-74's Region/);

  const thisRepo = ticket({ regionText: "## Region\n\n```\nagent-org:src/x.ts\n```\n" });
  assert.equal(open(["--body", BODY, "--title", "t"], { ticket: thisRepo }).code, 0);
});

test("A11-74: a ticket with no Region section is not checked, and says so", () => {
  const r = open(["--body", BODY, "--title", "t"], { ticket: ticket({ regionText: "Fix the thing." }) });
  assert.equal(r.code, 0);
  assert.match(r.said, /REGION: not checked -- the ticket has no Region section/);
});

test("A11-74: a body that declares no ticket, closes another, or closes none is refused, and so is a branch that is not the run's", () => {
  const cases: [string, string][] = [
    ["Closes: none -- no ticket", "`Closes: none`"],
    ["Closes #4889", "names a ticket other than A11-74"],
    ["Closes A11-31", "names a ticket other than A11-74"],
    ["Fixes the thing", "names no ticket"],
  ];
  for (const [line, why] of cases) {
    const r = open(["--body", `${line}\n\nMutation: none -- x\n`, "--title", "t"]);
    assert.equal(r.code, EXIT_NOTHING_SENT, line);
    // the body's own reports print on `out` and the refusal on `err`; the reason is in either
    assert.match(r.said + r.refused, new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), line);
    assert.equal(r.sent.length, 0, `${line}: nothing sent`);
  }

  const elsewhere = open(["--body", BODY, "--title", "t"], { git: gitFor({ branch: "main" }) });
  assert.equal(elsewhere.code, EXIT_NOTHING_SENT);
  assert.match(elsewhere.refused, new RegExp(`${KEY}'s branch is \`${BRANCH}\`, but this working tree is on \`main\``));
  assert.equal(elsewhere.sent.length, 0);

  const notATree = open(["--body", BODY, "--title", "t"], { ticket: ticket({ treeKey: null }) });
  assert.equal(notATree.code, EXIT_NOTHING_SENT);
  assert.match(notATree.refused, /is not a repository's worktree under \/work\/\.tickets\/A11-74/);
});

test("A11-74: the closes report names the verb it found, and refuses Closes: none, a Closes of another ticket and a Closes with no key", () => {
  assert.deepEqual(ticketClosesReport(`Refs ${KEY}\n`, KEY), { ok: true, lines: [`CLOSES: ${KEY} -- \`Refs\` links it, and does not complete it`] });
  assert.deepEqual(ticketClosesReport(`Closes ${KEY}\n`, KEY), { ok: true, lines: [`CLOSES: ${KEY} -- \`Closes\` completes it when the pull request merges`] });
  assert.equal(ticketClosesReport(`Closes: none -- no ticket\n`, KEY).ok, false);
  assert.equal(ticketClosesReport(`Closes A11-31\n`, KEY).ok, false);
  assert.equal(ticketClosesReport(`Refs A11-31\n`, KEY).ok, false, "a body with only another ticket names none of its own");
  assert.equal(ticketClosesReport(`Closes ${KEY} -- done with the first half\n`, KEY).ok, true, "a reason after a dash is not a key");
  assert.equal(ticketClosesReport(`Refs A11-31\nRefs ${KEY}\n`, KEY).ok, true, "a Refs of another ticket is no refusal");
});

test("A11-74: a worker's markdown around its ticket's key, or a note after it, still names that key; a Closes of a pull request number or another key does not", () => {
  for (const line of [`Closes ${KEY} (done-when met)`, `Closes **${KEY}**`, `Closes \`${KEY}\``, `Refs \`${KEY}\``, `Refs **${KEY}**`, `**Refs:** ${KEY}`, `Closes ${KEY} and the parent`]) {
    assert.equal(ticketClosesReport(`${line}\n`, KEY).ok, true, line);
  }
  assert.equal(ticketClosesReport("Closes the loop\n", KEY).ok, false, "a Closes line that names no ticket does not close this one");
  assert.equal(ticketClosesReport("Closes #4889\n", KEY).ok, false, "a pull request number is another row, not this ticket");
  assert.equal(ticketClosesReport(`Closes ${KEY} and A11-31\n`, KEY).ok, false, "a Closes that names a second ticket is refused");
});

test("A11-74: a no-release line that still carries the brief's <reason> placeholder is no reason", () => {
  const placeholder = open(["--body", `${BODY}no-release: <reason>\n`, "--title", "t"], { ticket: ticket({ hasChangesets: true }) });
  assert.equal(placeholder.code, EXIT_NOTHING_SENT);
  assert.match(placeholder.refused, /releases its packages with changesets/);
});

test("A11-74: tickets.drafts false opens a create ready and refuses --draft; drafts true requires --draft and refuses its absence; neither adds the flag", () => {
  const ready = ticket({ readyRun: true });
  const bare = open(["--body", BODY, "--title", "t"], { ticket: ready });
  assert.equal(bare.code, 0, bare.refused);
  assert.deepEqual(bare.sent[0], ["pr", "create", "--body", BODY, "--title", "t"], "ready: no --draft is added");

  const draftOnReady = open(["--draft", "--body", BODY, "--title", "t"], { ticket: ready });
  assert.equal(draftOnReady.code, EXIT_NOTHING_SENT);
  assert.match(draftOnReady.refused, /`--draft` on a run whose machine opens pull requests ready/);
  assert.equal(draftOnReady.sent.length, 0);

  const draftsOn = ticket({ readyRun: false });
  const missing = open(["--body", BODY, "--title", "t"], { ticket: draftsOn });
  assert.equal(missing.code, EXIT_NOTHING_SENT);
  assert.match(missing.refused, /open the pull request as a draft: this machine's runs open drafts/);
  assert.equal(missing.sent.length, 0);

  const draft = open(["--draft", "--body", BODY, "--title", "t"], { ticket: draftsOn });
  assert.equal(draft.code, 0, draft.refused);
  assert.deepEqual(draft.sent[0].filter((arg) => arg === "--draft"), ["--draft"], "the flag is sent once, as given");
});

test("A11-74: a repository with changesets needs a changeset in the diff or a no-release line; a repository without the config is not checked", () => {
  const releasing = ticket({ hasChangesets: true });
  const none = open(["--body", BODY, "--title", "t"], { ticket: releasing });
  assert.equal(none.code, EXIT_NOTHING_SENT);
  assert.match(none.refused, /releases its packages with changesets, and this diff adds none/);
  assert.equal(none.sent.length, 0);

  const readmeOnly = open(["--body", BODY, "--title", "t"], { ticket: releasing, git: gitFor({ added: [ACCEPTANCE_FILE, ".changeset/README.md"] }) });
  assert.equal(readmeOnly.code, EXIT_NOTHING_SENT, "the README is not a changeset");

  const changeset = open(["--body", BODY, "--title", "t"], { ticket: releasing, git: gitFor({ added: [ACCEPTANCE_FILE, ".changeset/quiet-cats.md"] }) });
  assert.equal(changeset.code, 0, changeset.refused);
  assert.match(changeset.said, /CHANGESET: \.changeset\/quiet-cats\.md added/);

  const released = open(["--body", `${BODY}no-release: a test-only change ships nothing\n`, "--title", "t"], { ticket: releasing });
  assert.equal(released.code, 0, released.refused);
  assert.match(released.said, /CHANGESET: no-release -- a test-only change ships nothing/);

  const unconfigured = open(["--body", BODY, "--title", "t"]);
  assert.match(unconfigured.said, /CHANGESET: not checked -- this repository has no \.changeset\/config\.json/);
});

test("A11-74: a ticket that cannot be read refuses the create, and its Region is the description with the plan files attached to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-open-ticket-test-"));
  try {
    const host = join(dir, "host.json");
    writeFileSync(host, JSON.stringify({ clones: { "agent-org": TREE }, stateDir: join(dir, "state"), tickets: { worktreeRoot: "/work/.tickets", linearKey: { path: "/keys/linear" },
      plan: "-plan-[^/]*\\.md$" } }));
    const settings = () => parseTicketSettings(JSON.parse(readFileSync(host, "utf8")));
    const description: Ticket = { key: KEY, title: "t", description: "Fix the thing.", url: "https://linear.app/x", branch: BRANCH, status: "Todo", statusOrder: 0,
      team: "A11", project: null, priority: 3, parent: null };
    const planned = (files: Record<string, string>, extra: Partial<TicketSource> = {}): TicketSource => ({
      assigned: async () => [],
      read: async () => description,
      download: async (_ticket, to) => Object.entries(files).map(([name, text]) => { const path = join(to, name); writeFileSync(path, text); return path; }),
      ...extra,
    });
    const env = { AGENT_ORG_TICKET: KEY, AGENT_ORG_TICKET_BRANCH: BRANCH };

    const read = await readTicketContext(env, { settings, git: gitFor(), exists: () => false,
      source: () => planned({ [`attachment-1-${KEY}-0001-plan-x.md`]: `${REGION.replace("src/x.ts", "src/plan.ts")}`, "attachment-2-notes.md": "## Region\n\n```\nsrc/notes.ts\n```\n" }) });
    assert.match(read.regionText, /Fix the thing\./);
    assert.match(read.regionText, /src\/plan\.ts/, "a plan file's Region is read");
    assert.doesNotMatch(read.regionText, /src\/notes\.ts/, "a file that is not a plan is ignored");
    assert.equal(read.treeKey, "agent-org");
    assert.equal(read.readyRun, false);

    await assert.rejects(readTicketContext(env, { settings, git: gitFor(), source: () => planned({}, { read: async () => null }) }),
      /the tracker has no ticket A11-74/, "a ticket the tracker does not have refuses");
    await assert.rejects(readTicketContext(env, { settings, git: gitFor(), source: () => planned({}, { read: async () => { throw new Error("Linear answered 500"); } }) }),
      /Linear answered 500/, "a tracker that cannot be asked refuses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A11-74: the run's folder and drafts setting come from the host file named by AGENT_ORG_TICKET_HOST, and the ready mark beside its outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-open-ticket-host-"));
  try {
    const host = join(dir, "host.json");
    writeFileSync(host, JSON.stringify({ clones: { "agent-org": TREE }, stateDir: join(dir, "state"), tickets: { worktreeRoot: "/wt", linearKey: { path: "/keys/linear" } } }));
    const tracker: TicketSource = { assigned: async () => [], read: async () => null, download: async () => [] };
    const env = { AGENT_ORG_TICKET: KEY, AGENT_ORG_TICKET_BRANCH: BRANCH, AGENT_ORG_TICKET_HOST: host };
    const onReadyMark = (path: string) => path === join(dir, "state", "tickets", KEY, READY_FILE);
    const placed = await readTicketContext(env, { git: gitFor(), source: () => ({ ...tracker, read: async () => ({ key: KEY, title: "t", description: "", url: "", branch: BRANCH, status: "", statusOrder: 0, team: "A11", project: null, priority: 3, parent: null }), download: async () => [] }), exists: onReadyMark });
    assert.equal(placed.folder, `/wt/${KEY}`, "the worktrees are made under the host file's worktreeRoot");
    assert.equal(placed.readyRun, true, "the ready mark beside the run's outcome file is the drafts setting");
    assert.equal(placed.hasChangesets, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A11-74: a create that is held without an arm says nothing about an arm, because none was held with it", () => {
  const said: string[] = [];
  const held = { dir: "/q", id: "1790000000-42", resetAt: Date.parse("2026-10-10T23:15:07Z") / 1000 };
  const code = sendToGitHub("create", ["--body", BODY, "--title", "t"], {
    run: () => { throw Object.assign(new Error("gh queued"), { status: EXIT_QUEUED }); }, git: () => "abc1234", err: (line) => { said.push(line); },
    owner: () => null, arm: false, queued: () => held, attach: () => {},
  });
  assert.equal(code, EXIT_QUEUED);
  assert.doesNotMatch(said.join(""), /arm and the session label/, "no arm and no label travel with the held create");
});

test("A11-74: a ticket run whose host file cannot be read is refused by the CLI before anything is sent", async () => {
  const code = await runFromCli({ AGENT_ORG_TICKET: KEY, AGENT_ORG_TICKET_BRANCH: BRANCH, AGENT_ORG_TICKET_HOST: "/nonexistent/pr-open-ticket/host.json" });
  assert.equal(code, EXIT_NOTHING_SENT);
});

test("A11-74: a tree is a ticket's repository when it is directly under the ticket's folder, and nothing else", () => {
  assert.equal(treeKeyUnder(FOLDER, TREE), "agent-org");
  assert.equal(treeKeyUnder(FOLDER, FOLDER), null, "the folder itself is no repository");
  assert.equal(treeKeyUnder(FOLDER, `${TREE}/src`), null, "a subfolder of a checkout is not a tree of its own");
  assert.equal(treeKeyUnder(FOLDER, "/elsewhere/agent-org"), null);
});

test("A11-74 control: a GitHub-row create with Closes #N still reads its row's Region, and arms and labels the pull request as before", () => {
  const row = "## Region\n\n```\nsrc/x.ts\n```\n\n## Acceptance\n\nx\n";
  const body = `Closes #4889\n\nMutation: none -- these tests drive the row path\n`;
  const sent: string[][] = [];
  const code = main(["create", "--head", "agent/x", "--body", body, "--title", "t"], {
    git: (args: string[]) => (args[0] === "diff" ? (args.includes("--diff-filter=A") ? [ACCEPTANCE_FILE] : [CHANGED]).join("\0")
      : args[0] === "remote" ? `https://github.com/${REPO}.git` : args.includes("--abbrev-ref") ? "agent/x" : args.includes("--short") ? "abc1234" : "abc1234"),
    run: (argv) => { sent.push(argv); }, runAcceptance: () => 0, readFile: () => ACCEPTANCE,
    rowBody: () => row, rootFiles: new Set<string>(), owner: () => "ceo", labelExists: () => true, lanes: { lanes: [] }, login: () => "a11ign-ai-workers",
    branchHead: () => "abc1234", out: () => {}, err: () => {},
  });
  assert.equal(code, 0);
  assert.ok(sent.some((argv) => argv.slice(0, 3).join(" ") === "pr merge --auto" && argv.includes("agent/x")), "the ready row create is armed to merge");
  assert.ok(sent.some((argv) => argv.slice(0, 2).join(" ") === "pr edit" && argv.includes("session:ceo")), "and labelled with its session");
});
