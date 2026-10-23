// agent-org#1501: the five REST reads the host gate's receiving side of a11ign's `deliberateRefusals` job makes of one pull request, through an injected `run`
// (the caller's own `gh`, so its identity and call census stay the caller's). This file spawns nothing: `index.test.ts` holds this
// folder to that. Each answers the raw text and throws as `run` throws; deciding what an unreadable answer means is the caller's, and it is never "clear".
import type { RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

const RAW = ["-H", "Accept: application/vnd.github.raw"];

/** The pull request, as REST records it: state, author, head (sha, ref, repository), base, labels and body. */
export const pullTextOf = (repo: string, number: number | string, run: Run): string => run(["api", `repos/${repo}/pulls/${number}`]);

/** The branch `branch` of `repo`, as the ref API names its tip: what a head GitHub recorded is compared with. */
export const branchRefTextOf = (repo: string, branch: string, run: Run): string => run(["api", `repos/${repo}/git/ref/heads/${branch}`]);

/** The filenames this pull request ADDED, one per line. */
export const addedFilesTextOf = (repo: string, number: number | string, run: Run): string =>
  run(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", '.[] | select(.status == "added") | .filename']);

/** `path` of `repo` as commit `ref` holds it, raw: the acceptance file as the pull request's head left it. */
export const fileAtTextOf = (repo: string, path: string, ref: string, run: Run): string =>
  run(["api", ...RAW, `repos/${repo}/contents/${path}?ref=${ref}`]);

/** `path` of `repo` as its default branch holds it, raw: a consumer's declaration. */
export const defaultBranchFileTextOf = (repo: string, path: string, run: Run): string =>
  run(["api", ...RAW, `repos/${repo}/contents/${path}`]);
