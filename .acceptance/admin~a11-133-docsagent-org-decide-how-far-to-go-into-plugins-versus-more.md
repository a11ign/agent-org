The decision record `docs/plugins-versus-host-json-keys.md` says whether agent-org goes further into plugins, decides each of the ten ticket-mode keys (`brief`, `review`, `deny`, `connectors`, `plugins`, `preflight`, `planner`, `writer`, `publish`, `prReview`) as stays, plugin or split with its reason, compares four options against today's failures (the enabled-but-not-loaded case in `src/ticket-mode/plugins.ts` among them), says what it takes and leaves from VS Code, Terraform, Backstage and Home Assistant, and ends with go, which is narrow, and six named follow-ups. It changes no code.

Acceptance:
```bash
f=docs/plugins-versus-host-json-keys.md
test -f "$f"
for k in brief review deny connectors plugins preflight planner writer publish prReview; do
  grep -Eq "^\| \`$k\` \| (stays|plugin|split)" "$f" || { echo "no decision row for $k"; exit 1; }
done
for p in "VS Code" Terraform Backstage "Home Assistant"; do
  grep -q "$p" "$f" || { echo "no section on $p"; exit 1; }
done
grep -q "src/ticket-mode/plugins.ts" "$f"
grep -Eq "^\*\*(Go|No-go)" "$f"
! grep -Eq "ts\.net|/home/[a-z]+|linear-key" "$f"
```

Mutation: none, since the record is documentation and no check reads behaviour. The block is a presence check on the file's rows, sections and verdict, plus a check that it copies no host value. Run on the file as written, the block exits 0 and prints nothing.

Consumer-declaration: none. No code, test or reader changes, so no consumer of `host.json`, `project.json` or the plugin changes.
