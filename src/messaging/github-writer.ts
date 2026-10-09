// THE `GithubWriter` ANSWERS NEEDS (a11ign/a11ign#3062, row 9b): the four calls `answers.ts` makes on a row, over `gh`. The only module of
// `src/messaging/` that WRITES to GitHub, which is why `watch.ts`'s read-only allowlist stays as it was and this file has an allowlist of its own.
//
// **THE ACCOUNT IS THE UNIT'S, NEVER THE PERSON'S (#1967).** `gh` takes its account from the process's environment, and `listen.ts` refuses to
// start where none is declared. Nothing here chooses one.
//
// **ONE REST SHAPE FOR ALL FOUR, ON THE CORE POOL.** `gh api` is the platform's own paging (`--paginate`) and its own escaping (`-f` sends a
// string as a string), so nothing here builds a query string, a JSON body or a page loop. `run` is injected, so a test owns it and records argv.
//
// **`readRow` READS EVERY COMMENT.** `gh issue list` returns the OLDEST hundred and `latestBrief` needs the NEWEST, so a row past 100 comments
// would be answered against a stale brief; `--paginate` follows the `Link` header to the end.
//
// **`removeLabel` RESOLVES WHEN THE LABEL IS ALREADY ABSENT** (a resumed answer repeats it): GitHub says `Label does not exist` with a 404, and
// ONLY that message is taken as done. Any other failure, a 404 for a missing ROW included, is thrown for `answers.ts` to record and tell the chairman.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64_000_000;
const LABEL_ABSENT = /Label does not exist/i;

/** Returns what `gh` printed; a non-zero exit rejects, with `stderr` on the error */
async function runGh(argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...argv], { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8" });
  return stdout;
}

/** Returns the REST path of the row's issue; a row is a pair this program was configured with, but a path is only built from a well-formed one */
function issuePath({ repo, number }: { repo: string; number: number; }): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new TypeError(`github writer: ${repo}#${number} is not a row`);
  return `repos/${repo}/issues/${number}`;
}

/** Returns what `gh` said on stderr, else the message */
function saidBy(error: unknown): string {
  const failure = (error ?? {}) as { stderr?: unknown; message?: unknown };
  return `${typeof failure.stderr === "string" ? failure.stderr : ""} ${typeof failure.message === "string" ? failure.message : ""}`;
}

export function createGithubWriter({ run = runGh }: { run?: (argv: readonly string[]) => Promise<string>; } = {}): import("./answers.ts").GithubWriter {
  return {
    async readRow(row) {
      const path = issuePath(row);
      const issue = JSON.parse(await run(["api", path, "--jq", "{state: .state, labels: [.labels[].name]}"]));
      // `tojson` makes each comment ONE line however `gh` formats an object: `--paginate` runs `--jq` on each page and prints the results one after another.
      const lines = (await run(["api", "--paginate", `${path}/comments`, "--jq", ".[] | {body, createdAt: .created_at, authorAssociation: .author_association} | tojson"])).split("\n");
      const comments = lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
      return { state: String(issue.state), labels: issue.labels, comments };
    },
    async comment(row, body) {
      await run(["api", "--method", "POST", `${issuePath(row)}/comments`, "-f", `body=${body}`]);
    },
    async removeLabel(row, label) {
      try {
        await run(["api", "--method", "DELETE", `${issuePath(row)}/labels/${encodeURIComponent(label)}`]);
      } catch (error) {
        if (!LABEL_ABSENT.test(saidBy(error))) throw error;
      }
    },
    async addLabel(row, label) {
      await run(["api", "--method", "POST", `${issuePath(row)}/labels`, "-f", `labels[]=${label}`]);
    },
  };
}
