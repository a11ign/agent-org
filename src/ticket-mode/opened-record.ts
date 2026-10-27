// @ts-check
// module: the pull requests a run opened while it ran (A11-358) -- the address the hook records, and how the hook and the board read the record back
//
// A RUN THAT WROTE `working` HAS NO OUTCOME THAT LISTS ITS PULL REQUESTS, so the board knew none of the ones it had opened: toolchain#60, opened by A11-254's worker in another repository, had a review asking for changes and nothing watched it.
// The PostToolUse hook appends the address a creating command printed to `opened-pulls.jsonl` beside the outcome file; the board reads it on every watch and keeps the addresses on the run (`Entry.opened`). Only the hook writes the file.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENED_FILE } from "./worker-files.ts";

/** A pull request a run opened: its repository (`owner/name`) and its address. */
export type OpenedPull = Readonly<{ repo: string; url: string }>;

/** A command that creates a pull request and prints its address: `gh pr create`, and the tool's own `pr:open create`, at the head of a command (after `cd x &&`, a pipe or a new line), not named inside another's arguments. */
const CREATING = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:gh\s+pr\s+create\b|(?:\S+\s+){0,2}\S*pr:open\b[^\n;&|]*\bcreate\b)/;

/** A pull request's address in some text, and the repository it names. */
const PULL_ADDRESS = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?![\w/])/g;

/** The text a Bash tool response holds: its `stdout` when it is an object, else the response itself when it is a string. PURE. */
function outputOf(response: unknown): string {
  if (typeof response === "string") return response;
  const stdout = (response as { stdout?: unknown } | null)?.stdout;
  return typeof stdout === "string" ? stdout : "";
}

/** The pull request a creating command made, read from what it printed (the last address, which is the new pull request's), or null when the command creates none or printed none. PURE. */
export function createdPullOf(command: string, response: unknown): OpenedPull | null {
  if (!CREATING.test(command)) return null;
  const found = [...outputOf(response).matchAll(PULL_ADDRESS)].at(-1);
  return found === undefined ? null : { repo: found[1], url: found[0] };
}

/** Append `pull` to the record in `ticketDir`, once: an address already there is not written again. Throws when the record cannot be written. */
export function recordOpenedPull(ticketDir: string, pull: OpenedPull): void {
  if (readOpenedPulls(ticketDir).some(({ url }) => url === pull.url)) return;
  appendFileSync(join(ticketDir, OPENED_FILE), `${JSON.stringify(pull)}\n`);
}

/** The pull requests the record in `ticketDir` holds, oldest first. None where there is no record, and a line it cannot read is skipped: the record only ever adds to what the board watches. */
export function readOpenedPulls(ticketDir: string): readonly OpenedPull[] {
  const file = join(ticketDir, OPENED_FILE);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      try {
        const { repo, url } = JSON.parse(line) as Partial<OpenedPull>;
        return typeof repo === "string" && typeof url === "string" ? [{ repo, url }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
