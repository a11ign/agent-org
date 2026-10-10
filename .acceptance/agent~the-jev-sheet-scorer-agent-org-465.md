The Jev sheet scorer is committed: `src/trace/triage-jev.ts` reads the frozen #4074 sheet, asks Jev one `choice` question per row through the triage seam (`askProvider`, no second client), and writes the predictions file `triage-sample.ts --score` reads, each row's confidence kept beside its label. This is a11ign/agent-org#465, Change 4 of a11ign/a11ign#4187 split out.

Closes a11ign/agent-org#465

Class: unrepeatable-hand-run — a reading taken once by a script that was not committed, so "run it again" had nothing to run; guard: the script and its test are in the tree, and the test names each way a row is written `wake` and the run still finishes.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/trace/triage-jev.test.ts
```

Hand-run: the live reading on the frozen sheet at 0.9 (needs the key at the host's `triage.keyPath`, which CI does not have): `node src/trace/triage-jev.ts --threshold 0.9 --out <predictions.json>`; its figures are posted on a11ign/a11ign#4055.

Mutation: the threshold made never to fire (`false && confidence < threshold`) -> 1 of 11 red (the below/at-threshold case); made always fire -> 3 of 11 red (that case, the no-cause case, the provider-failure case); the no-cause check made never to fire -> 2 of 11 red (the no-cause case and the `--score` acceptance, whose six unreadable rows are no longer `wake`); the pool made unbounded (1000) -> 1 of 11 red (the in-flight ceiling), made serial -> the same 1 of 11 (the pool must reach 10); the request header copied into the printed figures -> 2 of 11 red (the no-leak case and the usage case); a failed row written something other than `wake` -> 6 of 11 red; a failed row aborting the run -> 5 of 11 red. Each restored from a copy taken before and `diff`ed byte-identical.
