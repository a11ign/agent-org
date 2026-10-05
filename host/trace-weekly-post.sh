#!/bin/bash
# a11ign/a11ign#3627: runs `agent-org trace -- --aggregate` and posts the weekly token-efficiency report (#3513) on the project's
# record issue, every Monday, from a timer. A session reading a clock to remember it is what the gate exists to remove.
#
# THE EXIT STATUS IS THE REPORT'S HEALTH. A report that cannot be run, a footer this script cannot read, a pool it cannot read and a
# comment GitHub refuses each leave this script with a non-zero status, so the unit shows FAILED. Nothing here turns a failure into a
# green unit with nothing posted, which is how a missing report would otherwise look like a quiet week.
set -euo pipefail

# THE REPOSITORY AND THE ISSUE ARE THE PROJECT'S, not this tool's, so both are read from its declaration, as board-report-dispatch.sh reads its
# repository. A missing file or field FAILS (`set -e` sees the `node` exit): a default here would post one project's figures on another's record.
DECLARATION="${AGENT_ORG_PROJECT:-.agent-org/project.json}"
declared() {
  node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2] === "repo" ? d.tracker?.[0]?.repo : d.units?.traceWeeklyIssue;
    const ok = process.argv[2] === "repo" ? typeof value === "string" && value !== "" : Number.isInteger(value) && value > 0;
    if (!ok) {
      console.error(`trace-weekly-post: ${process.argv[1]} does not declare ${process.argv[2] === "repo" ? "tracker[0].repo" : "units.traceWeeklyIssue (the record issue, a positive integer)"}`);
      process.exit(1);
    }
    console.log(value);
  ' "${DECLARATION}" "$1"
}
REPO="$(declared repo)"
ISSUE="$(declared issue)"

# A pass reads at most CALLS_PER_PASS `gh api` calls, oldest merge first, so the unread rows are read by LATER passes: one pass a Monday leaves a
# backlog unread for ever (the first reading took three of 1,500). The loop stops at zero unread, at MAX_PASSES, when a pass reads no more than the
# one before, or when the pool is down, and the post says PARTIAL when the reported week is not whole. The pool is the whole org's: POOL_RESERVE
# is left for the work tick, which spends the same account's core pool.
CALLS_PER_PASS="${TRACE_WEEKLY_CALLS:-1500}"
MAX_PASSES="${TRACE_WEEKLY_MAX_PASSES:-6}"
POOL_RESERVE="${TRACE_WEEKLY_POOL_RESERVE:-1000}"
# `trace` REFUSES a budget too small to list the merged pull requests ("--calls 0 is too small": no week can be placed without that list), so a pass
# is not started below this. MEASURED 2026-10-05: listing four weeks spent 35 calls before it failed on the search cap; the floor is a round number
# above that, not a measured minimum.
MIN_PASS_CALLS="${TRACE_WEEKLY_MIN_CALLS:-100}"
# THE WINDOW IS NARROWED, NOT LEFT TO TRACE'S DEFAULT (four weeks back). MEASURED 2026-10-05: that default holds more than 1,000 merged pull requests
# on a11ign/a11ign, GitHub's search returns no more than that, and `trace` refuses a list cut short, so the default FAILS outright. Two weeks
# before the current one holds the week reported and the one before it, which is what the week over week needs.
SINCE_DAYS_BACK=14
# A comment is limited to 65,536 characters. The report is split into parts of at most this many BYTES (>= characters), leaving room for the
# header and fence around each; it is split, never truncated.
PART_BYTES=60000

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
REPORT="${WORK}/report.txt"

fail() { echo "trace-weekly-post: $*" >&2; exit 1; }

# The core pool's remaining calls, read off a real call's headers: `gh api rate_limit` is a broken gauge (a11ign/a11ign#1967). The headers come
# back on the 403 too, so an exhausted pool reads 0 here and is not an error; no header at all, or another pool answering, is.
core_remaining() {
  local headers resource remaining
  headers="$(gh api "repos/${REPO}" -i 2>/dev/null | tr -d '\r' || true)"
  resource="$(printf '%s\n' "${headers}" | awk -F': ' 'tolower($1) == "x-ratelimit-resource" { print $2 }')"
  remaining="$(printf '%s\n' "${headers}" | awk -F': ' 'tolower($1) == "x-ratelimit-remaining" { print $2 }')"
  if [ "${resource}" != "core" ] || ! [[ "${remaining}" =~ ^[0-9]+$ ]]; then
    fail "cannot read the core pool of $(gh api user --jq .login 2>/dev/null || echo 'this account') (resource '${resource}', remaining '${remaining}')"
  fi
  echo "${remaining}"
}

