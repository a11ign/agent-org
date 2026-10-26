// module: the house notes every worker and reviewer is briefed with, written beside the host file and named under `tickets.brief` and `tickets.review` (A11-145)
//
// THE SHIPPED TEXT IS MACHINE-INDEPENDENT. It says the outcome-file shapes, proof before merge, and how a pull request is opened, and nothing about any
// organisation's repositories, fleet, decision records, accounts or conventions plugin: agent-org is public (A11-143 Decision 2). An organisation's own rules
// travel in its profile, as `notes.worker` and `notes.review`, and the file those name is copied instead. The shipped text does not claim a GitHub App
// identity: on a laptop the workers act as the person (A11-143 Decision 9).
//
// A FILE THAT EXISTS IS NEVER OVERWRITTEN, and its difference from the shipped text is not an error: a person edits these. The key is set only when the
// file and the key are both absent, so a host that already has its own notes keeps them.
import { join } from "node:path";
import { CHECK_CHANGED_RULE, PUSH_ONCE_RULE } from "../ticket-mode/ci-spend/rules.ts";
import { escalationList } from "../ticket-mode/escalation.ts";
import { END_AT_PUSH } from "../ticket-mode/ci-wait.ts";
import { agentOrgHome, type Env } from "./paths.ts";

export const WORKER_NOTES = `# Worker house rules

- **Identity.** Every \`gh\` call goes out as the GitHub login this machine's \`gh\` uses. Never set \`GH_TOKEN\` by hand.
- **Toolchain and pushes.** ${PUSH_ONCE_RULE}
- **Checks while you work.** ${CHECK_CHANGED_RULE}
- **After a push.** ${END_AT_PUSH}
- **Releases.** A change to a published package carries a changeset. A change with no release says \`no-release: <reason>\` in the pull request body.
- **Acceptance.** A pull request carries \`.acceptance/<branch>.md\`. It says what the change does and gives an \`Acceptance:\` bash block that proves it. The reviewer runs that block.
- **Opening a pull request:** use \`gh pr create\`, ready and not draft. Its body says what changed and how it was verified, names the ticket with \`Closes <ticket key>\` when the pull request completes the ticket, or \`Refs <ticket key>\` with a \`Partial: <what remains>\` line when it does not (a plan step, \`step <N> of <M>\`, never an After-merge line of the Done-when: a pull request that leaves only those names the ticket \`Closes\`; pull requests that finish the ticket together each say \`Refs\`, with the others named in their \`Partial:\` line and no \`partial\` in the outcome), and gives an \`Outside-Region: <path> — <reason>\` line for each path outside the plan.
- **Never** force-push, merge, or publish. Those are the person's.

## Proof before merge

Every line of a ticket's Acceptance and Done-when is proven by a named test or a runnable check, and the pull request body says which proves which. If a line can only be proven after merge, build the check so it runs against your branch before merge, and say how to run it. A check that only the person's session can run now is not a stop: ask it with a \`session\` wait (below).

## Outcome file shape (exact)

The board reads outcome.json strictly. A wrong field name reads as "could not be read" and shows the ticket as Needs you, although nothing was asked. Use exactly these:

- Pull request ready: { "kind": "ready-pr", "prs": [ { "repo": "owner/repo", "url": "https://github.com/owner/repo/pull/1" } ], "reason": "one line" }  -- \`prs\` is an ARRAY of {repo, url}; never \`pr\`.
- Waiting on events the board reads for you (your brief lists them): { "kind": "working", "reason": "what you wait for", "waitingOn": [ { "<event>": "<id>" } ], "until": "<ISO time>" }  -- then END YOUR TURN: the board prompts you when all of them have finished or any has failed, and once if \`until\` passes. Never write a wait loop, a \`sleep\` or a \`pgrep -f\` to wait for them.
- Waiting on something only the person's session can do (running a command on the person's machine, reading the board, a live check): { "kind": "working", "reason": "what you ask", "waitingOn": [ { "session": "<the exact command, where it runs, and what a pass looks like>" } ], "until": "<ISO time>" }  -- then END YOUR TURN: the board lists the ask in the session's queue (\`GET /api/session-asks\`), the session answers it (\`POST /api/session-asks/<KEY>/answer\`), and the board prompts you with the result. Never write \`needs-human\` for it.
- Still running your own background work (a shell or a Monitor): { "kind": "working", "reason": "what is still running", "waitingOn": "<what>", "until": "<ISO time>" }  -- before a long wait; \`waitingOn\` and \`until\` are optional, and the board reads \`until\` as the end of the wait.
- Nothing to build, done-when holds: { "kind": "checked", "reason": "what you read" }
- A person must act, for an item on the escalation list below: { "kind": "needs-human", "reason": "the one thing only they can do", "escalation": "<id>" }
- Wrong repository: { "kind": "wrong-repo", "where": "owner/repo" }

Before ending your turn, re-read the file you wrote and check each key against this list.

## Ending a run

Use \`checked\` when you verified something and there is nothing to change. Use \`needs-human\` only for an item on the escalation list, and name its id in \`escalation\`. ${escalationList()}

Everything else you decide yourself, in line with the plan and the ticket's Decisions, and list under "Decisions made without a person" in the pull request body.
`;

