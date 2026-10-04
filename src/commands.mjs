// @ts-check
// #3068: THE COMMAND TABLE -- what `agent-org <command>` runs. DATA, one table, read by `bin.mjs` to dispatch and by
// `acceptance-commands.mjs` (a11ign/a11ign#3063) to resolve a project script `agent-org <command>` to the program it runs.
// So this file is plain ESM with NO top-level await and NO import, which lets `require()` load it synchronously (3063 does).
//
// A command is the name a project's `package.json` script used (`pr:open`, `board:settle`, `row-file`), so moving a project from
// `node packages/agent-org/src/x.mjs` to `pnpm exec agent-org <name>` changes the program's path and nothing else. A program no script named
// is reachable under its file's name (`merge-guard`), so a workflow can call it the same way. `packaging/bin-commands.test.ts` pins that every
// program whose header says `// command:` is here or in `INTERNAL` with its reason, and that every entry names a file.
//
// NO DEFAULT COMMAND: a name that is not here is REFUSED by name, with this list, never answered by running something.

/** Command name -> the program under `src/` it runs. */
export const COMMANDS = {
  "board:document": "board-document.mjs",
  "board:liveness": "board-schedule-liveness.mjs",
  "board:record": "board-record.mjs",
  "board:report": "board-report.mjs",
  "board:settle": "settle-closed-rows.mjs",
  "board:summary-check": "board-summary-check.mjs",
  "branches:inventory": "branch-inventory-report.mjs",
  "branches:stranded": "stranded-branches.mjs",
  "chairman:reply": "messaging/reply-cli.mjs",
  "dora": "dora.mjs",
  "fleet:batch-now": "fleet-gated-nightly.mjs",
  "host:check": "host-units.mjs",
  "host:install": "host-units.mjs",
  "hygiene:report": "control-plane-hygiene.mjs",
  "messaging:listen": "messaging/listen.mjs",
  "messaging:pair": "messaging/providers/telegram/pair.mjs",
  "messaging:watch": "messaging/watch.mjs",
  "pr:edit": "pr-open.mjs",
  "pr:hold": "pr-hold.mjs",
  "pr:open": "pr-open.mjs",
  "pr:release": "pr-hold.mjs",
  "primary:mark": "mark-primary-checkout.mjs",
  "primary:update": "update-primary.mjs",
  "prompt:session": "prompt-session.mjs",
  "queue:table": "queue-table.mjs",
  "ready:audit": "ready-label-audit.mjs",
  "rescue:hunk": "rescue-hunk.mjs",
  "row-claim": "row-claim.mjs",
  "row-file": "row-file.mjs",
  "ruling:record": "ruling-record.mjs",
  "spawn:cycles": "wake.mjs",
  "stash:whose": "stash-whose.mjs",
  "survey": "survey.mjs",
  "trace": "trace/trace.mjs",
  "tracker:comment": "tracker-comment.mjs",
  "wakes:per-row": "wakes-per-row.mjs",
  "work:gate": "work-gate.mjs",
  "work:profile": "worker-profile.mjs",
  "work:tick": "work-tick.mjs",
  "work:wake": "wake.mjs",
  "workflow:liveness": "workflow-run-liveness.mjs",
  "worktree:stamp": "worktree-owner.mjs",
  "worktree:whose": "worktree-owner.mjs",
  "worktrees:prune": "prune-worktrees.mjs",
  // Reachable by file name: no project script has ever named these.
  "acceptance-commands": "acceptance-commands.mjs",
  "arm-pr": "arm-pr.mjs",
  "auto-arm-sweep": "auto-arm-sweep.mjs",
  "board-discussion": "board-discussion.mjs",
  "board-snapshot": "board-snapshot.mjs",
  "carry-branch": "carry-branch.mjs",
  "changed-files": "lib/changed-files.mjs",
  "changed-packages": "lib/changed-packages.mjs",
  "ci-changed": "lib/ci-changed.mjs",
  "close-rows-for-merged-pr": "close-rows-for-merged-pr.mjs",
  "close-rows-sweep": "close-rows-sweep.mjs",
  "closes-mismatch-check": "closes-mismatch-check.mjs",
  "hand-fix-ledger": "hand-fix-ledger.mjs",
  "isolation-gate": "lib/isolation-gate.mjs",
  "merge-guard": "merge-guard.mjs",
  "merge-queue": "merge-queue.mjs",
  "org-retro": "org-retro.mjs",
  "org-watch": "org-watch.mjs",
  "owned-path-signoff": "owned-path-signoff.mjs",
  "parent-recheck-summary": "parent-recheck-summary.mjs",
  "prune-tmp": "prune-tmp.mjs",
  "queue-stalled": "queue-stalled.mjs",
  "reconstitution-drill": "reconstitution-drill.mjs",
  "row-reachability": "row-reachability.mjs",
  "select-changed-tests": "lib/select-changed-tests.mjs",
  "shadow-window": "shadow-window.mjs",
  "test-memory-cap": "lib/test-memory-cap.mjs",
  "token-audit": "token-audit.mjs",
  "trunk-revert-guard": "trunk-revert-guard.mjs",
  "trunk-sweep": "trunk-sweep.mjs",
  "update-tool": "update-tool.mjs",
};

/**
 * Arguments a command adds BEFORE the caller's own: the project scripts that ran one program in several modes
 * (`host:check` and `host:install` are `host-units.mjs` and `host-units.mjs --install`).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const FIXED_ARGS = {
  "spawn:cycles": ["--cycles"],
  "host:install": ["--install"],
  "pr:release": ["--release"],
  "pr:open": ["create"],
  "pr:edit": ["edit"],
  "worktree:stamp": ["--stamp"],
};

/**
 * Programs whose header says `// command:` but is not one: each is IMPORTED by other programs, never run, and its header says so. A program
 * is listed with the reason, and a program that is neither here nor in `COMMANDS` fails `packaging/bin-commands.test.ts`.
 * @type {Readonly<Record<string, string>>}
 */
export const INTERNAL = {
  "branch-inventory.mjs": "the pure half of the branch inventory (classification); `branch-inventory-report.mjs` runs it",
  "review-verdict.mjs": "the one parser for a review verdict comment, imported by the programs that read verdicts",
  "waiting-condition.mjs": "the one reader of \"this row is waiting on something\", imported by the gate",
};
