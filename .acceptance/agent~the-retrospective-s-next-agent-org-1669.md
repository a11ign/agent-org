The retrospective's "Lead time, next to latest" no longer counts a version that `latest` has overtaken as a wait (agent-org#1669). A version never promoted is classed by version order against `latest` in `src/dora.ts` (`waitOf`): an id OLDER than `latest` is `superseded`, counted apart and in neither the median, the max nor the waiting count; only a version NEWER than `latest` is `unpromoted` and aged to the current time. The reading prints the superseded count after the existing UNPROMOTED clause (`, N superseded (overtaken by \`latest\`: not a wait, out of the median and max)`). `src/packaging/dora-superseded-version.test.ts` covers the classing by version order (`1.9.0` sorts before `1.10.0` though it reads later as text), the median and max that leave the overtaken versions out, that an overtaken version does not age, and a window of only overtaken versions reading `undefined` with its reason.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/dora-superseded-version.test.ts src/dora-channels.test.ts
```

Consumer-declaration: none -- the change is a rule inside `src/dora.ts`, the retrospective's own module; the `superseded` state is internal to it and reaches the reader only as a printed count.
