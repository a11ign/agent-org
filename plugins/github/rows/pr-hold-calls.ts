// module: the GitHub operations `pr-hold` asks (A11-160, step 9; moved from `src/pr-hold.ts`)
//
// `pr-hold` DECIDES: who holds a pull request, whether a take is refused, what is read back to prove a write landed, and what an exit code says. What it asks of GitHub and how it reads the answer is here. Each takes the
// runner the hold made with its policy (no bound but the runner's, stderr kept to the failure) and THROWS when `gh` refuses, except the two reads whose name says `null`.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AutoMergeRead, HoldTargetRead } from "../../../src/plugins/contracts/code-host-rows-pullwork.ts";

export function heldPullLabelsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] | null {
  try {
    const pr = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "labels"]));
    if (!Array.isArray(pr.labels)) return null;
    const names = pr.labels.map((l: { name?: unknown }) => l?.name);
    return names.every((n: unknown) => typeof n === "string") ? (names as string[]) : null;
  } catch {
    return null;
  }
}

/** Whether `gh` said THIS label does not exist. */
function isLabelNotFound(error: unknown, label: string): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" && stderr.includes(`'${label}' not found`);
}

export function editHeldPullLabel({ repo, number, label, how, createdWith, run }: { repo: string; number: number; label: string; how: "add" | "remove"; createdWith?: string; run: RowsRun }): void {
  const edit = () => run(["pr", "edit", String(number), "--repo", repo, `--${how}-label`, label]);
  try {
    edit();
  } catch (error) {
    // `gh pr edit --add-label` refuses a label the repository does not have (`'hold:worker-x' not found`): make it, with the description the hand-made ones carry, and add it ONCE MORE. A second `not found` is a fault.
    if (how !== "add" || createdWith === undefined || !isLabelNotFound(error, label)) throw error;
    run(["label", "create", label, "--repo", repo, "--force", "--description", createdWith]);
    edit();
  }
}

export function autoMergeOfHeldPull({ repo, number, run }: { repo: string; number: number; run: RowsRun }): AutoMergeRead | null {
  try {
    // `state` ALONGSIDE `autoMergeRequest`, because a null `autoMergeRequest` means "disarmed" or "merged" and the field cannot tell you which.
    return JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "autoMergeRequest,state"]));
  } catch {
    return null;
  }
}

/** `--repo <repo>` for a pull request of a repository other than the checkout's, else nothing (the calls of the first repository never carried it). */
const aimedAt = (repo: string | undefined): string[] => (repo === undefined ? [] : ["--repo", repo]);

export const autoMergeRequestOfHeldPull = ({ number, repo, run }: { number: number; repo?: string; run: RowsRun }): AutoMergeRead =>
  JSON.parse(run(["pr", "view", String(number), ...aimedAt(repo), "--json", "autoMergeRequest"]));

export function armHeldPull({ number, repo, run }: { number: number; repo?: string; run: RowsRun }): void {
  run(["pr", "merge", "--auto", "--merge", String(number), ...aimedAt(repo)]);
}

export function disarmHeldPull({ number, repo, run }: { number: number; repo?: string; run: RowsRun }): void {
  run(["pr", "merge", "--disable-auto", String(number), ...aimedAt(repo)]);
}

export function holdTargetRowOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): HoldTargetRead | null {
  try {
    const row = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "state,labels,closedByPullRequestsReferences,body,comments"]));
    const state = String(row.state ?? "").toLowerCase();
    if (!["open", "closed"].includes(state) || !Array.isArray(row.labels) || !Array.isArray(row.closedByPullRequestsReferences)) return null;
    const openPullRequests = row.closedByPullRequestsReferences.map((ref: { number: number; repository?: { name?: string; owner?: { login?: string } } }) =>
      ({ number: ref.number, repo: `${ref.repository?.owner?.login}/${ref.repository?.name}` }));
    return { state: state as HoldTargetRead["state"], labels: row.labels.map((l: { name: string }) => l.name), openPullRequests, row };
  } catch {
    return null;
  }
}
