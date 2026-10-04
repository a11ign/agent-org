/**
 * THE HOST PROJECT'S ALWAYS-LOADED RULES, READ AS ONE TEXT (#3470).
 *
 * The tests here that tie a mechanism to a rule ("the flag the refusal quotes is in the rules", "the routing table
 * implements the model policy") read the rules of the project agent-org SERVES, because agent-org carries no
 * `.claude/rules/` of its own. They used to import this module from the a11y-witness monorepo, where
 * `rules-files.ts` named the six files; that list is the project's to keep (`content-preservation.test.ts` there
 * holds it to the directory in both directions), so it is NOT copied here, where it would be a second list that drifts.
 *
 * So this reads the directory, which is the right instrument on THIS side of the boundary: the question here is
 * "does any loaded rule say X", and a fact moved between files must not break it. It throws on an absent or empty
 * directory, because a rules text of "" would make every `assert.match(rules, ...)` fail with a message about the
 * wording when the cause is the path -- and every `assert.ok(!rules.includes(...))` pass for the same absent reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.mjs";

export const RULES_DIR = join(HOME_CHECKOUT, ".claude/rules");

/** Every `.md` under the host project's rules directory, sorted so the text is the same on every machine. */
export function readLoadedRules(dir: string = RULES_DIR): string {
  const files = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  if (files.length === 0) throw new Error(`no rules files under ${dir}: an absent rule set is not an empty one`);
  return files.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}
