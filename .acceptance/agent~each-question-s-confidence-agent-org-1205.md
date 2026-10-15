Row: a11ign/agent-org#1205 (items 1-2 of its Change; item 3 is a11ign/agent-org#1445, `blocked-by` this row, and is not in this PR).

`src/confidence-floors.ts` is a pure module: `calibrateFloors(lines, { use, flatFloor? })` joins each `model-routing` request to the outcome lines written for it, and per question picks the lowest floor on a 0.50 to 0.95 grid at which the answers at or above it were right at `RIGHT_RATE` (0.8), over at least `MIN_SAMPLE` (30) judged answers. Where the sample is too small, or no floor reaches the rate, the flat 0.7 stands and the reading says so. It writes nothing and reads no file: the result is data.

Turns and compactions are not read yet: the log line does not carry them. Each routing's verdict is applied to every one of its answers, so this is a proxy per question, not a per-question judgement.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/confidence-floors.test.ts
```

The five tests in `src/confidence-floors.test.ts` each carry a negative control: a floor moves up when the answers just above the flat floor were wrong, moves down when the answers below it were right, a sample under the minimum keeps the flat floor and says so, a routing with a confidence and no verdict is counted and named, and a later request for an id starts a new routing.

Mutation (the module restored by `cp` from a copy and proven byte-identical by `diff`): `RIGHT_RATE` forced to 1.5, so no floor is ever reached and every question stays flat: 3 of 5 fail.

Consumer-declaration: none -- the module is pure and nothing imports it yet; its consumer is a11ign/agent-org#1445, which reads the calibrated floors from a sibling file and is not in this pull request.
