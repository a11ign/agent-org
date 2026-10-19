// @ts-check
// module: Claude Code's transcripts -- which session a folder ran in, and the tokens a run spent

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The transcript of one Claude session, wherever Claude Code filed it. A session is filed under the project Claude Code resolves for its folder,
 * which for a worktree under an already-known directory is that directory's project, not one named after the worktree (measured 2026-10-13: a
 * worker in `<work>/.tickets/SMOKE-1/smoke` wrote to `-Users-…-repos-work/<id>.jsonl`). So it is found by the session id herdr reports.
 */
export function findTranscript(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Claude Code's name for a folder's project: every character but a letter or a digit becomes `-`. */
const projectName = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, "-");

/** The bytes of a transcript read to find the folder its session ran in, which Claude Code records on its first messages. */
const TRANSCRIPT_HEAD_BYTES = 65_536;

function headOf(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The id of the newest Claude session that ran in `folder`, or null. A worker starts in its ticket's folder, and Claude Code files its session
 * under that folder's own project (seen 2026-10-16: `-Users-…-work--tickets-NBF-1463`, each transcript recording that folder as its `cwd`).
 * Only that project is read, and a session is taken only when its transcript records `folder`: the newest is the ticket's latest worker.
 */
export function findFolderSession(root: string, folder: string): string | null {
  const dir = join(root, projectName(folder));
  if (!existsSync(dir)) return null;
  const cwd = `"cwd":${JSON.stringify(folder)}`;
  let newest: { id: string; at: number } | null = null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    const file = join(dir, name);
    const at = statSync(file).mtimeMs;
    if ((newest === null || at > newest.at) && headOf(file).includes(cwd)) newest = { id: name.slice(0, -".jsonl".length), at };
  }
  return newest?.id ?? null;
}

/** Input and output tokens in one transcript. Input counts cache reads and writes, which are what a run spends. */
export function countTokens(file: string | null): { input: number; output: number } {
  let input = 0;
  let output = 0;
  if (file === null || !existsSync(file)) return { input, output };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("\"usage\"")) continue;
    try {
      const usage = (JSON.parse(line) as { message?: { usage?: Record<string, number> } }).message?.usage;
      if (!usage) continue;
      input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      output += usage.output_tokens ?? 0;
    } catch {
      // a partial last line of a live transcript
    }
  }
  return { input, output };
}
