/**
 * #2092: THE ALWAYS-LOADED RULES, AS A NAMED SET.
 *
 * `.claude/rules/` was ONE file, and B4 admits one open pull request per file -- so every row that
 * amended any org practice waited on every other one (#2025: refused three times in 15 hours, by three
 * pull requests about the API budget, the review requirement and `rm`). It is now one file per TOPIC.
 *
 * **THE LIST IS NAMED, NEVER GLOBBED.** A directory glob passes when a file is silently dropped, and
 * accepts one nobody chose -- the defect `content-preservation.test.ts` exists to refuse for `CLAUDE.md`
 * (#1240 named its four nested destinations for the same reason). Adding a rules file is therefore a
 * deliberate edit HERE, and `content-preservation.test.ts` fails when the directory and this list differ
 * in either direction.
 *
 * Every test that reads "the rules" reads them through this module, so a fact stated once in the loaded
 * set is found in whichever file carries it, and nothing re-derives the list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_DIR = ".claude/rules";

/** Every rules file a session loads, in the order they read best: the entry point, then by topic. */
export const RULES_FILES = [
  `${RULES_DIR}/agent-practices.md`,
  `${RULES_DIR}/org-routing-and-timers.md`,
  `${RULES_DIR}/waiting-conditions.md`,
  `${RULES_DIR}/gh-api-budget.md`,
  `${RULES_DIR}/main-review-requirement.md`,
  `${RULES_DIR}/guards-and-assertions.md`,
] as const;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** One rules file, read. Throws on a missing file: an absent destination is never an empty one. */
export function readRulesFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** The whole loaded rule text, one file after another, as a session would see it. */
export function readLoadedRules(): string {
  return RULES_FILES.map(readRulesFile).join("\n");
}
