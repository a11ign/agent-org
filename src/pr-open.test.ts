// no-token: gh -- `sendToGitHub` is given a `run` that throws what `plugins/github/wrapper/gh` exits with, and one case puts a stub `gh` first on PATH; no real `gh` starts.
//
// (#4898) A RATE-LIMITED `pr create` IS HELD, NOT FAILED. `plugins/github/wrapper/gh` exits 75 for a write it queued; pr-open must then (1) not call that a failure,
// (2) attach the arm and the session label to the held entry so they are made after the create does, and (3) tell the author in words that stop a
// second copy and a question to a human. The ordinary failure beside it is the positive control: a `gh` that fails for another reason is still
// exit 1, "nothing sent", with the cause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { armAfterCreate, checkRegion, draftRefusal, EXIT_NOTHING_SENT, EXIT_QUEUED, labelAfterCreate, main, readQueuedEntry, sendToGitHub } from "./pr-open.ts";
import { REPO } from "./project-identity.ts";
import { QUEUED_EXIT } from "./gh-ledger.ts";

const HELD = { dir: "/q", id: "1790000000-42", resetAt: Date.parse("2026-10-10T23:15:07Z") / 1000 };
const refusedWith = (status: number | undefined) => () => { throw Object.assign(new Error("gh refused"), { status }); };

const send = (mode: string, rest: string[], over: Partial<Parameters<typeof sendToGitHub>[2]> & { status?: number } = {}) => {
  const said: string[] = [];
  const ran: string[][] = [];
  const attached: { entry: { dir: string; id: string; }; steps: string[][]; }[] = [];
  const code = sendToGitHub(mode, rest, {
    run: (a) => { ran.push(a); refusedWith("status" in over ? over.status : QUEUED_EXIT)(); },
    git: (a) => (a.includes("--abbrev-ref") ? "agent/x" : "abc1234"), err: (l) => { said.push(l); },
    owner: () => "ceo", labelExists: () => true, queued: () => HELD,
    attach: (entry, steps) => { attached.push({ entry, steps }); }, ...over,
  });
  return { code, said: said.join(""), ran, attached };
};

test("#4898: a create the wrapper HELD returns the queued code, says QUEUED NOT FAILED, and does not tell the author to retry or ask", () => {
  const r = send("create", ["--head", "agent/x", "--title", "t", "--body", "b"]);
  assert.equal(r.code, EXIT_QUEUED);
  assert.equal(EXIT_QUEUED, QUEUED_EXIT, "the code the wrapper exits and the code this CLI exits are one number");
  assert.notEqual(r.code, EXIT_NOTHING_SENT, "a held call is not 'nothing sent': a caller reading 1 would send it again");
  assert.match(r.said, /QUEUED, NOT FAILED/);
  assert.match(r.said, /1790000000-42 after 23:15:07Z/, "the entry and the time it is made");
  assert.match(r.said, /Do NOT rerun pr-open/);
  assert.match(r.said, /do not ask a human/);
  assert.doesNotMatch(r.said, /retry the same command|nothing was sent, so/i);
  assert.deepEqual(r.ran.map((a) => a[1]), ["create"], "only the create was attempted: the arm of a PR that does not exist yet is never run now");
});

test("#4898: the arm and the owner label are ATTACHED to the held entry, in order, and only for a create", () => {
  const r = send("create", ["--head", "agent/x", "--title", "t", "--body", "b"]);
  assert.equal(r.attached.length, 1);
  assert.deepEqual(r.attached[0].entry, HELD);
  const heads = r.attached[0].steps.map((s) => s.slice(0, 2).join(" "));
  assert.deepEqual(heads, ["pr merge", "pr edit"], "arm first, then the session label");
  assert.ok(r.attached[0].steps[1].includes("session:ceo"));
  assert.ok(r.attached[0].steps[0].includes("--auto"), "armed to merge when green");
  assert.doesNotMatch(r.said, /NOT ATTACHED/);

  const draft = send("create", ["--draft", "--head", "agent/x"]);
  assert.deepEqual(draft.attached[0].steps.map((s) => s.slice(0, 2).join(" ")), ["pr edit"], "a draft is not armed, but is still labelled");

  const missing = send("create", ["--draft", "--head", "agent/x"], { labelExists: () => false });
  assert.deepEqual(missing.attached[0].steps.map((s) => s.slice(0, 2).join(" ")), ["label create", "pr edit"], "a label the repository lacks is created first");

  const edit = send("edit", ["12", "--body", "b"]);
  assert.equal(edit.code, EXIT_QUEUED);
  assert.deepEqual(edit.attached, [], "an edit has nothing to follow it");
});

