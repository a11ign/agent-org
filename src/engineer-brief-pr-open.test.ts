// no-token: none -- reads one markdown file; nothing here reaches `gh`, `herdr` or `git`
/**
 * #2931: THE ENGINEER BRIEF MUST SAY TO OPEN A PR THROUGH `pr:open`, AND FORBID RAW `gh pr create`.
 *
 * Measured 2026-10-01 on #2928: #2925, #2921 and #2919 carry no session label because their workers ran
 * `gh pr create --base main --head agent/...`, so `pr:open`'s `labelAfterCreate` never ran; #2924, opened
 * through `pr:open`, was labelled 4 seconds after creation. The brief never named the command.
 *
 * THE FIXTURE BRIEF IS THE POSITIVE CONTROL: `briefOpensPrThroughPrOpen` must return true for a brief that
 * does say it, or the assertion on the real brief would pass or fail for a reason that is not the sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "./project-config.mjs";
import { labelAfterCreate, ownerOfPr, rowOwnerLabel, sendToGitHub } from "./pr-open.mjs";

const BRIEF = join(HOME_CHECKOUT, ".agent-org/roles/engineer.md");

// A forbidding line must sit on the same line as `pr:open`, so a stray mention of `gh pr create` elsewhere
// (a quoted incident, say) cannot satisfy the forbid half on its own.
export function briefOpensPrThroughPrOpen(brief: string): { names: boolean; forbidsRaw: boolean } {
  const lines = brief.split("\n");
  const names = lines.some((line) => /pr:open/.test(line));
  const forbidsRaw = lines.some((line) => /pr:open/.test(line) && /never[^.\n]*`gh pr create`/i.test(line));
  return { names, forbidsRaw };
}

const FIXTURE_THAT_SAYS_IT = "- Open a PR with `pnpm run pr:open`, never raw `gh pr create`: it labels the session.\n";

test("#2931 POSITIVE CONTROL: a brief that names pr:open and forbids raw gh pr create is recognised", () => {
  assert.deepEqual(briefOpensPrThroughPrOpen(FIXTURE_THAT_SAYS_IT), { names: true, forbidsRaw: true });
});

test("#2931 a brief that names pr:open but allows raw gh pr create is not recognised as forbidding it", () => {
  const verdict = briefOpensPrThroughPrOpen("- Use `pnpm run pr:open`.\n- `gh pr create` also works.\n");
  assert.deepEqual(verdict, { names: true, forbidsRaw: false });
});

test("#2931 a brief that says neither is recognised as neither", () => {
  assert.deepEqual(briefOpensPrThroughPrOpen("- Open a pull request.\n"), { names: false, forbidsRaw: false });
});

test("#2931 the engineer brief names pr:open and forbids raw gh pr create", () => {
  const verdict = briefOpensPrThroughPrOpen(readFileSync(BRIEF, "utf8"));
  assert.equal(verdict.names, true, "engineer.md never says to open a PR through `pnpm run pr:open`");
  assert.equal(verdict.forbidsRaw, true, "engineer.md never forbids raw `gh pr create`");
});

// #3639: AN UNSTAMPED TREE (agent-org's: 5 of 207 stamped, measured 2026-10-05) LABELS FROM THE ROW THE PR NAMES.
// The positive control is the STAMPED case: it must still label from the stamp and must never read a row, or the
// fallback tests below could pass with the fallback standing in for the stamp.
const BODY_CLOSING = (...rows: string[]) => `Acceptance: true\n\nCloses: ${rows.join(", ")}\n`;
const LABELS: Record<string, string[]> = {
  "a11ign/a11ign#1": ["lane:any", "session:ceo"],
  "a11ign/a11ign#2": ["lane:any", "session:product-manager"],
  "a11ign/a11ign#3": ["lane:any"],
  "a11ign/a11ign#4": ["session:ceo"],
};
const rowLabels = (number: number, repo: string) => LABELS[`${repo}#${number}`] ?? [];

test("#3639 POSITIVE CONTROL: a stamped tree labels from its stamp and never reads a row", () => {
  const reads: number[] = [];
  const owner = ownerOfPr({ owner: () => "product-manager", rowLabels: (n) => { reads.push(n); return []; } },
    { mode: "create", body: BODY_CLOSING("#1"), rest: [], err: () => {} });
  assert.equal(owner(), "product-manager");
  assert.deepEqual(reads, []);
  assert.deepEqual(labelAfterCreate("create", [], owner()), [["pr", "edit", "--add-label", "session:product-manager"]]);
});

test("#3639 an unstamped tree + a row naming one owner -> that owner's label", () => {
  assert.equal(rowOwnerLabel(BODY_CLOSING("#1"), [], rowLabels), "ceo");
  const owner = ownerOfPr({ owner: () => null, rowLabels }, { mode: "create", body: BODY_CLOSING("#1"), rest: [], err: () => {} });
  assert.deepEqual(labelAfterCreate("create", [], owner()), [["pr", "edit", "--add-label", "session:ceo"]]);
});

test("#3639 the same owner on two rows is still one owner; a row named only in the title counts", () => {
  assert.equal(rowOwnerLabel(BODY_CLOSING("a11ign/a11ign#1", "#4"), [], rowLabels), "ceo");
  assert.equal(rowOwnerLabel("Closes: none — a reason\n", ["--title", "x (a11ign/a11ign#2)"], rowLabels), "product-manager");
});

test("#3639 an unstamped tree + no row -> no label", () => {
  assert.equal(rowOwnerLabel("Closes: none — a reason\n", ["--title", "no row"], rowLabels), null);
  assert.equal(rowOwnerLabel("no declaration at all", [], rowLabels), null);
});

test("#3639 an unstamped tree + a row with no session label -> no label", () => {
  assert.equal(rowOwnerLabel(BODY_CLOSING("#3"), [], rowLabels), null);
});

test("#3639 an unstamped tree + two rows, two owners -> no label (nothing is invented)", () => {
  assert.equal(rowOwnerLabel(BODY_CLOSING("#1", "#2"), [], rowLabels), null);
});

test("#3639 an edit never reads a row, and a row that cannot be read is PRINTED and labels nothing", () => {
  const seen: string[] = [];
  const err = (line: string) => { seen.push(line); };
  const never = () => { throw new Error("must not be read"); };
  assert.equal(ownerOfPr({ owner: () => null, rowLabels: never }, { mode: "edit", body: BODY_CLOSING("#1"), rest: [], err })(), null);
  assert.deepEqual(seen, []);
  const failing = () => { throw new Error("HTTP 502"); };
  assert.equal(ownerOfPr({ owner: () => null, rowLabels: failing }, { mode: "create", body: BODY_CLOSING("#1"), rest: [], err })(), null);
  assert.match(seen.join(""), /could not be read -- HTTP 502/);
});

test("#3639 a label the repository lacks is CREATED before it is added; one it has is not", () => {
  const send = (exists: (name: string) => boolean) => {
    const ran: string[][] = [];
    sendToGitHub("create", ["--draft", "--head", "agent/x"], { run: (a) => { ran.push(a); }, git: () => "", err: () => {},
      owner: () => "ceo", labelExists: exists });
    return ran.map((a) => a.slice(0, 2).join(" "));
  };
  assert.deepEqual(send(() => false), ["pr create", "label create", "pr edit"]);
  assert.deepEqual(send(() => true), ["pr create", "pr edit"]);
});

test("#3639 a failure to ask or to create is reported, never swallowed, and the create is not retried", () => {
  const seen: string[] = [];
  const ran: string[][] = [];
  const code = sendToGitHub("create", ["--draft"], { run: (a) => { ran.push(a); }, git: () => "", err: (l) => { seen.push(l); },
    owner: () => "ceo", labelExists: () => { throw new Error("HTTP 401"); } });
  assert.equal(code, 0);
  assert.match(seen.join(""), /labelling it failed -- HTTP 401[\s\S]*--add-label session:ceo/);
  assert.deepEqual(ran.map((a) => a[1]), ["create"]);
});
