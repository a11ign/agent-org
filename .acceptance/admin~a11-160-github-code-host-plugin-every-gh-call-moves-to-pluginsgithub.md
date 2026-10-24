No file outside `plugins/github` calls `gh` any more, which is the ninth and last step of A11-160: the 50 files that remained in `docs/gh-call-baseline.json` (the label audit, the closing of rows for a merged pull request, the CI failure class and the ledgers, the queue and trunk readings, the read-only reporters, `pr-open` and `pr-hold`, the branch tools, the tool-version agreement, the ledger's retry, the survey, `scripts/review-eval.ts` and three shell scripts of `host/`) ask the code host's `rows` (contract 1.12, `docs/adr/0012-...`) for what they need, by name, in seven new sections implemented in `plugins/github/rows/`. The baseline's `files` is empty, and `src/packaging/gh-call-ratchet.test.ts` refuses any file outside the plugin that spawns `gh` or holds a `gh` call shape, by name. The three shell scripts that ran `gh` moved, byte for byte, to `plugins/github/host/` (their units name the new path: run `host:install`). Core's tests of the moved callers seed the fake code host's world (`tail.<section>`). The block below runs the ratchet, a negative control that plants a `gh` spawn in a scratch core file, the contract suite on the plugin and on the fake, the moved callers' tests, `plugin list` and `doctor`, and the moved dispatch script once over a stub `gh`.

Acceptance:
```bash
scratch=$(mktemp -d)
mkdir "$scratch/bin" "$scratch/nogh" "$scratch/project"
printf '%s\n' '#!/bin/sh' 'echo "gh is not available in this run" >&2' 'exit 1' > "$scratch/nogh/gh"
chmod +x "$scratch/nogh/gh"
cat > "$scratch/bin/gh" <<'SH'
#!/bin/sh
echo "$*" >> "$STUB_CALLS"
case "$*" in
  "run list "*) echo 4242;;
  *) echo '[]';;
esac
SH
chmod +x "$scratch/bin/gh"
cp -r src/packaging/fixtures/project-tree/. "$scratch/project"
sed -i "s|@@PROJECT@@|$scratch/project|" "$scratch/project/.agent-org/host.json"
git -C "$scratch/project" init -q
git -C "$scratch/project" add -A
git -C "$scratch/project" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m fixture
export AGENT_ORG_HOST="$scratch/project/.agent-org/host.json"
# 1. the baseline holds no file, and the ratchet, its inventory, the contract suite (plugin and fake) and the guards that were re-aimed pass over a gh that fails every call
node --input-type=module -e 'import { readFileSync } from "node:fs"; const files = JSON.parse(readFileSync("docs/gh-call-baseline.json", "utf8")).files; if (Object.keys(files).length !== 0) { console.error("the baseline lists", Object.keys(files)); process.exit(1); }'
PATH="$scratch/nogh:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts plugins/github src/plugins src/packaging/gh-call-ratchet.test.ts src/packaging/gh-call-inventory.test.ts src/packaging/live-default-seams.test.ts src/packaging/no-search-reads.test.ts src/packaging/host-units.test.ts src/ticket-port/ticket-port.test.ts src/manager-spend-post.test.ts src/packaging/trace-weekly-post.test.ts src/pr-open.test.ts src/pr-hold.test.ts src/route-guard.test.ts src/worker-stop-hook.test.ts src/ready-label-audit.test.ts src/unpark-satisfied.test.ts src/close-rows-sweep.test.ts src/closes-mismatch-check.test.ts src/worker-state.test.ts src/worktree-removal.test.ts src/ci-failure-class.test.ts src/class-repeat.test.ts src/decision-confidence-post.test.ts src/packaging/tracker-comment.test.ts src/packaging/queue-table.test.ts src/trunk-red.test.ts src/blast-radius.test.ts src/tick-snapshot-events.test.ts src/release-behind-main.test.ts src/packaging/tool-version-agreement.test.ts src/ticket-mode/pool.test.ts
# 2. NEGATIVE CONTROL: a gh spawn planted in a core file turns the ratchet red and names the file; the plugin's directory is exempt
printf '%s\n' 'import { execFileSync } from "node:child_process";' 'export const planted = () => execFileSync("gh", ["pr", "view"]);' > src/zz-planted-gh-call.ts
if PATH="$scratch/nogh:$PATH" npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/gh-call-ratchet.test.ts > "$scratch/planted.log" 2>&1; then rm -f src/zz-planted-gh-call.ts; echo "the ratchet did not refuse a planted gh spawn"; exit 1; fi
rm -f src/zz-planted-gh-call.ts
grep -q 'src/zz-planted-gh-call.ts' "$scratch/planted.log"
test ! -e src/zz-planted-gh-call.ts
# 3. the activated code host is the plugin at contract 1.12, and doctor says so
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "codeHost": { "provider": "github" } } } }' > "$scratch/host.json"
PATH="$scratch/bin:$PATH" STUB_CALLS="$scratch/calls" AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts plugin list | grep -qE '^  github  *enabled  *contract 1\.12  *plugins/github$'
PATH="$scratch/bin:$PATH" STUB_CALLS="$scratch/calls" AGENT_ORG_HOST="$scratch/host.json" node src/bin.ts doctor 2>&1 | grep -qF 'code host: github (enabled, contract 1.12, plugins/github)'
# 4. a moved script runs once over a stub gh: the board dispatch, with the same two gh calls it made from host/
ls host/*.sh 2>/dev/null && { echo "a shell script is still in host/"; exit 1; }
STUB_CALLS="$scratch/dispatch-calls" AGENT_ORG_PROJECT="$scratch/project/.agent-org/project.json" PATH="$scratch/bin:$PATH" bash plugins/github/host/board-report-dispatch.sh | grep -q 'started run 4242'
grep -qxF 'workflow run board-report.yml --repo a11ign/a11ign' "$scratch/dispatch-calls"
grep -qxF 'run list --repo a11ign/a11ign --workflow board-report.yml --event workflow_dispatch --limit 1 --json databaseId,createdAt --jq .[0].databaseId' "$scratch/dispatch-calls"
rm -rf "${scratch:?}"
```

Consumer-declaration: none -- no host file changes meaning: `tickets.providers.codeHost` keeps its shape. The exported functions of `pr-open` and `merge-guard-lookups` (package.json `exports`) keep their names; the `run` seams their tests injected for `gh` are gone. The three units that start the moved scripts (`board-report`, `manager-spend-post`, `trace-weekly`) change by one line, the script's path, so `host:install` must run before their next firing; `update-tool` holds a release that carries the move until it has (its `host-install-pending` finding).
