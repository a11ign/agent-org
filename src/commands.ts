// @ts-check
// #3068: THE COMMAND TABLE -- what `agent-org <command>` runs. DATA, one table, read by `bin.ts` to dispatch and by
// `acceptance-commands.ts` (a11ign/a11ign#3063) to resolve a project script `agent-org <command>` to the program it runs.
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
  "board:document": "board-document.ts",
  "board:liveness": "board-schedule-liveness.ts",
  "board:record": "board-record.ts",
  "board:report": "board-report.ts",
  "board:settle": "settle-closed-rows.ts",
  "board:summary-check": "board-summary-check.ts",
  "branches:inventory": "branch-inventory-report.ts",
  "branches:stranded": "stranded-branches.ts",
  "chairman:reply": "messaging/reply-cli.ts",
  "dora": "dora.ts",
  "fleet:batch-now": "fleet-gated-nightly.ts",
  "host:check": "host-units.ts",
  "host:install": "host-units.ts",
  "hygiene:report": "control-plane-hygiene.ts",
  "messaging:chats": "messaging/chats.ts",
  "messaging:listen": "messaging/listen.ts",
  "messaging:pair": "messaging/providers/telegram/pair.ts",
  "messaging:selftest": "messaging/selftest.ts",
  "messaging:watch": "messaging/watch.ts",
  "pr:edit": "pr-open.ts",
  "pr:hold": "pr-hold.ts",
  "pr:open": "pr-open.ts",
  "pr:release": "pr-hold.ts",
  "primary:mark": "mark-primary-checkout.ts",
  "primary:update": "update-primary.ts",
  "prompt:session": "prompt-session.ts",
  "queue:table": "queue-table.ts",
  "ready:audit": "ready-label-audit.ts",
  "rescue:hunk": "rescue-hunk.ts",
  "row-claim": "row-claim.ts",
  "row-file": "row-file.ts",
  "ruling:record": "ruling-record.ts",
  "spawn:cycles": "wake.ts",
  "stash:whose": "stash-whose.ts",
  "survey": "survey.ts",
  "trace": "trace/trace.ts",
  "tracker:comment": "tracker-comment.ts",
  "wakes:per-row": "wakes-per-row.ts",
  "work:gate": "work-gate.ts",
  "work:profile": "worker-profile.ts",
  "work:tick": "work-tick.ts",
  "work:wake": "wake.ts",
  "worker:state": "worker-state.ts",
  "workflow:liveness": "workflow-run-liveness.ts",
  "worktree:stamp": "worktree-owner.ts",
  "worktree:whose": "worktree-owner.ts",
  "worktrees:prune": "prune-worktrees.ts",
  // Reachable by file name: no project script has ever named these.
  "acceptance-commands": "acceptance-commands.ts",
  "arm-pr": "arm-pr.ts",
  "auto-arm-sweep": "auto-arm-sweep.ts",
  "board-discussion": "board-discussion.ts",
  "board-snapshot": "board-snapshot.ts",
  "carry-branch": "carry-branch.ts",
  "changed-files": "lib/changed-files.ts",
  "changed-packages": "lib/changed-packages.ts",
  "ci-changed": "lib/ci-changed.ts",
  "close-rows-for-merged-pr": "close-rows-for-merged-pr.ts",
  "close-rows-sweep": "close-rows-sweep.ts",
  "closes-mismatch-check": "closes-mismatch-check.ts",
  "hand-fix-ledger": "hand-fix-ledger.ts",
  "isolation-gate": "lib/isolation-gate.ts",
  "merge-guard": "merge-guard.ts",
  "merge-queue": "merge-queue.ts",
  "org-retro": "org-retro.ts",
  "org-watch": "org-watch.ts",
  "owned-path-signoff": "owned-path-signoff.ts",
  "parent-recheck-summary": "parent-recheck-summary.ts",
  "prune-tmp": "prune-tmp.ts",
  "queue-stalled": "queue-stalled.ts",
  "reconstitution-drill": "reconstitution-drill.ts",
  "row-reachability": "row-reachability.ts",
  "shadow-window": "shadow-window.ts",
  "test-memory-cap": "lib/test-memory-cap.ts",
  "token-audit": "token-audit.ts",
  "trunk-revert-guard": "trunk-revert-guard.ts",
  "trunk-sweep": "trunk-sweep.ts",
  "update-tool": "update-tool.ts",
};

/**
 * Arguments a command adds BEFORE the caller's own: the project scripts that ran one program in several modes
 * (`host:check` and `host:install` are `host-units.ts` and `host-units.ts --install`).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const FIXED_ARGS: Readonly<Record<string, readonly string[]>> = {
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
export const INTERNAL: Readonly<Record<string, string>> = {
  "branch-inventory.ts": "the pure half of the branch inventory (classification); `branch-inventory-report.ts` runs it",
  "review-verdict.ts": "the one parser for a review verdict comment, imported by the programs that read verdicts",
  "waiting-condition.ts": "the one reader of \"this row is waiting on something\", imported by the gate",
};