test("#4898: follow-ups that cannot travel with the entry are SAID, with the one thing left to do by hand", () => {
  const lost = send("create", ["--head", "agent/x"], { queued: () => null });
  assert.equal(lost.code, EXIT_QUEUED);
  assert.match(lost.said, /NOT ATTACHED: the entry the wrapper held could not be found/);
  assert.match(lost.said, /arm and label it by hand/);
  assert.deepEqual(lost.attached, []);

  const broken = send("create", ["--head", "agent/x"], { attach: () => { throw new Error("ENOSPC"); } });
  assert.equal(broken.code, EXIT_QUEUED, "the call is still held; only its follow-ups are lost");
  assert.match(broken.said, /NOT ATTACHED: .*ENOSPC/);
});

test("#4898: POSITIVE CONTROL -- any other failure of the create is still exit 1, nothing sent, with the cause, and attaches nothing", () => {
  for (const status of [1, 4, undefined]) {
    const r = send("create", ["--head", "agent/x"], { status });
    assert.equal(r.code, EXIT_NOTHING_SENT, `status ${status}`);
    assert.doesNotMatch(r.said, /QUEUED/);
    assert.match(r.said, /gh refused/);
    assert.deepEqual(r.attached, []);
  }
});

test("#4898: the queued entry the wrapper leaves is read back; no file, or a torn one, is 'not held' and never a guess", () => {
  const dir = tmpDir("pr-open-queued-");
  const good = join(dir, "good");
  writeFileSync(good, "/home/agent/workers/gh/refused-queue\t1790000000-42\t1790003600\n");
  assert.deepEqual(readQueuedEntry(good), { dir: "/home/agent/workers/gh/refused-queue", id: "1790000000-42", resetAt: 1790003600 });
  assert.equal(existsSync(good), false, "reading consumes it, so the next call cannot read this one's entry");
  assert.equal(readQueuedEntry(good), null);
  assert.equal(readQueuedEntry(join(dir, "absent")), null);
  const torn = join(dir, "torn");
  writeFileSync(torn, "/home/agent/workers/gh/refused-queue\t1790000000-42\tsoon\n");
  assert.equal(readQueuedEntry(torn), null);
});