export const REVIEW_NOTES = `# How pull requests are reviewed

A pull request is opened ready, never as a draft. Once it is ready, this machine's reviewer runs on its head and posts a verdict: APPROVED, or CHANGES_REQUESTED with each finding.

**What the worker does not wait for.** CI on the last commit, and that review. The board watches both, and starts a round when a required check is red or the review has findings. Answer every finding: fix it, with a test where it is about behaviour, or rebut it with evidence. Then push, reply once on the pull request, and end the round. A new head gets a new review.

**Merging.** A person merges the pull request. Nothing is published anywhere.
`;

/** The two house notes: the key each one is named under in the host file's `tickets`, its file name beside the host file, and the shipped text. */
const NOTES = [
  { key: "brief", file: "worker-notes.md", shipped: WORKER_NOTES, profile: "worker" },
  { key: "review", file: "review-notes.md", shipped: REVIEW_NOTES, profile: "review" },
] as const;

export type NoteKey = (typeof NOTES)[number]["key"];

/** What the house notes do: each file to write, the `tickets` keys to set, and one line per note saying what was done. */
export type HouseNotes = Readonly<{ writes: readonly Readonly<{ path: string; text: string }>[]; keys: Readonly<Partial<Record<NoteKey, string>>>; lines: readonly string[] }>;

/**
 * The notes to write for a host whose `tickets` hold `keys`, and whose files exist where `exists` says. A note whose key is named, or whose file exists, is left
 * as it is and said. A profile's `notes` file is copied instead of the shipped text, when it is written. PURE: the reads and the existence check are injected.
 */
export function houseNotes({ env, home, keys, exists, read, profile = {} }: Readonly<{
  env: Env; home: string; keys: Readonly<Record<string, unknown>>; exists: (path: string) => boolean; read: (path: string) => string;
  profile?: Readonly<Partial<Record<"worker" | "review", string>>>;
}>): HouseNotes {
  const writes: { path: string; text: string }[] = [];
  const named: Partial<Record<NoteKey, string>> = {};
  const lines: string[] = [];
  for (const { key, file, shipped, profile: profileKey } of NOTES) {
    const path = join(agentOrgHome(env, home), file);
    if (keys[key] !== undefined) {
      lines.push(`tickets.${key} is named already: its notes are left as they are`);
    } else if (exists(path)) {
      lines.push(`${path} exists, so it is kept and not overwritten, and tickets.${key} is not set`);
    } else {
      const from = profile[profileKey];
      writes.push({ path, text: from === undefined ? shipped : read(from) });
      named[key] = path;
      lines.push(`wrote ${path}${from === undefined ? "" : `, copied from ${from}`}, and named it under tickets.${key}`);
    }
  }
  return { writes, keys: named, lines };
}
