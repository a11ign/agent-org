## What it is

Ticket mode's settings were loose keys in the `tickets` block of the host file, so a second machine could not be set up without knowing which keys go together. They are now grouped into named provider blocks under `tickets.providers`: `tracker`, `codeHost`, `publish`, `reviewer` and `exposure`. Each block names its provider and reads only its own settings. The old keys still work for one release, as aliases, and `agent-org doctor` names the place each one moves to. `agent-org doctor --fix` moves them, with a backup, and writes nothing unless the moved file reads the same settings.

## Change

- `src/ticket-mode/providers.ts` (new): the resolver. Each block's provider and settings, the old key each setting still reads, and whether that key is stale (its block already holds the same value) or conflicts (refused, naming both keys).
- `src/ticket-mode/settings-refusal.ts` (new): the refusal class, apart from `settings.ts` so the resolver can raise it.
- `src/ticket-mode/settings.ts`: reads the flat settings from the resolver, so its readers are unchanged, and validates each value under the key it was read from.
- `src/host-config.ts`: reads `gh` and `github.identity` through the code host's block, and only that block, so a ticket setting cannot refuse a host file on a machine without ticket mode.
- `src/install/migrate-host.ts` (new): the move, its check that the old and the new file read the same settings, and the backup write.
- `src/install/doctor.ts`: one row per provider, named for it, and one FAIL row per alias still read; `--fix` and `--dry-run`; the reviewer's gate check for an `atomic` reviewer.
- `src/ticket-mode/config-schema.ts`: an entry for each new key, `aliasOf` on each alias, and the Settings page's groups as data (`GROUPS`).
- `README.md`: a row for each new key; `docs/plugins-versus-host-json-keys.md`: the answer to its open check.
- Tests for each provider's defaults, a bad value refused by name, the alias path, the migration of both hosts' shapes, and doctor's rows.

## Acceptance

Acceptance:
```bash
P=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$P" && sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json" && git -C "$P" init -q && git -C "$P" add -A && git -C "$P" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "the fixture project" && AGENT_ORG_HOST="$P/.agent-org/host.json" pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/providers.test.ts src/install/migrate-host.test.ts src/install/doctor.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/readme-keys.test.ts
```

Consumer-declaration: none -- the new keys are read by ticket mode only, and an alias reads the same value it always did.