# What the footer says is still unread; absent means the report's footer changed, which fails rather than guesses.
unread_in_report() {
  sed -n 's/.*rows whose GitHub events are not yet read: \([0-9][0-9]*\).*/\1/p' "${REPORT}" | tail -n 1
}

# The Monday (UTC) `SINCE_DAYS_BACK` before this week's: `%u` is 1 on a Monday, so a Monday steps back exactly that many days.
window_start() { date -u -d "-$(($(date -u +%u) - 1 + SINCE_DAYS_BACK)) days" +%F; }

run_pass() {
  local budget="$1" since
  since="$(window_start)"
  echo "trace-weekly-post: pass $((passes + 1)): --since ${since} --calls ${budget} at $(date -u +%FT%TZ)"
  if ! agent-org trace -- --aggregate --since "${since}" --calls "${budget}" > "${REPORT}" 2> "${WORK}/trace.err"; then
    cat "${WORK}/trace.err" >&2
    fail "agent-org trace -- --aggregate exited non-zero"
  fi
}

passes=0
previous=""
unread=""
stopped=""
while :; do
  remaining="$(core_remaining)"
  budget=$((remaining - POOL_RESERVE))
  [ "${budget}" -gt "${CALLS_PER_PASS}" ] && budget="${CALLS_PER_PASS}"
  [ "${budget}" -lt 0 ] && budget=0
  if [ "${budget}" -lt "${MIN_PASS_CALLS}" ]; then
    # After a pass, the report in hand is the best there is and says PARTIAL; before one, there is no report, and that is a failure to say so.
    [ "${passes}" -gt 0 ] || fail "the core pool is down to ${remaining} (reserve ${POOL_RESERVE}): too few calls to list the merged rows, nothing to post"
    stopped="the core pool is down to ${remaining}"
    break
  fi
  run_pass "${budget}"
  passes=$((passes + 1))
  unread="$(unread_in_report)"
  [ -n "${unread}" ] || fail "the report has no 'rows whose GitHub events are not yet read' count: its footer changed"
  [ "${unread}" -eq 0 ] && break
  if [ -n "${previous}" ] && [ "${unread}" -ge "${previous}" ]; then
    stopped="a pass read no more rows"
    break
  fi
  if [ "${passes}" -ge "${MAX_PASSES}" ]; then
    stopped="reached ${MAX_PASSES} passes"
    break
  fi
  previous="${unread}"
done
[ -s "${REPORT}" ] || fail "the report is empty"

# THE WEEK REPORTED is the one before the current: the report ends with the week in progress, which a Monday morning has barely begun. Its own
# line says whether it is whole, and a partial week is already marked in the report and never compared.
WEEK_PATTERN='^WEEK [0-9]{4}-[0-9]{2}-[0-9]{2} \.\. [0-9]{4}-[0-9]{2}-[0-9]{2} '
[ "$(grep -cE "${WEEK_PATTERN}" "${REPORT}")" -ge 2 ] || fail "the report has fewer than two WEEK lines: it names no finished week"
WEEK_LINE="$(grep -E "${WEEK_PATTERN}" "${REPORT}" | tail -n 2 | head -n 1)"
WEEK="$(echo "${WEEK_LINE}" | sed -E 's/^WEEK ([0-9-]+ \.\. [0-9-]+) .*/\1/')"
if [[ "${WEEK_LINE}" == *PARTIAL* ]]; then
  STATUS="PARTIAL (${WEEK_LINE#*PARTIAL, not compared: })"
else
  STATUS="COMPLETE"
fi
HEADER="**${STATUS}** weekly token-efficiency report, week ${WEEK} (UTC): ${passes} pass(es), GitHub events unread for ${unread} rows${stopped:+, stopped because ${stopped}}; posted $(date -u +%FT%TZ)"

split -C "${PART_BYTES}" -d -a 3 "${REPORT}" "${WORK}/part-"
PARTS=("${WORK}"/part-*)
for index in "${!PARTS[@]}"; do
  number=$((index + 1))
  if [ "${number}" -eq 1 ]; then
    heading="${HEADER}"
    [ "${#PARTS[@]}" -gt 1 ] && heading="${heading} (part 1 of ${#PARTS[@]})"
  else
    heading="**${STATUS%% *}** weekly token-efficiency report, week ${WEEK}, part ${number} of ${#PARTS[@]}"
  fi
  { echo "${heading}"; echo; echo '````'; cat "${PARTS[index]}"; echo '````'; } > "${WORK}/comment.md"
  gh issue comment "${ISSUE}" --repo "${REPO}" --body-file "${WORK}/comment.md" || fail "posting part ${number} of ${#PARTS[@]} on ${REPO}#${ISSUE} failed"
done
echo "trace-weekly-post: posted ${#PARTS[@]} comment(s) on ${REPO}#${ISSUE}: ${STATUS%% *}, week ${WEEK}"
