#!/bin/bash
# #1234: dispatches the daily board edition from this host (`agents`), because GitHub's own
# `schedule` trigger has never once fired inside its stated window (always lands 5-9 hours late,
# in the 12:00-13:56Z band, never 07/08Z). GitHub's schedule stays on as a backstop; this is the
# real dispatch. See issue #1234 for the full derivation.
set -euo pipefail

# #2620 (child 3f of #69): THE REPOSITORY AND THE WORKFLOW ARE THE PROJECT'S, not this tool's, so they are read from the
# project's declaration. The unit's WorkingDirectory is the project's checkout, so the declaration is the file beside it.
# A missing file or field FAILS the dispatch (`set -e` sees the `node` exit), which is the point: a default here would
# dispatch the WRONG project's board silently, the failure `project-config.mjs` refuses to have anywhere else.
DECLARATION="${AGENT_ORG_PROJECT:-.agent-org/project.json}"
declared() {
  node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2] === "repo" ? d.tracker?.[0]?.repo : d.units?.boardReportWorkflow;
    if (typeof value !== "string" || value === "") {
      console.error(`board-report-dispatch: ${process.argv[1]} does not declare ${process.argv[2]}`);
      process.exit(1);
    }
    console.log(value);
  ' "${DECLARATION}" "$1"
}
REPO="$(declared repo)"
WORKFLOW="$(declared workflow)"

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
