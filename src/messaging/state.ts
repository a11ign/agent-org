// The four small reads `watch.ts`, `listen.ts` and `reply-cli.ts` share (a11ign/a11ign#3080): where the delivery log lives, whether a GitHub account is
// declared, which repository holds the rows, and who the chairman is. A LEAF: it imports nothing that resolves the checkout or reads the project's
// declaration at import (`host-config.ts`, `project-config.ts`), so a command that imports it loads outside a configured host. `reply-cli.ts` once
// carried its own copies for that reason, pinned against the originals by source-text tests; `reply-cli.test.mjs` now pins THIS file's imports instead.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_FILE } from "./config.ts";
import { secretFileProblem, SecretFileRefusal } from "./secret.ts";

/** Returns the first tracker's repository: the rows the chairman is asked about are filed there */
export function trackerRepo(root: string): string {
  const path = join(root, PROJECT_FILE);
  const declared = JSON.parse(readFileSync(path, "utf8"))?.tracker?.[0]?.repo;
  if (typeof declared !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(declared)) throw new Error(`${path}: tracker[0].repo is not an owner/name`);
  return declared;
}

/** Returns where the delivery log lives: state, not configuration, so apart from the secrets' directory */
export function defaultLedgerPath(home: string): string {
  return join(home, ".local", "state", "agent-org", "messaging", "ledger.jsonl");
}

/** Whether some account is DECLARED, so `gh` will not fall back to a person's */
export function accountIsDeclared(env: Record<string, string | undefined>): boolean {
  return Boolean(env.GH_CONFIG_DIR) || Boolean(env.HERDR_WORKSPACE_ID);
}

/** Returns the file's JSON object, or a refusal: a file that is not JSON is not mended by a restart */
function parsedIds(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch (cause) {
    throw new SecretFileRefusal(path, "it is not valid JSON; pair again", { cause });
  }
}

/** The chairman's ids, from the file `messaging:pair` wrote. Permissions are checked before the content is read. */
export function readChairman(path: string): { userId: number; chatId: number; } {
  const problem = secretFileProblem(path);
  if (problem !== null) throw new SecretFileRefusal(path, `the chairman file is not usable (${problem}); has \`messaging:pair\` been run?`);
  const { userId, chatId } = parsedIds(path);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId)) throw new SecretFileRefusal(path, "it holds no integer userId and chatId; pair again");
  return { userId: userId as number, chatId: chatId as number };
}
