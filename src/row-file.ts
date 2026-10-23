#!/usr/bin/env node
// @ts-check
// command: refuse to file a backlog row via `gh issue create` when its body is missing a required
// section, or board/label it wrong -- see #844's own addition below for the second half
// #735: THE SAME GATE #707 PUT ON THE CLAIM SIDE, CALLED FROM THE FILING SIDE INSTEAD.
//
// #844: THE TEMPLATE CHECK ALONE STILL LET A FILED ROW LAND OFF THE BOARD. Measured by `product-manager`:
// five rows filed through this tool in one night were not on Project 2, and one carried no labels at all
// -- `gh issue create` needs neither, and this file checked only the body. So filing now also boards the
// new issue on Project 2 and moves its Status to match a label (`backlog` unless `--ready` is given, in
// which case `ready` -- never both), and REFUSES to report success until a fresh read-back confirms the
// label, the `Filed-by:` line and the Status all actually landed -- a row this cannot board is refused,
// not reported filed halfway.
//
// THE LABEL LANDS LAST, NOT AT `gh issue create` TIME, AND THAT ORDER IS LOAD-BEARING. Found by
// dogfooding this exact fix (#867, filed live with `--ready` while building it): a `ready` label present
// before the item has a Status makes the row itself the exact shape #747's own board-safety floor exists
// to catch (an OPEN `ready` issue with no Status), so `moveProjectStatus`'s own pre-write snapshot
// refused every `--ready` filing on itself, always. See `boardAndVerify`'s own header for the full
// account and why labelling last is safe.
//
// #883, dispatcher's ruling: A ROW ALSO GETS A `lane:<owner>` LABEL, DERIVED FROM ITS OWN `## Region`,
// SO READY IS READABLE BY LANE. Before this, a session watching Ready for its own lane could not tell an
// unlabelled row apart from one nobody had assigned -- `worker-config` held idle twice in one evening
// rather than self-select from an unlabelled column (the row's own filing cites both). The part that is
// the ruling rather than an implementation choice: the derivation reads `docs/lane-ownership.json`
// through `loadLanes`/`inLane`, THE SAME FUNCTIONS `lane-ownership.ts` owns (the merge guard that also read them was retired) --
// never a second, hand-typed spelling of the same rule that could drift from the guard that actually
// refuses the branch. A Region touching two lanes gets BOTH labels, never one picked silently (see
// `laneLabelsFor`); a Region touching none gets `lane:any`, a real answer, not a fallback. A missing or
// malformed lane file is CANNOT_ASK -- refused before `gh issue create` even runs, identically to the
// retired merge guard's own `laneVerdict` refusing rather than reading silence as "no path has a lane". The
// lane label(s) travel through the same "label lands last" step as the board label above, for the
// identical reason: the pre-write board snapshot must never see `ready` on a row with no Status, lane
// label or not. Backfilling pre-existing rows is deliberately out of scope here (dispatcher's own
// instruction) -- this only reaches rows filed from here on.
//
// #771: NOTHING RECORDS WHO FILED A ROW, SO A BACKFILL LIST CANNOT BE ADDRESSED. GitHub's `author` is the
// one fleet account for every row, and a `session:` label means CLAIMED, not filed (the 2026-09-09
// ruling) -- so for 25 of 27 rows measured missing a required section, nothing named who filed it, and an
// instruction to "send each filer its incomplete rows" could not be carried out. The two that COULD be
// attributed were attributed by accident: two from a session's own memory of filing them, one because
// `orchestrator` happened to write "Filed by `orchestrator`" in prose. That last one is the whole
// argument -- the information is useful, somebody wrote it by hand once, and nothing asked for it.
//
// So this writes `Filed-by: <session>` into the body -- a body LINE, never a label. A label means
// CLAIMED (the same ruling), and a `filed-by:*` label would put two different meanings in one namespace,
// exactly the collision #683 records: `session:` was asked to be both a claim about the present and a
// record of the past, and removing it on close (#754) destroyed the second. A body line has the property
// the label lacked: it is a record, so nothing later ever needs to remove it.
//
// `--session=<name>`, REQUIRED, the identical flag `row-claim.ts` already uses for the same fact --
// never a separately-named flag (`--filed-by=`) a caller could set to anything unrelated to who is
// actually running this. One place a session states its identity, not two that could disagree.
//
// `.github/ISSUE_TEMPLATE/backlog-row.yml` marks Region, Acceptance and Open-check `required` -- but that
// is a GitHub issue FORM, and forms apply only in the web UI. Every row this fleet files goes through
// `gh issue create --body`, which bypasses the form entirely, and nobody discovered a row was incomplete
// until someone tried to claim it (#707). Measured 2026-09-09 (worker-capture, #735):
//
//   open rows examined: 76
//   missing at least one required section: 36
//     missing Region: 25 | Acceptance: 5 | Open-check: 28
//
//   #0-399    8 of 36 (22%)
//   #400-599  9 of 11 (82%)
//   #600-699  10 of 18 (56%)
//   #700+     9 of 11 (82%)   <- of the eleven newest, exactly two carried all three
//
// The rate rises with recency because the more the org files its own work with `gh issue create`, the
// more of the backlog becomes un-claimable -- the web form's enforcement never runs against that path.
//
// ceo's ruling: refuse at FILING, not only at claiming, so the cost lands on whoever holds the context,
// not on whoever picks the row up later. In worker-capture's own words, filing #677 without this:
//
//   "I wrote #677's Open-check myself and I am not confident it is the one `orchestrator` would have
//   written."
//
// NOT A SECOND IMPLEMENTATION. `missingTemplateFields` is #707's own pure function, imported from
// `row-claim/template-fields-rule.ts` unchanged -- the identical rule row-claim already enforces at
// claim time, asked here one step earlier. A body that would pass this refuses nothing later, and a body
// that would fail `row-claim claim` cannot be filed in the first place.
//
// `cli-flags.test.ts`'s discovery guard requires EVERY argv-reading file here to call
// `refuseUnknownFlags`, on a small, CLOSED, shrink-only exemption list this file does not qualify for --
// so `KNOWN_GH_ISSUE_CREATE_FLAGS` below is `gh issue create --help`'s own flag surface (read 2026-09-09,
// gh's current stable release), not a subset this wrapper invented. A flag it does not yet know is
// refused with the near miss named, same as any other guarded CLI here -- the cost of a genuinely new
// `gh` flag arriving is a refusal naming it, not a silent pass-through. Every argument that IS known still
// passes through to `gh` unexamined -- this file checks nothing about VALUES, only that the flag NAME is
// one `gh issue create` actually reads, which is `refuseUnknownFlags`'s whole job everywhere else in this
// tree, applied to a wrapped external tool instead of to this file's own flags.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { fetchLabels as fetchIssueLabels } from "./row-claim.ts";
import { launchGate } from "./board-snapshot-scope.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { loadLanes } from "./lane-ownership.ts";
import { DISTINCT_FROM_FLAG, duplicateRowCheck } from "./duplicate-row.ts";
import { homeHostConfig, stateEntryPath } from "./host-config.ts";
import { ALLOW_SAME_TITLE_FLAG, KIND_FLAG, KNOWN_GH_ISSUE_CREATE_FLAGS, READY_FLAG, ROADMAP_FLAG, TRACKER_FLAG, bodyFromArgv, defaultRun, titleFromArgv } from "./row-file/issue-body-and-region-checks.ts";
import { fetchIssueBoardStatus } from "./row-file/title-kind-and-label-refusals.ts";
import { BOARD_FLAG, PROMOTE_FLAG, boardArgvRefusal, boardExisting, chooseTracker, createIssue, ensureLabelsOn, moveTrackerStatus, promoteAndReviewRow } from "./row-file/roadmap-and-milestone-checks.ts";

