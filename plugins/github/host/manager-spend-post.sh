#!/bin/bash
# a11ign/a11ign#4505 (manager redesign, Move 2/3), agent-org#912: runs `agent-org trace -- manager-spend` for YESTERDAY (UTC) and posts the
# rendered table on the project's record issue, every morning, from a timer. The reading has to be on the record issue every day, not run by hand.
#
# THE EXIT STATUS IS THE READING'S HEALTH, as trace-weekly-post.sh's is: a reading that cannot be run, a store that is absent, empty or stale, and a
# comment GitHub refuses each leave this script non-zero, so the unit shows FAILED. Nothing here turns a missing reading into a green unit with nothing posted.
set -euo pipefail

# THE REPOSITORY AND THE ISSUE ARE THE PROJECT'S, read from its declaration as trace-weekly-post.sh reads them. A missing or malformed field FAILS.
DECLARATION="${AGENT_ORG_PROJECT:-.agent-org/project.json}"
declared() {
  node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2] === "repo" ? d.tracker?.[0]?.repo : d.units?.traceWeeklyIssue;
    const ok = process.argv[2] === "repo" ? typeof value === "string" && value !== "" : Number.isInteger(value) && value > 0;
    if (!ok) {
      console.error(`manager-spend-post: ${process.argv[1]} does not declare ${process.argv[2] === "repo" ? "tracker[0].repo" : "units.traceWeeklyIssue (the record issue, a positive integer)"}`);
      process.exit(1);
    }
    console.log(value);
  ' "${DECLARATION}" "$1"
}
REPO="$(declared repo)"
ISSUE="$(declared issue)"

fail() { echo "manager-spend-post: $*" >&2; exit 1; }

# THE DAY IS YESTERDAY IN UTC, the day `trace manager-spend --day` reads as [00:00, 24:00) UTC. A run at 07:45 London has a whole day behind it.
DAY="$(date -u -d yesterday +%F)"
DAY_END_MS="$(( $(date -u -d "${DAY} +1 day" +%s) * 1000 ))"
# THE STORE is the trace's own, at the path `defaultStore()` names. It is passed to `trace` explicitly, so this script and the reading read one file.
STORE="${HOME}/.cache/a11ign/trace/events.ndjson"

# ONCE A DAY. A marker per reported day is written only AFTER the post succeeds: a run that failed is retried, and a second run posts nothing.
POSTED_DIR="${HOME}/.cache/a11ign/manager-spend-post"
MARK="${POSTED_DIR}/${DAY}"
if [ -e "${MARK}" ]; then
  echo "manager-spend-post: the reading of ${DAY} is already posted on ${REPO}#${ISSUE}: posting nothing"
  exit 0
fi

# THE STORE MUST HAVE BEEN FED THROUGH THE DAY before its reading is posted. An absent or empty store is no reading at all. A store whose newest event
# is before the day ends is STALE, and its count of the day's wakes would be short with nothing saying so. A quiet day with events after it is fine: its
# reading says "0 manager wakes". The count is read here, line by line, and not by `trace`, so the check does not depend on the reading's own output.
FRESH="$(node -e '
  const { existsSync, createReadStream } = require("node:fs");
  const { createInterface } = require("node:readline");
  const file = process.argv[1];
  let events = 0;
  let newest = 0;
  const done = () => console.log(`${events} ${newest}`);
  if (existsSync(file)) {
    createInterface({ input: createReadStream(file) })
      .on("line", (line) => { if (line.length === 0) return; events += 1; newest = Math.max(newest, JSON.parse(line).at); })
      .on("close", done);
  } else done();
' "${STORE}")" || fail "the trace store at ${STORE} cannot be read"
read -r EVENTS NEWEST <<< "${FRESH}"
[ "${EVENTS}" -gt 0 ] || fail "the trace store at ${STORE} is absent or holds no events: an empty store is no reading of ${DAY}, nothing posted"
[ "${NEWEST}" -ge "${DAY_END_MS}" ] || fail "the trace store at ${STORE} is stale: its newest event is at $(date -u -d "@$((NEWEST / 1000))" +%FT%TZ), before ${DAY} ends, so its reading would be short; nothing posted"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT

if ! agent-org trace -- manager-spend --day "${DAY}" --store "${STORE}" > "${WORK}/reading.md" 2> "${WORK}/trace.err"; then
  cat "${WORK}/trace.err" >&2
  fail "agent-org trace -- manager-spend exited non-zero"
fi
[ -s "${WORK}/reading.md" ] || fail "the reading of ${DAY} is empty"

# THE POST IS THE WEEKLY SCRIPT'S (`gh issue comment` on the declared repository and issue). The reading is markdown already, its own heading names the day.
gh issue comment "${ISSUE}" --repo "${REPO}" --body-file "${WORK}/reading.md" || fail "posting the reading of ${DAY} on ${REPO}#${ISSUE} failed; no marker is written, so the next run retries it"
mkdir -p "${POSTED_DIR}"
: > "${MARK}"
echo "manager-spend-post: posted the reading of ${DAY} on ${REPO}#${ISSUE}"
