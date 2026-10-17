The Linux service unit writes `WorkingDirectory=` bare, with only `%` escaped (`%%`), where it wrote the path in double quotes. systemd reads the quotes as part of the path and refuses the unit (`WorkingDirectory= path is not absolute`), so `agent-org start instance` never started. `ExecStart=`, `Environment=` and the launchd plist are unchanged; the plist is pinned byte for byte by a test.

Acceptance:
```bash
grep -q "the linux unit writes WorkingDirectory unquoted" src/install/service.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/install/service.test.ts
```

Mutation: the `%` escape removed from `systemdPath` (the path passed through as is): 1 test red, the percent test, the other 13 green; the file restored and `diff`-identical to the good copy. Before the change, with the quoted writer, 3 tests were red (the unquoted line, the space-and-percent path, and `systemd-analyze verify`, which reported `WorkingDirectory= path is not absolute: "/opt/a b%c"`); the launchd plist pin was green both before and after.
