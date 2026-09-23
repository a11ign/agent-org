#!/bin/bash
# #1234: dispatches the daily board edition from this host (`agents`), because GitHub's own
# `schedule` trigger has never once fired inside its stated window (always lands 5-9 hours late,
# in the 12:00-13:56Z band, never 07/08Z). GitHub's schedule stays on as a backstop; this is the
# real dispatch. See issue #1234 for the full derivation.
set -euo pipefail

REPO="a11ign/a11ign"
WORKFLOW="board-report.yml"

echo "board-report-dispatch: dispatching ${WORKFLOW} on ${REPO} at $(date -u +%FT%TZ)"
gh workflow run "${WORKFLOW}" --repo "${REPO}"

# `gh workflow run` does not print the run id it created. Poll briefly for the newest run of this
# workflow with event=workflow_dispatch, so the systemd journal carries the run id rather than
# only "dispatched, believed to have worked".
RUN_ID=""
for _ in $(seq 1 10); do
  sleep 2
  RUN_ID="$(gh run list --repo "${REPO}" --workflow "${WORKFLOW}" --event workflow_dispatch \
    --limit 1 --json databaseId,createdAt --jq '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "${RUN_ID}" ]; then
    break
  fi
done

if [ -n "${RUN_ID}" ]; then
  echo "board-report-dispatch: started run ${RUN_ID} -- https://github.com/${REPO}/actions/runs/${RUN_ID}"
else
  echo "board-report-dispatch: WARNING -- dispatched but could not read back a run id within 20s" >&2
fi
