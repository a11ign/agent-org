Model routing has never consulted the provider: every call was rejected with HTTP 422, so all 15 routed starts in a11ign's decision log read `"via":"none"` with reason `the API answered HTTP 422`, and the journal line was identical to the pre-switch one. This is item 1 of the chairman's direction on a11ign/a11ign#4627, for row a11ign/agent-org#564.

Closes: none — row a11ign/agent-org#564 stays open: its Done-when 2 needs the first live `"via":"jev"` record after a release, which product-manager quotes on a11ign/a11ign#4669.

## What changes, and why

- **The wire.** `wire()` sent a `score` question as `{type, instructions}`; the API's `ScoreQuestion` requires `criteria`, an ordered array of level descriptions, and one invalid question rejects the whole request (the four valid `choice` questions fell back with it). `Question` (type `score`) now carries `levels`, five descriptions with level 1 first, taken from the text the instructions already held in `src/engineer-route.ts`; `wire()` sends them as `criteria`. `ProviderQuestion` in `src/triage-provider.ts` (outside the row's Region, a type only) gains the array so the type matches the wire.
- **The scale.** The API scores a level by its position from zero and answers fractionally (`0.04` for the first level). `readAnswer` rounds to the nearest level and adds one, so the callers still see 1..5; a position that rounds outside the five levels is still malformed. No other `type: "score"` question exists in `src/` (grepped: `engineer-route.ts` is the only one).
- **Every fallback says why** (the chairman's check, beyond the row's Change). Before this PR a fallback that never reached the provider (use switched off, no provider, state too large, key unreadable) wrote no line at all, and the outcome line `route X via fallback` carried no reason for any of them. Now:
  - the outcome line has a `reason` field (`recordOutcome` takes it as an optional fifth argument; `outcome` itself is byte-identical, so readers of the label are unaffected) and the journal's `why` ends `the provider did not decide: <reason>`;
  - a `jev` route held to Sonnet/high because an answer is `null` lists which answers were not given and why (malformed, or `yes at 0.44, under the floor 0.9`);
  - a refused row and a refused `tier:haiku` override carry what refused them;
  - a switches file that exists and cannot be used now reads `the use is switched off: the switches file could not be used`, never its text, instead of the plain `the use is switched off`.
  - Covered by a test per path: switch off, no provider, HTTP 422, a timeout, a state too large (reachable only with multi-byte text, since `routeState` clips each field), a malformed answer.

## Platform first, deleting first

platform: n/a (nothing in GitHub, systemd or git builds the decision seam's request; the shape is the provider's own OpenAPI schema).

Net lines: positive, almost all of it tests; the production change is a field, one conversion and the reason plumbing, and no function was added where an existing one could take it.

## How you verified it

The tests need `AGENT_ORG_HOST` pointing at a checkout that holds `.agent-org/project.json` (this worktree has none, and the Acceptance command as written refuses without it, on `main` too); I ran with it set to the a11ign checkout's `host.json`. The Acceptance line is the row's command without its `cd` into the primary checkout: that path holds `main`, which carries this change only after the merge, so a run there says nothing about the diff (it passed there too, before the change was in it).

```
$ node --import tsx --test src/decision-provider.test.ts src/engineer-route.test.ts
ℹ tests 37   ℹ pass 37   ℹ fail 0
$ node --import tsx --test src/class-match.test.ts src/ci-failure-class.test.ts src/duplicate-row.test.ts src/review-depth.test.ts src/class-repeat.test.ts src/triage-provider.test.ts
ℹ pass 108   ℹ fail 0
$ npx tsc --noEmit -p .     # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

Two mutations, each turning named tests red and restoring green: the score's `criteria` left off the wire (3 red, among them the new wire test and its recorded-200 sibling), and truncating the score instead of rounding (1 red, the rounding table). The wire test's fake answers HTTP 422 for a body the API's schema would refuse and 200 with the recorded reply (`jev-1.13.0`, score `0.04`, 2026-10-09T23:10Z) otherwise, so a fake that accepts any body is no longer the only control.

Acceptance: `node --import tsx --test src/decision-provider.test.ts src/engineer-route.test.ts`

Mutation: the score's `criteria` left off `wire()` -> 3 tests red (the new wire test, its recorded-200 sibling, the request-shape test); `Math.trunc` for `Math.round` in `readAnswer` -> the rounding table red; both restored green.

## Anything a reviewer should be sceptical of

- **Rounding at the boundary.** `Math.round` sends `x.5` up, so `-0.5` is level 1 and `4.5` is outside; a provider answering exactly on a half is unlikely and either choice is arbitrary.
- **The levels are the row's own five descriptions.** The recorded 200 used the probe's own five criteria, not these, so it shows the wire and the scale and says nothing about how well these descriptions separate rows. That is what Done-when 2 and the log's later `merged-first-pass` / `not-first-pass` outcomes will show: this PR makes the provider answer, not answer well.
- **`instructions` no longer says "from 1 to 5".** The provider scores by position from zero, and a model told "1 to 5" beside a zero-based legend invites an off-by-one; the levels now carry the scale.
- **Nothing observable changes until a release carries this** and the host's decision log is read again.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
