The board, the org-health and retro readings, the DORA reader, the trace, the chairman's watch and answers and the tmp prune no longer call GitHub from core, which is the eighth of A11-160's steps: 24 files of the baseline (`src/board-*.ts`, `src/dora.ts`, `src/org-health/sweep-readings.ts`, `src/org-retro/`, `src/trace/`, `src/messaging/` and `src/prune-tmp.ts`) ask the code host's `rows` (contract 1.11, `docs/adr/0011-...`) for what they need, by name, implemented in `plugins/github/rows/`. A caller that runs `gh` itself asks the code host for a runner with its policy (`runnerWith`, `asyncRunnerWith`: a directory, a bound, a buffer, a hook's git variables taken off, a `guard` that is core's rule, such as the leak guard or the chairman's read-only allowlist), so the process is the plugin's and the policy stays the caller's. `docs/gh-call-baseline.json` only goes down: the 24 files left it. Core's tests of these callers run on the fake code host's world (`reports.board`, `health`, `dora`, `trace`, `messaging`, `snapshot`). The three timers that still ran row-era code (`a11ign-trace-ingest`, `a11ign-trace-publish`, `a11ign-tmp-prune`) run these files directly with `node`: the block below runs each entry once over a stub `gh` and a scratch home.

Acceptance:
```bash
scratch=$(mktemp -d)
mkdir "$scratch/bin" "$scratch/nogh" "$scratch/home" "$scratch/tmp"
printf '%s\n' '#!/bin/sh' 'echo "gh is not available in this run" >&2' 'exit 1' > "$scratch/nogh/gh"
chmod +x "$scratch/nogh/gh"
cat > "$scratch/bin/gh" <<'SH'
#!/bin/sh
echo "$*" >> "$STUB_CALLS"
case "$*" in *"--body-file -"*) cat >> "$STUB_STDIN"; echo >> "$STUB_STDIN";; esac
head='HTTP/2.0 200 OK\r\nEtag: "e1"\r\nX-Ratelimit-Resource: core\r\nX-Ratelimit-Remaining: 4000\r\n\r\n'
case "$*" in
  "api -i repos/"*"/branches/main") printf "$head"'{"commit":{"sha":"abc123"}}\n';;
  "api -i "*) printf "$head"'[]\n';;
  *) echo '[]';;
esac
SH
chmod +x "$scratch/bin/gh"
mkdir "$scratch/project"
cp -r src/packaging/fixtures/project-tree/. "$scratch/project"
sed -i "s|@@PROJECT@@|$scratch/project|" "$scratch/project/.agent-org/host.json"
git -C "$scratch/project" init -q
git -C "$scratch/project" add -A
git -C "$scratch/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
export AGENT_ORG_HOST="$scratch/project/.agent-org/host.json"
PATH="$scratch/nogh:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins plugins/github/conformance.test.ts plugins/github/index.test.ts plugins/github/rows/board-rows.test.ts plugins/github/rows/board-snapshot-rows.test.ts plugins/github/rows/dora-rows.test.ts plugins/github/rows/health-rows.test.ts plugins/github/rows/index.test.ts plugins/github/rows/messaging-rows.test.ts plugins/github/rows/runners.test.ts plugins/github/rows/trace-rows.test.ts src/board-report-tool-version.test.ts src/board-report-trackers.test.ts src/board-truth-audit-roadmap.test.ts src/dora-budget-spent-is-not-a-timeout.test.ts src/inert-option-incident.test.ts src/install/doctor.test.ts src/install/onboard-demo.test.ts src/merged-row-open-incident.test.ts src/messaging/default-runners.test.ts src/messaging/github-writer.test.ts src/messaging/placeholders.test.ts src/messaging/reply-cli.test.ts src/messaging/reply.test.ts src/messaging/sources/readers.test.ts src/messaging/sources/requests.test.ts src/org-health-release-failed.test.ts src/org-retro-dora-resumes.test.ts src/org-retro-merged-repositories.test.ts src/packaging/acceptance-commands.test.ts src/packaging/board-appendix-gate-record.test.ts src/packaging/board-data-issues-paging.test.ts src/packaging/board-discussion.test.ts src/packaging/board-liveness.test.ts src/packaging/board-outside.test.ts src/packaging/board-prose-skips-closed-rows.test.ts src/packaging/board-report-smoke.test.ts src/packaging/board-snapshot-scope.test.ts src/packaging/board-snapshot.test.ts src/packaging/board-status-health.test.ts src/packaging/board-summary-check.test.ts src/packaging/git-spawn-classification.test.ts src/packaging/haiku-tier.test.ts src/packaging/handoff-in-prose-is-flagged.test.ts src/packaging/no-search-reads.test.ts src/packaging/org-health-access.test.ts src/packaging/org-retro-kept-as-read.test.ts src/packaging/org-retro-read-cost.test.ts src/packaging/org-retro.test.ts src/packaging/prose-flag-sends-an-order.test.ts src/packaging/prune-tmp.test.ts src/packaging/tracker-writer-spawn-guard.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts src/plugins/fakes/code-host-board.test.ts src/plugins/fakes/code-host-health.test.ts src/plugins/fakes/code-host-rows.test.ts src/plugins/fakes/code-host.test.ts src/plugins/fakes/code-host-trace.test.ts src/release-failure-alarm.test.ts src/ticket-mode/server.test.ts src/trace/freshness.test.ts src/trace/headless-pilot.test.ts src/work-gate/org-health-reads.test.ts src/work-gate/org-health.test.ts
node --input-type=module -e 'import { execFileSync } from "node:child_process"; import { readFileSync } from "node:fs"; const before = JSON.parse(execFileSync("git", ["show", "origin/main:docs/gh-call-baseline.json"], { encoding: "utf8" })).files; const after = JSON.parse(readFileSync("docs/gh-call-baseline.json", "utf8")).files; const rose = Object.entries(after).filter(([file, entry]) => !(file in before) || entry.spawns > before[file].spawns || entry.calls > before[file].calls).map(([file]) => file); const moved = ["src/board-data.ts", "src/board-discussion.ts", "src/board-document.ts", "src/board-report.ts", "src/board-schedule-liveness.ts", "src/board-snapshot-scope.ts", "src/board-snapshot.ts", "src/board-summary-check.ts", "src/board-truth-audit.ts", "src/dora.ts", "src/messaging/github-writer.ts", "src/messaging/placeholders.ts", "src/messaging/reply-cli.ts", "src/messaging/watch-list.ts", "src/messaging/watch.ts", "src/org-health/sweep-readings.ts", "src/org-retro/journal-stats-and-verdicts.ts", "src/org-retro/retro-window-and-journal-patterns.ts", "src/prune-tmp.ts", "src/trace/freshness.ts", "src/trace/haiku-tier-report.ts", "src/trace/headless-pilot.ts", "src/trace/publish.ts", "src/trace/trace.ts"]; const left = Object.keys(after).filter((file) => moved.includes(file)); if (rose.length > 0 || left.length > 0) { console.error("the baseline rose for", rose, "or step 8 files are still in it:", left); process.exit(1); }'
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github" } } } }' > "$scratch/host.json"
PATH="$scratch/bin:$PATH" STUB_CALLS="$scratch/calls" AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.11  *plugins/github$'
PATH="$scratch/bin:$PATH" STUB_CALLS="$scratch/calls" AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts doctor 2>&1 | grep -qF 'code host: github (enabled, contract 1.11, plugins/github)'
mkdir -p "$scratch/home/.claude/projects" "$scratch/home/.codex/sessions" "$scratch/home/.cache/a11ign"
: > "$scratch/home/.cache/a11ign/wake-ledger"
export STUB_CALLS="$scratch/calls" STUB_STDIN="$scratch/stdin"
rm -f "$scratch/calls"
HOME="$scratch/home" PATH="$scratch/bin:$PATH" node src/trace/freshness.ts --store "$scratch/store.ndjson" | grep -q 'not stale'
test ! -e "$scratch/calls"
HOME="$scratch/home" PATH="$scratch/bin:$PATH" node --input-type=module -e 'const { hostEffects } = await import("./src/trace/freshness.ts"); await hostEffects(() => undefined).comment("the store has stopped");'
grep -qxF 'issue comment 928 --repo a11ign/a11ign --body-file -' "$scratch/calls"
grep -qxF 'the store has stopped' "$scratch/stdin"
rm -f "$scratch/calls"
HOME="$scratch/home" PATH="$scratch/bin:$PATH" node src/trace/publish.ts --out "$scratch/out" | grep -q 'published map.html'
grep -q '^api -i repos/a11ign/a11ign/branches/main$' "$scratch/calls"
grep -q '^api -i -X GET repos/a11ign/a11ign/pulls ' "$scratch/calls"
rm -f "$scratch/calls"
mkdir -p "$scratch/tmp/rv-2049" "$scratch/tmp/agreement-old"
touch -d '3 days ago' "$scratch/tmp/rv-2049" "$scratch/tmp/agreement-old"
HOME="$scratch/home" PATH="$scratch/bin:$PATH" node src/prune-tmp.ts "--tmp=$scratch/tmp" | grep -q 'pull request #2049 is closed'
grep -qxF 'pr list --state open --limit 300 --json number' "$scratch/calls"
HOME="$scratch/home" PATH="$scratch/bin:$PATH" node src/prune-tmp.ts --apply --fixtures-only "--tmp=$scratch/tmp" | grep -q 'removed 1 of 1'
test ! -e "$scratch/tmp/agreement-old"
rm -rf "${scratch:?}"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape, and no other repository reads these modules as a library except `board-data` and `board-document` (exported in `package.json`), whose exported functions and their `run` seams keep their names and shapes. The commands these modules print, their flags and their exit codes are unchanged; the three timers' units are not edited.