/**
 * #3330: the CLI's board path. Exit 1 is REFUSED with nothing changed; exit 2 is something written and not
 * confirmed (`promoteRow`'s own two codes); exit 0 is boarded OR already boarded, which the line says.
 * @param {string[]} argv
 * @param {{ run?: typeof defaultRun, fetchBoardStatus?: typeof fetchIssueBoardStatus,
 *   fetchLabels?: typeof fetchIssueLabels, moveStatus?: typeof moveTrackerStatus,
 *   ensureLabels?: typeof ensureLabelsOn, loadLanesConfig?: typeof loadLanes }} [deps]
 * @returns {number} the process exit code
 */
export function boardRow(argv: string[], deps: {
    run?: typeof defaultRun; fetchBoardStatus?: typeof fetchIssueBoardStatus;
    fetchLabels?: typeof fetchIssueLabels; moveStatus?: typeof moveTrackerStatus;
    ensureLabels?: typeof ensureLabelsOn; loadLanesConfig?: typeof loadLanes;
} = {}): number {
  const merged = { run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus, fetchLabels: fetchIssueLabels,
    moveStatus: moveTrackerStatus, ensureLabels: ensureLabelsOn, loadLanesConfig: loadLanes, ...deps };
  const stray = boardArgvRefusal(argv);
  const result = stray ? { ok: false, code: 1, message: stray } : boardExisting(argv, merged);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return (result.code as number);
  }
  process.stdout.write(`${result.message}\n`);
  return 0;
}

