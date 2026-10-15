`pr:hold --until="closed #N"` is refused before any write when #N is open and somebody is working it, but its open closing pull request, or the row itself, waits on the held pull request (`merged <held>`), or waits on a row the held pull request closes (`closed <row>`): the two cannot move, and no tick names the cycle (a11ign/agent-org#1396, chairman class 1, agent-org#1365 held `closed #1325` while #1378, which closes #1325, waited `merged #1365`).

Acceptance:
```bash
node --test src/hold-cycle.test.ts src/pr-hold.test.ts
```

The row's command is `cd ~/repos/agent-org && node --test src/hold-cycle.test.ts src/pr-hold.test.ts`; the same command run in the PR's own tree (`~/repos/agent-org` is a detached checkout of the primary, which does not carry this PR until it merges). `AGENT_ORG_HOST` is set to a11y-witness's `.agent-org/host.json`. The take-level cases run the real `pr-hold.ts` against a fake `gh` first on PATH: REFUSED with the cycle named and no label, marker or merge written; REFUSED through a `closed <row>` link; CONTROL taken on a third-row wait and when #1378 cannot be read (a NOTE, not a refusal).

Mutation (each applied to the PR's sources, run against the two files above, restored byte-identical with `diff` against a copy):
- the wiring off (`holdCycleRefusal` returns `null`): 3 of 29 fail: both REFUSED tests and the CONTROL, whose unreadable half expects the NOTE.
- the closed-row link off (`closes.includes(key) && false` in `hold-cycle.ts`): 3 of 29 fail: the closed-row leaf test, the case-insensitive key test and the take-level REFUSED through `closed #1300`.

Consumer-declaration: none -- nothing a consumer sets changes.
