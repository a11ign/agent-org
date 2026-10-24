A run whose feedback round ended `reviewed` no longer reads Ready to merge whatever GitHub says (A11-179). It reads Ready to merge only when every open pull request of the run is approved at its current head (by the board's reviewer or a person, with GitHub's review decision not still asking for a review or for changes) and its required checks are green there; otherwise it reads Awaiting review, its outcome stays `reviewed`, and its card says what it waits on: `review: none yet at 58848c34`, `checks red: gate`, `checks not passed: gate`, or `not read yet`. The pool's watch records each head's review, red required checks and running required checks (`pullHeads`) from new optional `PullFeedback` fields of the code host contract (1.13: `reviewDecision`, `verdictAtHead`, `pendingRequired`, `body`), read by `plugins/github` in the query it already made. A check that is also red on the head of the repository's default branch (the new optional `readDefaultBranchRed`), or on another run's pull request in the same repository that changes none of the run's plan paths, starts no fix round, is not rerun and is named on the card as `<check> is red on main / not this run's`, with the ticket a `Blocked-by:` line or the check's refusal text names; it is looked at again on every watch.

Acceptance:
```bash
scratch=$(mktemp -d)
mkdir "$scratch/nogh" "$scratch/project"
printf '%s\n' '#!/bin/sh' 'echo "gh is not available in this run" >&2' 'exit 1' > "$scratch/nogh/gh"
chmod +x "$scratch/nogh/gh"
cp -r src/packaging/fixtures/project-tree/. "$scratch/project"
sed -i "s|@@PROJECT@@|$scratch/project|" "$scratch/project/.agent-org/host.json"
git -C "$scratch/project" init -q
git -C "$scratch/project" add -A
git -C "$scratch/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
export AGENT_ORG_HOST="$scratch/project/.agent-org/host.json"
# 1. the plugin reads the new fields and the default branch's red checks, the fake and the plugin pass the contract suite, and the red-check pass names a check that is red elsewhere: all over a gh that fails every call
PATH="$scratch/nogh:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins src/ticket-mode/pool-checks.test.ts src/ticket-mode/ticket-references.test.ts
# 2. the four lines of the ticket's Acceptance, on the pure decisions and the red-check pass over the fake code host
PATH="$scratch/nogh:$PATH" node --input-type=module <<'JS'
import { runStatus } from "./src/ticket-mode/board-view/pull-status-and-notes.ts";
import { reasonOf } from "./src/ticket-mode/board-view/run-reason.ts";
import { answerChecks } from "./src/ticket-mode/pool-checks.ts";
import { createFakeCodeHost } from "./src/plugins/fakes/code-host.ts";
const url = "https://github.com/a11ign/a11ign/pull/5717";
const reviewed = (head) => ({ ticket: { key: "A11-177" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "a11ign", url }] }, pullStates: { [url]: "open" },
  pullHeads: { [url]: { head: "58848c34a1b2", approved: true, review: "approved", red: [], pending: [], ...head } } });
const failures = [];
for (const [what, head, status, line] of [
  ["reviewed outcome and no approval", { approved: false, review: "none" }, "awaiting-review", "review: none yet at 58848c34"],
  ["approved and a required check red", { red: ["gate"] }, "awaiting-review", "checks red: gate"],
  ["approved and green", {}, "ready-to-merge", null],
]) {
  const entry = reviewed(head);
  const got = [runStatus(entry), reasonOf(entry).line, entry.outcome.kind];
  if (JSON.stringify(got) !== JSON.stringify([status, line, "reviewed"])) failures.push(`${what}: ${JSON.stringify(got)}`);
}
const host = createFakeCodeHost();
host.checksAndClaims.logs.set("https://github.com/a11ign/a11ign/actions/runs/10/job/1", "refusalOwners: REFUSED -- A11-127 retires this check");
const read = { state: "open", feedbackAt: null, authors: [], failing: ["refusalOwners"], failures: [{ name: "refusalOwners", detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/10/job/1" }], failedAt: null,
  conflicting: false, mergeable: true, head: "58848c34a1b2", approvedAtHead: false, base: "main", files: [], filesComplete: true };
const answered = answerChecks({ codeHost: host }, reviewed({}), [{ url, read }], () => new Set(["refusalOwners"]));
if (answered.feedback !== null) failures.push("a check red on main started a fix round");
if (answered.heads[url]?.note !== "refusalOwners is red on main / not this run's; owned by A11-127") failures.push(`the card's note: ${answered.heads[url]?.note}`);
if (host.checksAndClaims.reruns.length !== 0) failures.push("a check red on main was rerun");
if (failures.length > 0) { console.error(failures.join("\n")); process.exit(1); }
console.log("the four lines of the Acceptance hold");
JS
rm -rf "${scratch:?}"
```

The board's side of the watch (the pool records the heads, a reviewed run stays watched and is read again until it merges, Publish refuses a run that is not ready, a check red on main starts no round end to end, and a check main has since fixed gets its round) is proved by `src/ticket-mode/pool.test.ts` ("A11-179" cases), and the pure status and reason line by `src/ticket-mode/board-view.test.ts`; both run the real pool and the board's view over the fake code host and need the checkout's history, so CI's `suite` job runs them and this block does not.

Consumer-declaration: none -- the code host contract grows OPTIONAL members only (1.13: four optional `PullFeedback` fields and the optional `readDefaultBranchRed`), so a 1.12 code host plugin still passes and the board reads its pull requests as not proven ready; no host file changes meaning. `plugins/github` declares contract 1.13. No other repository reads these modules as a library.
