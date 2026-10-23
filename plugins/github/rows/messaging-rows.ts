// module: the GitHub plugin's rows for the chairman's watch and answers (A11-160, step 8; moved from `src/messaging/github-writer.ts`, `watch.ts` and `placeholders.ts`)
//
// Each operation takes the ASYNC `run` its caller holds, builds the argument list the caller built, and REJECTS as the run does. The caller's allowlist of what it may ask (`chairman-watch reads only`) is a `guard` on that run, so it
// refuses the argument lists these operations build, before a process is started.
import type { AsyncRowsRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

const LABEL_ABSENT = /Label does not exist/i;

/** The REST path of the row's issue; a row is a pair a program was configured with, but a path is only built from a well-formed one. */
function issuePath({ repo, number }: { repo: string; number: number }): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new TypeError(`github writer: ${repo}#${number} is not a row`);
  return `repos/${repo}/issues/${number}`;
}

/** What `gh` said on stderr, else the message. */
function saidBy(error: unknown): string {
  const failure = (error ?? {}) as { stderr?: unknown; message?: unknown };
  return `${typeof failure.stderr === "string" ? failure.stderr : ""} ${typeof failure.message === "string" ? failure.message : ""}`;
}

export async function readRowAsync({ repo, number, run }: { repo: string; number: number; run: AsyncRowsRun }): Promise<{ state: string; labels: string[]; comments: { body: string; createdAt: string; authorAssociation: string }[] }> {
  const path = issuePath({ repo, number });
  const issue = JSON.parse(await run(["api", path, "--jq", "{state: .state, labels: [.labels[].name]}"]));
  // `tojson` makes each comment ONE line however `gh` formats an object: `--paginate` runs `--jq` on each page and prints the results one after another.
  const lines = (await run(["api", "--paginate", `${path}/comments`, "--jq", ".[] | {body, createdAt: .created_at, authorAssociation: .author_association} | tojson"])).split("\n");
  const comments = lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  return { state: String(issue.state), labels: issue.labels, comments };
}

export async function commentOnRowAsync({ repo, number, body, run }: { repo: string; number: number; body: string; run: AsyncRowsRun }): Promise<void> {
  await run(["api", "--method", "POST", `${issuePath({ repo, number })}/comments`, "-f", `body=${body}`]);
}

/** A label that is already absent is done (a resumed answer repeats the removal): GitHub says `Label does not exist` with a 404, and ONLY that message is taken as done. */
export async function removeLabelAsync({ repo, number, label, run }: { repo: string; number: number; label: string; run: AsyncRowsRun }): Promise<void> {
  try {
    await run(["api", "--method", "DELETE", `${issuePath({ repo, number })}/labels/${encodeURIComponent(label)}`]);
  } catch (error) {
    if (!LABEL_ABSENT.test(saidBy(error))) throw error;
  }
}

export async function addLabelAsync({ repo, number, label, run }: { repo: string; number: number; label: string; run: AsyncRowsRun }): Promise<void> {
  await run(["api", "--method", "POST", `${issuePath({ repo, number })}/labels`, "-f", `labels[]=${label}`]);
}

export async function issueCommentsAsync({ repo, number, run }: { repo: string; number: number; run: AsyncRowsRun }): Promise<any[]> {
  const row = JSON.parse(await run(["issue", "view", String(number), "-R", repo, "--json", "comments"]));
  return Array.isArray(row?.comments) ? row.comments : [];
}

export async function openPullChecksAsync({ repo, limit, run }: { repo: string; limit: number; run: AsyncRowsRun }): Promise<any[]> {
  return JSON.parse(await run(["pr", "list", "-R", repo, "--state", "open", "--json", "number,labels,statusCheckRollup", "--limit", String(limit)]));
}

export async function restGetAsync({ path, run }: { path: string; run: AsyncRowsRun }): Promise<any> {
  return JSON.parse(await run(["api", path]));
}

export async function pullReviewDecisionAsync({ repo, number, run }: { repo: string; number: number; run: AsyncRowsRun }): Promise<string | null> {
  return JSON.parse(await run(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision"])).reviewDecision ?? null;
}

/** The operations of this group. */
export const messagingRows = { readRowAsync, commentOnRowAsync, removeLabelAsync, addLabelAsync, issueCommentsAsync, openPullChecksAsync, restGetAsync, pullReviewDecisionAsync };
