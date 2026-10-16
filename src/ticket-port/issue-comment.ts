// agent-org#1577: THE COMMENT AN ORG REPORT LEAVES ON A STANDING ISSUE, as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing, and it is under `src/ticket-port/` because `gh-call-ratchet.test.ts` refuses a new call shape anywhere else.
// A refused `run` THROWS: the caller decides what the throw means, and a finding it could not post is reported as NOT POSTED, never as posted.

type Run = (args: string[]) => string;

/** `repo` is `owner/name`, `issue` the number in it, and `body` the comment. */
export function commentOnIssue({ repo, issue, body, run }: { repo: string; issue: number; body: string; run: Run }): void {
  run(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
}