test("#4898 THROUGH THE REAL `run`: a `gh` that exits 75 and leaves its entry file is reported held, with the entry read from it", () => {
  const bin = tmpDir("pr-open-bin-");
  const seen = join(bin, "seen");
  mkdirSync(join(bin, "b"));
  writeFileSync(join(bin, "b", "gh"), `#!/bin/sh\necho "$*" >> "${seen}"\nprintf '/q\\t9-9\\t1790003600\\n' > "$A11Y_GH_QUEUED_TO"\nexit 75\n`);
  chmodSync(join(bin, "b", "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${join(bin, "b")}:${saved}`;
  const said: string[] = [];
  const attached: string[][][] = [];
  try {
    const code = sendToGitHub("create", ["--draft", "--head", "agent/x"], { git: () => "x", err: (l) => { said.push(l); }, owner: () => null,
      attach: (_entry, steps) => { attached.push(steps); } });
    assert.equal(code, EXIT_QUEUED);
  } finally {
    process.env.PATH = saved;
  }
  assert.match(said.join(""), /QUEUED, NOT FAILED.*as 9-9 after/s);
  assert.equal(readFileSync(seen, "utf8").trim().split("\n").length, 1, "the create was made once and not repeated");
  assert.match(readFileSync(seen, "utf8"), /^pr create --draft --head agent\/x/);
});

// #4968: a PR opens READY and ARMED unless the author says --draft. These run the wrapper's own success path, with a `run` that records argv.
const sendOk = (mode: string, rest: string[]) => {
  const ran: string[][] = [];
  const code = sendToGitHub(mode, rest, { run: (a) => { ran.push(a); }, git: () => "abc1234", err: () => {}, owner: () => null, labelExists: () => true });
  return { code, ran };
};

test("#4968: a create without --draft sends no --draft and is armed straight after", () => {
  const r = sendOk("create", ["--head", "agent/x", "--title", "t", "--body", "b"]);
  assert.equal(r.code, 0);
  assert.ok(!r.ran[0].includes("--draft"), "the wrapper never adds --draft");
  assert.deepEqual(r.ran[1], ["pr", "merge", "--auto", "--merge", "agent/x"], "armed at creation, as a docs-and-tests PR always was");
});

test("#4968: an explicit --draft creates a draft that is NOT armed", () => {
  const r = sendOk("create", ["--draft", "--head", "agent/x", "--title", "t", "--body", "b"]);
  assert.ok(r.ran[0].includes("--draft"), "the explicit not-now is passed through");
  assert.deepEqual(r.ran.map((a) => a[1]), ["create"], "no merge step follows a draft");
  assert.deepEqual(armAfterCreate("create", ["--draft"]), []);
});

test("#4968: edit never arms, draft or not", () => {
  const r = sendOk("edit", ["--body", "b"]);
  assert.deepEqual(r.ran.map((a) => a[1]), ["edit"]);
  assert.deepEqual(armAfterCreate("edit", ["--head", "agent/x"]), []);
  assert.equal(armAfterCreate("create", ["--head", "agent/x"]).length, 1, "positive control: a plain create does arm");
});

// agent-org#923: a `Closes` of a row whose Region spans two repositories is refused while another repository's open pull request names that row,
// because that half is still open. `checkRegion` is pure over its seams, so the cases drive it directly; the last one drives `main`, which is where
// `openPulls` is wired (for `create` only), so a refusal there is the wiring working and not just the check.
const SECOND = "a11ign/second-half";
const CODE = [{ key: "agent-org", repo: REPO }, { key: "second", repo: SECOND }];
const ROW = `${REPO}#923`;
const regionRow = (paths: string[]) => `## What it is\n\nx\n\n## Region\n\n\`\`\`\n${paths.join("\n")}\n\`\`\`\n\n## Acceptance\n\nx\n`;
const SPANS = regionRow(["agent-org:src/row-file.ts", "second:src/other.ts"]);
const ONE_REPO = regionRow(["agent-org:src/row-file.ts"]);
const ACCEPTANCE_FILE_923 = ".acceptance/agent~pr-open-refuses-a-agent-org-923.md";
type Pull = { number: number; body: string; };
const openIn = (repo: string, pulls: Pull[]) => (asked: string): Pull[] | null => (asked === repo ? pulls : []);
const SECOND_NAMES_ROW: Pull[] = [{ number: 4969, body: `Closes ${ROW}\n` }];

/** A `git` that answers what the Region check and `main` ask: the diff (`changed`), the added Acceptance file, and the head reads. */
const gitFor923 = (changed: string[]) => (args: string[]) => {
  if (args[0] === "diff") return (args.includes("--diff-filter=A") ? [ACCEPTANCE_FILE_923] : changed).join("\0");
  if (args[0] === "remote") return "deadbeef";
  if (args.includes("--abbrev-ref")) return "agent/pr-open-refuses-a-agent-org-923";
  if (args.includes("--short")) return "abc1234";
  return "deadbeef";
};

const checkWith = (openPulls: (repo: string) => Pull[] | null, { body = SPANS, changed = ["src/row-file.ts"] } = {}) =>
  checkRegion("Closes #923\n", ["--repo", REPO], { git: gitFor923(changed), rowBody: () => body, rootFiles: new Set(), code: CODE, openPulls });

test("#923 done-when 1 (POSITIVE CONTROL): a Closes of a two-repository row, with an open pull request in the other repository naming the row, is REFUSED, "
  + "and the refusal names that pull request and the `Closes: none -- first half of` spelling", () => {
  const r = checkWith(openIn(SECOND, SECOND_NAMES_ROW));
  assert.ok(r.refusal !== null, "refused");
  assert.equal(r.note, null);
  assert.ok(r.refusal.includes(`${SECOND}#4969`), "the pull request that holds the other half is named");
  assert.ok(r.refusal.includes(`Closes: none -- first half of ${ROW}`), "the spelling for this pull request is named");
});

test("#923 POSITIVE CONTROL (Refs): a `Refs` line in the other half's open pull request names the row too, and refuses", () => {
  const r = checkWith(openIn(SECOND, [{ number: 4970, body: `Refs ${ROW}\n` }]));
  assert.ok(r.refusal !== null && r.refusal.includes(`${SECOND}#4970`));
});

test("#923 done-when 2 (NEGATIVE CONTROL): the same row with NO other open pull request passes", () => {
  const r = checkWith(openIn(SECOND, []));
  assert.equal(r.refusal, null, "nothing names the row, so the Closes stands");
  assert.notEqual(r.note, null, "and the pass says what it read");
});

test("#923 done-when 2 (NEGATIVE CONTROL): a single-repository row passes, even with an open pull request in the other repository naming it", () => {
  const r = checkWith(openIn(SECOND, SECOND_NAMES_ROW), { body: ONE_REPO });
  assert.equal(r.refusal, null, "one repository's Region has no other half to be open");
});

test("#923 done-when 2 (NEGATIVE CONTROL): an open pull request that names ANOTHER row does not refuse", () => {
  const r = checkWith(openIn(SECOND, [{ number: 4971, body: `Closes ${REPO}#924\n` }]));
  assert.equal(r.refusal, null);
});

test("#923 done-when 2 (NEGATIVE CONTROL): an unreadable open-pull list REFUSES, naming the repository whose list it could not read", () => {
  const r = checkWith(() => null);
  assert.ok(r.refusal !== null, "refused, not passed as an empty list");
  assert.ok(r.refusal.includes(SECOND), "the repository is named");
  assert.match(r.refusal, /could not be read/);
});

test("#923 POSITIVE CONTROL (main): `create` of that Closes is refused by pr-open before anything is sent, and the Acceptance does not run", () => {
  const body = `## Acceptance\n\nnode -e "process.exit(0)"\n\nCloses #923\nMutation: none -- these tests drive the Region check\nDraft-because: the Region check is under test, not a review\n`;
  const argv = ["create", "--draft", "--repo", REPO, "--body", body];
  const sent: string[][] = [];
  const err: string[] = [];
  let acceptance = 0;
  const code = main(argv, {
    run: (args: string[]) => { sent.push(args); },
    git: gitFor923(["src/row-file.ts"]),
    prHead: () => ({ ref: "agent/pr-open-refuses-a-agent-org-923", oid: "deadbeef" }),
    runAcceptance: () => { acceptance += 1; return 0; },
    readFile: () => body,
    rowBody: () => SPANS,
    rootFiles: new Set(),
    code: CODE,
    owner: () => "ceo",
    login: () => "a11ign-ai-workers",
    openPulls: openIn(SECOND, SECOND_NAMES_ROW),
    out: () => {},
    err: (line: string) => { err.push(line); },
  });
  assert.equal(code, EXIT_NOTHING_SENT);
  assert.deepEqual(sent, [], "nothing was sent to GitHub");
  assert.equal(acceptance, 0, "refused before the Acceptance ran");
  assert.ok(err.join("").includes(`Closes: none -- first half of ${ROW}`));
});

// a11ign#5036: `--draft` is refused unless the body says why. `main` is driven with the real body check mocked out of the way by refusing
// BEFORE it: the refusal comes ahead of the Acceptance and of anything sent, so no acceptance runner or `gh` is reachable on the refused path.
const draftMain = (argv: string[]) => {
  const sent: string[][] = [];
  const err: string[] = [];
  let acceptance = 0;
  const code = main(argv, {
    run: (args: string[]) => { sent.push(args); }, git: () => "", runAcceptance: () => { acceptance += 1; return 0; },
    readFile: () => "", owner: () => "ceo", login: () => "a11ign-ai-workers", out: () => {}, err: (line: string) => { err.push(line); },
  });
  return { code, sent, acceptance, said: err.join("") };
};

test("a11ign#5036: `--draft` with no Draft-because line is REFUSED before anything is sent or run, and the remedy is named", () => {
  const r = draftMain(["create", "--draft", "--repo", REPO, "--title", "t", "--body", "## Acceptance\n\ntrue\n\nCloses #1\n"]);
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, [], "nothing was sent to GitHub");
  assert.equal(r.acceptance, 0, "refused before the Acceptance ran");
  assert.match(r.said, /--draft` without a reason/);
  assert.match(r.said, /Draft-because: <reason>/);
});

test("a11ign#5036: a Draft-because line with a reason lets `--draft` through, and an EMPTY one does not", () => {
  const body = (line: string) => `## Acceptance\n\ntrue\n\nCloses #1\n${line}\n`;
  assert.equal(draftRefusal("create", ["--draft"], body("Draft-because: work in progress, do not review")), null);
  assert.equal(draftRefusal("create", ["--draft"], body("Draft-because:   ")) === null, false, "a label with no reason is not a reason");
  assert.equal(draftRefusal("create", ["--draft"], body("not a Draft-because: line in prose")) === null, false, "the line starts the line");
});

test("a11ign#5036 (NEGATIVE CONTROL): a create without --draft, and an edit, are never refused for a missing reason", () => {
  assert.equal(draftRefusal("create", ["--head", "agent/x"], "no reason, and no draft"), null);
  assert.equal(draftRefusal("edit", ["--draft"], "an edit has no --draft to explain"), null);
});

// agent-org#952: `pr:open create --repo R` with no `--head` armed with `gh pr merge --auto --merge --repo R` and NO selector, which gh refuses
// ("argument required when using the --repo flag"), so the PR was left unarmed and its session label never ran. The create was made from the
// tree's own branch, so the arm and the label name that branch when `--repo` is given. Without `--repo` the argv is what it always was.
const REPO_952 = "a11ign/agent-org";
test("#952: a create with --repo and no --head arms the branch it was made from", () => {
  assert.deepEqual(armAfterCreate("create", ["--repo", REPO_952, "--title", "t"], "agent/x"),
    [["pr", "merge", "--auto", "--merge", "agent/x", "--repo", REPO_952]]);
});

test("#952: --head still names the pull request, and wins over the tree's branch", () => {
  assert.deepEqual(armAfterCreate("create", ["--head", "agent/h", "--repo", REPO_952], "agent/x"),
    [["pr", "merge", "--auto", "--merge", "agent/h", "--repo", REPO_952]]);
});

test("#952 (NEGATIVE CONTROL): with no --repo and no --head the arm is unchanged, and --draft still arms nothing with --repo", () => {
  assert.deepEqual(armAfterCreate("create", ["--title", "t"]), [["pr", "merge", "--auto", "--merge"]]);
  assert.deepEqual(armAfterCreate("create", ["--draft", "--repo", REPO_952], "agent/x"), []);
});

test("#952: --repo with no branch to name arms nothing, rather than the argv gh refuses", () => {
  assert.deepEqual(armAfterCreate("create", ["--repo", REPO_952], null), []);
});

test("#952: the session label names the same branch with --repo", () => {
  assert.deepEqual(labelAfterCreate("create", ["--repo", REPO_952], "ceo", "agent/x"),
    [["pr", "edit", "agent/x", "--repo", REPO_952, "--add-label", "session:ceo"]]);
});

test("#952 THROUGH sendToGitHub: the arm and the label of a `--repo` create reach `run` naming the branch", () => {
  const ran: string[][] = [];
  const code = sendToGitHub("create", ["--repo", REPO_952, "--title", "t", "--body", "b"], {
    run: (a) => { ran.push(a); }, git: (a) => (a.includes("--abbrev-ref") ? "agent/x" : "abc1234"), err: () => {},
    owner: () => "ceo", labelExists: () => true,
  });
  assert.equal(code, 0);
  assert.deepEqual(ran.slice(1), [
    ["pr", "merge", "--auto", "--merge", "agent/x", "--repo", REPO_952],
    ["pr", "edit", "agent/x", "--repo", REPO_952, "--add-label", "session:ceo"],
  ]);
});

test("#952 (READ ONCE): the tree's branch is read once per create, and the arm and the label name that one read", () => {
  // Each read answers with a new branch, so a second read would make the arm and the label disagree.
  const ran: string[][] = [];
  let reads = 0;
  const git = (a: string[]) => (a.includes("--abbrev-ref") ? `agent/${++reads}` : "abc1234");
  const code = sendToGitHub("create", ["--repo", REPO_952, "--title", "t", "--body", "b"], {
    run: (a) => { ran.push(a); }, git, err: () => {}, owner: () => "ceo", labelExists: () => true,
  });
  assert.equal(code, 0);
  assert.equal(reads, 1);
  assert.deepEqual(ran.slice(1), [
    ["pr", "merge", "--auto", "--merge", "agent/1", "--repo", REPO_952],
    ["pr", "edit", "agent/1", "--repo", REPO_952, "--add-label", "session:ceo"],
  ]);
});

test("#952 (NO READ OUTSIDE CREATE): an edit reads no branch at all, so the happy path pays no git subprocess it does not use", () => {
  let reads = 0;
  const git = (a: string[]) => { if (a.includes("--abbrev-ref")) reads++; return "abc1234"; };
  const ran: string[][] = [];
  const code = sendToGitHub("edit", ["42", "--repo", REPO_952, "--title", "t"], {
    run: (a) => { ran.push(a); }, git, err: () => {}, owner: () => "ceo", labelExists: () => true,
  });
  assert.equal(code, 0);
  assert.equal(reads, 0);
  assert.deepEqual(ran, [["pr", "edit", "42", "--repo", REPO_952, "--title", "t"]]);
});