/**
 * #4634: THE MEANING-LEVEL DUPLICATE CHECK, run before `createIssue` because it asks a provider over the network and `createIssue` is synchronous. It is a refusal only when the decision
 * provider said `same change` or `same defect` above its floor; a host with no provider, no key or the use off gets `null` and `createIssue`'s exact-title rule, as before.
 * @returns {Promise<number | null>} the exit code of a refusal, else null
 */
async function semanticDuplicateExit(argv: string[]): Promise<number | null> {
  const title = titleFromArgv(argv);
  const body = bodyFromArgv(argv);
  if (title === null || body === null) return null; // `createIssue` refuses a missing body itself
  const chosen = chooseTracker(argv, body, homeProjectDeclaration());
  if ("refusal" in chosen) return null; // and the tracker, with the words for it
  let host;
  try {
    host = homeHostConfig();
  } catch {
    return null; // a machine with no host declaration declares no provider, and the optional provider is simply absent
  }
  const projectDir = host.projects.find((project) => project.id === host.primary)?.checkout ?? process.cwd(); // `.agent-org/decisions.json` is the primary project's, not a worktree's
  const check = await duplicateRowCheck({ argv, title, body, repo: chosen.tracker.repo, host, projectDir, ledgerPath: stateEntryPath("wake-ledger") });
  for (const warning of check.warnings) process.stderr.write(`${warning}\n`);
  if (check.refusal === null) return null;
  process.stderr.write(`${check.refusal}\n`);
  return 1;
}

async function main() {
  refuseUnknownFlags([...KNOWN_GH_ISSUE_CREATE_FLAGS, "--session=", READY_FLAG, PROMOTE_FLAG, BOARD_FLAG, "--lane=", TRACKER_FLAG, ROADMAP_FLAG, KIND_FLAG, `${KIND_FLAG}=`, ALLOW_SAME_TITLE_FLAG, DISTINCT_FROM_FLAG],
    { entry: import.meta.url, command: "pnpm run row-file" });
  // #1352: from the primary checkout or a plain clone, refuse before filing anything -- exit 1, createIssue's own
  // "refused, nothing filed" code.
  if (launchGate("row-file")) {
    process.exitCode = 1;
    return;
  }
  // #2111: routed on the flag's PRESENCE, never on its value -- a `--promote=` naming something unusable
  // must reach `promoteRow`'s own refusal rather than fall through and try to FILE a row. `--board=` (#3330)
  // routes the same way, and first: it is the act that takes an existing number AND a lane.
  const argv = process.argv.slice(2);
  const present = (flag: string) => argv.some((a) => a.startsWith(flag));
  if (present(BOARD_FLAG)) process.exitCode = boardRow(argv);
  else if (present(PROMOTE_FLAG)) {
    process.exitCode = await promoteAndReviewRow(argv);
  }
  else process.exitCode = (await semanticDuplicateExit(argv)) ?? createIssue(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().catch((error) => {
    process.stderr.write(`row-file: failed before anything was filed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
