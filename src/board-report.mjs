#!/usr/bin/env node
// @ts-check
// command: generate the daily board report from GitHub and git, never from what an agent said
// The daily board report, GENERATED FROM GITHUB AND GIT — never from what an agent said.
//
// The rule this file exists to enforce, and the reason it is a script rather than a habit: a report
// assembled by hand from peer messages is a report of CLAIMS. This project's own record is a catalogue of
// correct values read from the wrong place — a journal window spanning two runs, a progress file
// describing a FINISHED run while a new one was a minute old, a commit message quoted while the artefact
// was on disk. Every one of those was true of something; none was true of the thing being reported.
//
// This is the DAILY edition, and it is the data trail. The weekly document the board actually reads is
// `board-document.mjs`, which shares this one's data layer rather than re-deriving it.
//
// NOTHING RUNS ON IMPORT: `node -e "import(...)"` is the only real check that an .mjs file still
// loads, and without the guard at the bottom that check would post a board edition as a side effect.
// realpathSync'd because npm's `.bin` symlink makes a non-realpath'd comparison never match.
//
// It writes to stdout by default. `--post` publishes it as a comment on the board-report issue, so the
// generating and the publishing are separate acts and a bad report can be seen before it is posted.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import {
  REPO, MILESTONE, HOURS_MS, READ_SET,
  gh, git, issues, milestone, mergeState, misAuthored, reported, daysUntil, readSetIsNotMain, countable,
  conflictMetrics, readyRows} from "./board-data.mjs";
import { editionDay } from "./board-discussion.mjs";

const argv = process.argv.slice(2);
/** @type {(name: string) => string | undefined} */
const flag = (name) => argv.find((a) => a.startsWith(`${name}=`))?.split("=").slice(1).join("=");

/** ONE FUNCTION PER SECTION, and not as a style preference.
 *
 * A comment-dense renderer runs to twice its code-line budget without that budget noticing:
 * `max-lines-per-function` sets `skipComments: true`, so it measures CODE lines while a board report is
 * mostly prose. This file's `render` reached 157 physical lines against a 90-line budget with `npm run lint`
 * green throughout, because the physical budget was then a test (`function-size.test.ts`). It is a lint rule
 * now, `local/max-physical-lines-per-function` (#908), and it is the budget that actually holds here.
 *
 * Each section takes the whole fact set and destructures only what it reads, so what a section depends on
 * is visible in its first line rather than inferred from its body.
 */
