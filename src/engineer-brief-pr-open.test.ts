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
