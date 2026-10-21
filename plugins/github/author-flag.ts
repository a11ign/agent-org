#!/usr/bin/env node
// module: the GitHub plugin's authoring switch -- whether a failed App-token mint may still AUTHOR as the shared account (agent-org#1666, moved here by A11-160)
//
// THE RULE. A worker, manager or reviewer call that writes a pull request (`pr create`, `pr merge`, `pr review`, which is the review and the approval) is never sent as
// the account `a11ign-ai-workers` (or the others) because its App's token could not be minted: the author of the pull request is the account, and the account
// is shared by every session. The wrapper mints it again, a bounded number of times (`A11Y_APP_AUTHOR_MINTS`), and REFUSES the call, non-zero and nothing sent, when
// every mint fails. READS still fall back to the account, as before: a read authors nothing.
//
// THE SWITCH IS `gh.refuseFallbackAuthor`, in the canary state (`machinery-canary.json`), OFF when absent. The wrapper reads it by running this file as a
// script, once per authoring call under an app role, and a state it cannot read is OFF: the fallback is today's behaviour and not a refusal of every merge.
//
// A LEAF, run as a program (`node author-flag.ts <canary state file>`): `node:` modules only, so the wrapper's one `node` start for the switch is cheap and imports nothing of core. The
// switch's name is core's too (`src/gh-author-fallback.ts` holds the signal the health reading counts; `machinery-flag.ts` registers the flag), so `wrapper.test.ts` holds the two names to one.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The switch: the key of the canary state's flags. */
export const REFUSE_AUTHOR_FALLBACK_FLAG = "gh.refuseFallbackAuthor";

/**
 * Whether the switch is ON in a canary state's text. ABSENT, malformed or not an object is OFF, and so is a flag whose record says anything but `on: true`:
 * `machineryFlagOn`'s rule, read here without importing the module that holds it.
 * @param text the file's text, or `null` when it does not exist
 * @returns the state the wrapper acts on
 */
export function authorFallbackRefusalOn(text: string | null): boolean {
  if (text === null || text.trim() === "") return false;
  try {
    const parsed = JSON.parse(text) as { flags?: Record<string, { on?: unknown } | undefined> };
    return parsed?.flags?.[REFUSE_AUTHOR_FALLBACK_FLAG]?.on === true;
  } catch {
    return false;
  }
}

/** The script: `node author-flag.ts <canary state file>` prints `on` or `off`, and exits 0 either way. An unreadable file is `off`, said on stderr. */
export function main(argv: readonly string[] = process.argv.slice(2), { read = (path: string) => readFileSync(path, "utf8"), out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) } = {}): number {
  const [path] = argv;
  if (path === undefined) {
    err("usage: author-flag.ts <machinery-canary.json>\n");
    return 2;
  }
  let text: string | null = null;
  try {
    text = read(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") err(`gh-author-fallback: ${path} could not be read (${String((cause as Error).message).split("\n")[0]}), so the switch is off\n`);
  }
  out(`${authorFallbackRefusalOn(text) ? "on" : "off"}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
