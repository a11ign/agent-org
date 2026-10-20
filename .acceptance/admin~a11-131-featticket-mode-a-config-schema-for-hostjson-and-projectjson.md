Ticket mode's Settings is a page at its own address, `#/settings`, and no longer a dialog. It shows, for every key that the readers named in `config-schema.ts`'s header accept (`host.json` and its `tickets` block, `project.json`, and the workers and emergency-priority flags), its explanation, its value, a state in words (enabled, disabled, not set or default) and its source. The description is `config-schema.ts`, a test ties it to the readers (`config-schema.test.ts` records what each reader reads), and the page draws what `settings-view.ts` returns from the files `settings-read.ts` reads fresh on each `GET /api/settings`. A refused file shows its refusal, and the rest of the page still draws. A secret shows its path and whether the file exists, never its text. The editable controls keep their behaviour (`POST /api/choice`, `POST /api/max`). The plugins section says whether a worker's session loads each plugin (`pluginStates` in `plugins.ts`, which `unreachablePlugins` shares).

Acceptance:
```bash
test -n "$AGENT_ORG_HOST" || { echo "set AGENT_ORG_HOST to a host declaration whose primary checkout is a project, as CI's suite job does"; exit 1; }
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/settings-view.test.ts src/ticket-mode/plugins.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/settings.test.ts src/packaging/project-config.test.ts
npm run typecheck
```

Consumer-declaration: none -- no key is added to or read differently by a reader; `GET /api/settings` is new and read-only, and an instance without it answers 404, which the page says.
