// module: the GitHub writes of the claim's rules, and the one compare the stale-rule guard asks (A11-160, step 7; moved from `src/row-claim/`)
//
// The rule DECIDES what is written and in what order (the label, then the row's label, then the comment) and what a refusal means; the command is here. A refused write THROWS: a write that failed is never a write
// that was done. `repo` is the tracker the row lives in.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** Creates the label `name` in `repo`, or leaves it (`--force`, so a second claim's create is harmless). */
export function ensureLabelIn({ repo, name, run }: { repo: string; name: string; run: RowsRun }): void {
  run(["label", "create", name, "--repo", repo, "--force"]);
}

/** Puts `label` on row `number` of `repo`. */
export function addLabelToRowIn({ repo, number, label, run }: { repo: string; number: number; label: string; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--repo", repo, "--add-label", label]);
}

/**
 * What changed in `repo` between commit `sha` and its `main`: GitHub's own compare, one call, nothing cloned. `null` when GitHub cannot say (no `gh`, no token, offline, an unknown sha, an answer of another shape): CANNOT
 * ASK, and never "nothing changed".
 */
export function compareShaWithMain({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): { status: string; files: string[] } | null {
  try {
    const parsed = JSON.parse(run(["api", `repos/${repo}/compare/${sha}...main`, "--jq", "{status: .status, files: [.files[].filename]}"]));
    return typeof parsed.status === "string" && Array.isArray(parsed.files) ? parsed : null;
  } catch (error) {
    void error; // CANNOT ASK is reported by the caller, by name
    return null;
  }
}
