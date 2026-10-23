// THE `GithubWriter` ANSWERS NEEDS (a11ign/a11ign#3062, row 9b): the four calls `answers.ts` makes on a row, as the code host's `rows` makes them (A11-160, step 8: `readRowAsync`, `commentOnRowAsync`, `removeLabelAsync`, `addLabelAsync`, in
// `plugins/github/rows/messaging-rows.ts`; this file holds the bound and the buffer of the process they run in). The only module of `src/messaging/` that WRITES to GitHub, which is why `watch.ts`'s read-only allowlist stays as it was.
//
// **THE ACCOUNT IS THE UNIT'S, NEVER THE PERSON'S (#1967).** `gh` takes its account from the process's environment, and `listen.ts` refuses to
// start where none is declared. Nothing here chooses one.
//
// **ONE REST SHAPE FOR ALL FOUR, ON THE CORE POOL.** `gh api` is the platform's own paging (`--paginate`) and its own escaping (`-f` sends a
// string as a string), so nothing builds a query string, a JSON body or a page loop. `run` is injected, so a test of the plugin owns it and records argv.
//
// **`readRow` READS EVERY COMMENT.** `gh issue list` returns the OLDEST hundred and `latestBrief` needs the NEWEST, so a row past 100 comments
// would be answered against a stale brief; `--paginate` follows the `Link` header to the end.
//
// **`removeLabel` RESOLVES WHEN THE LABEL IS ALREADY ABSENT** (a resumed answer repeats it): GitHub says `Label does not exist` with a 404, and
// ONLY that message is taken as done. Any other failure, a 404 for a missing ROW included, is thrown for `answers.ts` to record and tell the chairman.

import type { AsyncRowsRun } from "../plugins/contracts/code-host-rows-facts.ts";
import { rows } from "../plugins/rows.ts";

const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64_000_000;

/** The code host's own runner, behind the bound and the buffer this writer has always had; a non-zero exit rejects, with `stderr` on the error. Asked when the first call is made, not when the writer is. */
const runGh: AsyncRowsRun = (argv) => rows().asyncRunnerWith({ timeoutMs: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, echo: false })(argv);

export function createGithubWriter({ run = runGh }: { run?: AsyncRowsRun; } = {}): import("./answers.ts").GithubWriter {
  return {
    readRow: async (row) => rows().readRowAsync({ ...row, run }),
    comment: async (row, body) => rows().commentOnRowAsync({ ...row, body, run }),
    removeLabel: async (row, label) => rows().removeLabelAsync({ ...row, label, run }),
    addLabel: async (row, label) => rows().addLabelAsync({ ...row, label, run }),
  };
}
