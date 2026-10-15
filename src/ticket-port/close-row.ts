// agent-org#1536: THE WRITE THAT CLOSES A ROW ON A WORKER'S OWN READING, as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing, and it is under `src/ticket-port/` because `gh-call-ratchet.test.ts` refuses a new call shape anywhere else.
// A refused `run` THROWS: the caller decides what the throw means, and a row it could not close is reported as NOT CLOSED, never as closed.

type Run = (args: string[]) => string;

/** `repo` is `owner/name`, `row` the issue's number in it, and `comment` the body the close leaves on the row. */
export function closeRowWithComment({ row, repo, comment, run }: { row: number; repo: string; comment: string; run: Run }): void {
  run(["issue", "close", String(row), "--repo", repo, "--comment", comment]);
}
