#!/usr/bin/env node
// agent-org#1268: `node scripts/review-eval.ts --set blind-2026-10-12 --require 9/11` reviews the labelled set offline with the `row-review` skill and prints the agreement.
//
// THE REAL READS LIVE HERE and the logic in `src/review-eval.ts`, which takes them as `EvalDeps`: the pull request and the row are read through the code host (read-only), the diff is GitHub's
// `compare` of `baseRefOid...headRefOid`, the head's tree is a depth-1 `git fetch` of the commit, and the reviewer is `codex exec` in a READ-ONLY sandbox with no network. NOTHING IS WRITTEN TO GITHUB.
// Run it from any directory: it writes only under a fresh temporary directory it prints.
import { execFileSync } from "node:child_process";
import type { RowsRun } from "../src/plugins/contracts/code-host-rows.ts";
import { rows } from "../src/plugins/rows.ts";
import { main, type EvalDeps } from "../src/review-eval.ts";
import { codexReview } from "../src/run-eval/codex-reviewer.ts";

const BIG_BUFFER = 256 * 1024 * 1024;

// The process is the code host's (A11-160, step 9): `rows()` loads the host file's code host on its own, as `src/trace/publish.ts` and `src/prune-tmp.ts` do when a timer runs them, so this script needs no activation.
// The buffer is this script's: a diff of a large pull request is read whole, and what `gh` prints on stderr stays out of the output (`echo: false`).
const gh = (): RowsRun => rows().runnerWith({ maxBuffer: BIG_BUFFER, echo: false });

const deps: EvalDeps = {
  readPullRequest: (repo, number) => rows().pullForReviewEvalOf({ repo, number, run: gh() }),
  readRow: (repo, number) => rows().rowForReviewEvalOf({ repo, number, run: gh() }),
  readDiff: (repo, base, head) => rows().compareDiffOf({ repo, base, head, run: gh() }),
  // `git`, not a tarball through `gh api`: the `gh` wrapper reads a call's output as text and truncates a binary body. A depth-1 fetch of the head's SHA is the commit's tree and nothing else.
  checkout: (repo, sha, dir) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    git("init", "--quiet", ".");
    git("remote", "add", "origin", `https://github.com/${repo}.git`);
    git("fetch", "--quiet", "--depth", "1", "origin", sha);
    git("checkout", "--quiet", "FETCH_HEAD");
  },
  review: codexReview,
};

process.exitCode = await main(process.argv.slice(2), deps);