/** @param {any} d @param {string[]} L */
export function release(d, L) {
  const { ms } = d;
  L.push("## Release");
  if (!ms) {
    L.push(`No milestone titled \`${MILESTONE}\` exists. That is a tracker fault, not a schedule one.`);
  } else {
    const d = ms.due_on ? daysUntil(ms.due_on) : null;
    L.push(`**${ms.title}** — due ${ms.due_on ? ms.due_on.slice(0, 10) : "no date set"}`
      + `${d === null ? "" : ` (${d} day${d === 1 ? "" : "s"} out)`}, `
      + `**${ms.open_issues} open**, ${ms.closed_issues} closed.`);
    L.push("");
    L.push("Every move of that date is recorded on the milestone itself, naming what moved it and which "
      + "gate found it. If the date below has changed since the last report and the milestone carries no "
      + "reason, that is the defect — not the slip.");
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function blockerTable(d, L) {
  const { blockers } = d;
  L.push("## Blockers");
  if (blockers.length === 0) {
    L.push("None open on the milestone.");
  } else {
    L.push("| # | blocker | found by |");
    L.push("|---|---|---|");
    for (const b of blockers) {
      const by = b.labelNames.includes("gate-found") ? "a gate" : "inspection";
      L.push(`| [#${b.number}](${b.url}) | ${b.title.replace(/\|/g, "\\|")} | ${by} |`);
    }
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function issuesClosed(d, L) {
  const { merges, closed } = d;
  L.push("## Issues closed");
  if (closed.length === 0) {
    L.push(`None in this window. **That is a fact about the window, not about the work** — `
      + `${merges.length} merge${merges.length === 1 ? "" : "s"} landed in it.`);
  } else {
    for (const c of closed) L.push(`- [#${c.number}](${c.url}) ${c.title}`);
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function whatMerged(d, L) {
  const { merges, unpushed, since } = d;
  L.push("## What merged");
  L.push(`**${merges.length}** merge${merges.length === 1 ? "" : "s"} to \`main\` since \`${since}\`, read `
    + "from `git log main --merges`, not from GitHub. **The window is stated because two correct counts "
    + "over different windows read as a disagreement** — measured on this report's first edition, where a "
    + "peer's 17 (since 09:00) and this script's 42 (since midnight) were both right.");
  L.push("");
  // ALWAYS PRINTED, INCLUDING WHEN IT IS ZERO. A push state that appears only when it is interesting is
  // one the reader cannot tell from a check that did not run — the `unchecked is not clean` rule, on the
  // one number that decides whether anything read from GitHub's default branch is current.
  if (unpushed === null) {
    L.push("**`origin/main` could not be compared** — no such ref in this checkout. Reported as unknown "
      + "rather than as zero: \"nothing is waiting to push\" and \"we could not ask\" are different answers.");
  } else if (unpushed === 0) {
    // THIS LINE MEANS LESS THAN IT DID, AND SAYS SO. It was written when the report ran from a laptop,
    // where local commits could genuinely sit ahead of `origin/main`. From a GitHub runner the comparison
    // is 0 by construction -- the runner has only what was pushed -- so a clean reading here is not
    // evidence that nothing is unpushed. It is evidence that the runner cannot tell. The rule that
    // replaces it is that all work is pushed; the dispatcher's own branch count is what would contradict
    // it, and if a branch is ever found unpushed this report says so rather than staying silent.
    L.push("All work is on GitHub: `main` and `origin/main` are level "
      + `(\`${git(["rev-parse", "--short", "main"])}\`), checked. **This report cannot itself detect an `
      + "unpushed local branch** — it runs from GitHub, which has only what was pushed — so this line "
      + "records the rule rather than proving it. A branch found unpushed by the dispatcher's count "
      + "appears here as an exception.");
  } else {
    L.push(`**${unpushed} commit${unpushed === 1 ? "" : "s"} are on local \`main\` and not on `
      + `\`origin/main\`.** A flat \`origin/main\` on GitHub is therefore a HOLD, not a stall — anything `
      + "read from GitHub's default branch today is behind the work.");
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function authorship(d, L) {
  const { strays } = d;
  if (strays.length > 0) {
    L.push("## Commit authorship — a known defect, not a discovery");
    L.push(`${strays.length} commit${strays.length === 1 ? "" : "s"} in this window are authored by an `
      + `address that is not the repository owner's: ${[...new Set(strays.map((/** @type {any} */ s) => s.email))].join(", ")}.`);
    L.push("");
    L.push("Cause, measured: a test spawned git with `cwd: tmpdir` but no sanitised `env`, and under the "
      + "pre-push hook `GIT_DIR` beats `cwd`, so it wrote its identity into the real config. **cwd is not "
      + "isolation for a git subprocess.** Decision on record: history stays — no force-push while agents "
      + "hold branches off `main`. Tracked as an issue; the fix that matters is the discovery test over "
      + "every git-shelling test, not the config unset.");
    L.push("");
  }
}

/** @param {any} d @param {string[]} L */
export function lastGate(d, L) {
  const { latestGate, gateIsFresh } = d;
  // WHICH GATE, named (#429): `latestGate` is the newest CONFORMANCE result, not the newest entry of any kind.
  L.push("## Last conformance gate result (`rules-real-pages`)");
  if (!latestGate) {
    L.push("**Not reported.** No gate output has been recorded in `docs/board/reported/`. This report "
      + "does not read gates itself and must not: a checkout's `runs/` is only as fresh as its last sync "
      + "— one measured here was 89 hours old and answered cleanly having examined a corpus that no "
      + "longer existed.");
  } else {
    L.push(`\`${latestGate.command}\` — run by **${latestGate.reportedBy}** at ${latestGate.at}`
      + `${gateIsFresh ? "" : " — **STALE**, older than this report's freshness window, so it describes an "
        + "earlier state of the corpus and not necessarily the current one"}.`);
    L.push("");
    L.push("```");
    L.push(String(latestGate.output).trimEnd());
    L.push("```");
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function fleetHoursSection(d, L) {
  const { fleetHours } = d;
  L.push("## Fleet hours");
  if (!fleetHours || fleetHours.status === "not instrumented") {
    L.push("**not instrumented.** " + (fleetHours?.note ?? ""));
  } else if (!fleetHours.run || !fleetHours.runFinishedAt) {
    // A TOTAL WITH NO RUN BEHIND IT IS REFUSED, not printed with a caveat.
    //
    // "Fleet hours: 214" is a number whose whole meaning is which runs it summed, and this project's
    // record is precisely the failure of numbers that were correct about something other than the thing
    // being reported. So the report will not carry the figure at all until the entry names its source.
    // Refusing is cheaper than a footnote nobody reads, and it cannot be satisfied by remembering.
    // TWO REFUSALS, and the second is the harder case. A total with no `run` is a missing field, which
    // is visible. A total naming a run that has not FINISHED is a field that is filled and false — added
    // 2026-09-06 after a total named `a11y-job-capture.service` while it sat at 285 of 1,645, so the
    // number could not have come from the run it cited whatever else was true of it.
    const missing = !fleetHours.run ? "does not name the run it was computed from"
      : "names a run with no `runFinishedAt`, so that run had not finished and the total cannot have come "
        + "from it";
    L.push(`**REFUSED — a fleet-hours total was recorded that ${missing}.** The entry reads `
      + `\`${fleetHours.total}\`, measured by ${fleetHours.reportedBy ?? "nobody named"}`
      + `${fleetHours.run ? `, citing \`${fleetHours.run}\`` : ""}. A total whose run is unstated or `
      + "unfinished cannot be checked, re-derived, or compared with the next edition, so it is not "
      + "printed. See `docs/board/reported/` for the shape.");
  } else {
    L.push(`**${fleetHours.total}**, computed from **${fleetHours.run}**, which finished `
      + `${fleetHours.runFinishedAt} — measured by ${fleetHours.reportedBy} at ${fleetHours.at}.`);
    L.push("");
    L.push(`Method: ${fleetHours.method}`);
    L.push("");
    L.push("**This is capture OCCUPANCY**, not the fleet's cost. It excludes idle time between "
      + "dispatches, provisioning, reboots and power. A reader comparing it with an electricity bill is "
      + "comparing two different quantities.");
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function conflictMetricsSection(d, L) {
  const { conflict, since } = d;
  L.push("## Conflict metrics");
  L.push(`Since \`${since}\`. Method: ${conflict.method}`);
  L.push("");
  L.push(`**${conflict.opened}** opened · **${conflict.merged}** merged · `
    + `**${conflict.closedUnmerged}** closed unmerged.`);
  L.push("");
  const { count, medianMinutes, p90Minutes } = conflict.lifetimeMinutes;
  if (count === 0) {
    L.push("**Lifetime to merge: not measured** — no PR merged in this window.");
  } else {
    L.push(`**Lifetime to merge** (${count} merged PR${count === 1 ? "" : "s"}): median `
      + `${medianMinutes.toFixed(0)} min, p90 ${p90Minutes.toFixed(0)} min.`);
  }
  L.push("");
  const { neededReconciliation, of, unresolvable } = conflict.reconciliation;
  if (of === 0) {
    L.push("**Conflicts: not measured** — no PR merged in this window.");
  } else {
    L.push(`**${neededReconciliation} of ${of}** merged PRs needed to reconcile with a diverged `
      + `\`main\` (the closest signal git retains after the fact — see method above; this is not the `
      + "same claim as \"hit a textual conflict\").");
    // REFUSED RATHER THAN FOLDED IN: an uninspectable PR (no merge commit to read, a lookup failure) is
    // never silently counted as "no conflict" -- "no conflicts found" and "could not look" must not
    // print the same line.
    if (unresolvable > 0) {
      L.push(`**${unresolvable}** of those merges could not be inspected (no readable merge commit) and `
        + "are excluded from both sides of that count, not folded into the zero.");
    }
  }
  L.push("");
  if (conflict.hotspotFiles.length === 0) {
    L.push("No file was touched by more than one PR in this window.");
  } else {
    L.push("Most-touched files (by distinct PR, not by commit):");
    L.push("");
    L.push("| file | PRs |");
    L.push("|---|---|");
    for (const h of conflict.hotspotFiles) L.push(`| \`${h.path}\` | ${h.prCount} |`);
  }
  L.push("");
}

/** @param {any} d @param {string[]} L */
export function queue(d, L) {
  const { open, ready, awaiting } = d;
  L.push("## Queue");
  L.push(`**Ready ${ready.length}** · **Awaiting merge ${awaiting.length}** · **Open ${open.length}**`);
  if (ready.length === 0) {
    L.push("");
    L.push("An empty Ready column is a legitimate end state, not a broken filter — the other columns "
      + `still hold ${open.length - ready.length} row(s), which is what tells the two apart.`);
  }
}

/**
 * Everything the sections read, gathered once.
 * @param {string} since
 * @param {string} sinceLabel
 */
function facts(since, sinceLabel) {
  const all = issues();
  const ms = milestone();
  const { merges, unpushed } = mergeState(since);
  const strays = misAuthored(since);
  const { latestGate, gateIsFresh, fleetHours } = reported();
  const conflict = conflictMetrics(since);

  const closed = all.filter((/** @type {any} */ i) => i.state === "CLOSED" && i.closedAt && Date.parse(i.closedAt) >= Date.parse(since));
  // Meta rows are containers, not work -- see `countable` in board-data.mjs, and section 6 prints the rule.
  const open = countable(all.filter((/** @type {any} */ i) => i.state === "OPEN"));
  const blockers = open.filter((/** @type {any} */ i) => i.milestone?.title === MILESTONE);
  const ready = readyRows(open);
  const awaiting = open.filter((/** @type {any} */ i) => i.labelNames.includes("awaiting-merge"));

  return { since, sinceLabel, all, ms, merges, unpushed, strays, latestGate, gateIsFresh,
    fleetHours, closed, open, blockers, ready, awaiting, conflict };
}

/** @param {any} d @param {Date} [now] the render instant: the title's day is London's, from editionDay (#1442) */
export function render(d, now = new Date()) {
  const { sinceLabel } = d;
  const L = [];
  L.push(`# Board report — ${editionDay(now)}`);
  L.push("");
  L.push(`Generated from GitHub and git by \`npm run board:report\`. Nothing here is taken from what an `
    + `agent said: issues and the milestone are read from the API, merges from \`git log main\`, and the `
    + `two figures neither can supply are quoted from \`docs/board/reported/\` with their measurer `
    + `named — or declared unreported. Window: ${sinceLabel}.`);
  L.push("");
  release(d, L);
  blockerTable(d, L);
  issuesClosed(d, L);
  whatMerged(d, L);
  authorship(d, L);
  lastGate(d, L);
  fleetHoursSection(d, L);
  conflictMetricsSection(d, L);
  queue(d, L);
  return L.join("\n");
}

function main() {
  refuseUnknownFlags(["--post", "--issue", "--since", "--allow-dirty-read-set"],
    { entry: import.meta.url, command: "npm run board:report" });
  const post = argv.includes("--post");

  const since = flag("--since") ?? new Date(Date.now() - 24 * HOURS_MS).toISOString();
  const body = render(facts(since, `commits and closures since ${since}`));

  if (!post) {
    process.stdout.write(body + "\n");
  } else {
    const dirt = argv.includes("--allow-dirty-read-set") ? null : readSetIsNotMain();
    if (dirt) {
      console.error("REFUSING to post: the files this report reads out of the working tree are not "
        + "`main`'s, so the edition would quote something nobody has reviewed.\n\n" + dirt
        + "\n\nThe report was NOT posted and no partial edition was published. Commit and merge the read "
        + "set, or pass --allow-dirty-read-set, which posts and says so in the edition itself.\n"
        + "Read set: " + READ_SET.join(", "));
      process.exit(3);
    }
    const issue = flag("--issue");
    if (!issue) {
      console.error("--post needs --issue=<number>, the board-report issue to comment on. Refusing rather "
        + "than opening a new issue per report: a report per issue is how a board stops being read.");
      process.exit(2);
    }
    const published = argv.includes("--allow-dirty-read-set") && readSetIsNotMain()
      ? body + "\n\n---\n\n**Posted with `--allow-dirty-read-set`.** The files this edition reads out of "
        + "the working tree are not `main`'s, so the gate line and the fleet-hours line above may quote "
        + "something unreviewed. Stated here rather than left for a reader to discover."
      : body;
    gh(["issue", "comment", issue, "--repo", REPO, "--body", published]);
    process.stdout.write(`posted to https://github.com/${REPO}/issues/${issue}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();