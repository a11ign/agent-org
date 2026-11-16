The defaults assertion in `src/ticket-mode/settings.test.ts` and the full-settings fixture in `src/ticket-mode/config-schema.test.ts` put each key on a line of its own, with the assertions unchanged. Two pull requests that add different `tickets.*` keys in different places no longer conflict in either file.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts
# the defaults assertion: one key per line (no line holds two `key:` pairs)
! grep -nE '^    [A-Za-z]+: .*, [A-Za-z]+: ' <(sed -n '/override the defaults/,/^});/p' src/ticket-mode/settings.test.ts | sed -n '3,50p')
```
