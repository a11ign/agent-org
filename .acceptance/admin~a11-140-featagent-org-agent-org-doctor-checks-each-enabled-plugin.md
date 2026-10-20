## What it is

`agent-org doctor` checks the host file, the tracker key, Linear's MCP, the ticket writer and the services, but nothing about the plugins a worker's session depends on. A plugin can be listed in `tickets.plugins` and still not load for a worker, or declare a contract the host's keys do not meet, and today a person learns that only when a run is refused at start (decision record `docs/plugins-versus-host-json-keys.md`, follow-up F5). This change gives `doctor` one check per enabled plugin, built on the reader from A11-136 (`pluginProblems`), so `doctor`, the Settings page and the run start read the same answer.

## Change

- `src/install/doctor.ts`: `pluginChecks(settings, deps)`, placed in `diagnose` right after `writerCheck`. It returns nothing when the host file did not parse or names no plugin. Otherwise it returns one check per entry of `tickets.plugins`, named `plugin <entry>`:
  - does not load: failed, with the reader's sentence as the detail and the instruction at the end of that sentence as the fix;
  - loads, with contract rows for it: failed, with its rows as the detail and the fix `fix what the row says: the board refuses a run while a mismatch stands`;
  - loads, no row: ok, `loads for a worker's session, and no contract mismatch`;
  - the record cannot be read for it: ok, `not checked`, which does not fail.
  A contract row that no entry owns (a `plugin-not-enabled` row names a bare plugin the host does not enable) is listed in one failed `plugin contract` check.
- `DoctorDeps` gains `plugins`, which the `import.meta` block wires to `pluginProblems`. A test injects it, so no install record, plugin file, version or `PATH` is read.
- `src/install/doctor.test.ts`: the seven cases in the Tests section below, and the `deps()` default, which names no plugin.
- `README.md`: the `agent-org doctor` row says what the plugin checks do.
- `.changeset/doctor-checks-each-enabled-plugin.md`: a patch for agent-org.

## Acceptance

Each check is proven by a named test in `src/install/doctor.test.ts`:

- each enabled plugin is listed ok, and the report shows it: `A11-140: doctor lists each enabled plugin as ok when it loads with no contract mismatch, and asks for the plugins a worker's folder gets`;
- an enabled plugin that does not load fails, named, with its fix, and the other stays ok: `A11-140: doctor fails an enabled plugin that does not load, naming it with its fix, and the other one stays ok`;
- a contract mismatch fails, named, with the key: `A11-140: doctor fails a loading plugin whose contract does not match the host's keys, naming the plugin and the key`;
- a row for a plugin the host does not enable is listed in `plugin contract`: `A11-140: a contract row about a plugin the host does not enable is listed in plugin contract, failed`;
- no plugin check on a host that names none, or whose host file did not parse: `A11-140: doctor adds no plugin check on a host that names no plugin, or whose host file did not parse, and asks the record nothing`;
- an unreadable record fails nothing: `A11-140: an unreadable install record is not checked, and fails nothing`;
- the run's exit code: `checks.every(ok)` is false for a plugin that does not load or does not match, and true for a plugin that is fine: `A11-140: a plugin that does not load, or does not match, makes the run fail, and a plugin that is fine does not`.

Acceptance:
```bash
npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts
```

Mutation: the `...pluginChecks(settings, deps),` line was removed from `diagnose`, and six of the seven new cases went red (the quiet-host case holds either way, and is there so the check stays silent when it should). The line was restored and the file passes.

Consumer-declaration: none. `doctor` gains checks, and `DoctorDeps` gains one member that only `doctor` and its test use. The reader, the Settings page and the run start are unchanged.
