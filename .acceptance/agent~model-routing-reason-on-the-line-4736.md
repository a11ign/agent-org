Model routing has never consulted the provider: every call was rejected with HTTP 422, so all 15 routed starts in a11ign's decision log read `"via":"none"` with reason `the API answered HTTP 422`, and the routing line a person reads (`route X via fallback`) named no reason. This is the whole of a11ign/a11ign#4736 (the mirror of agent-org#564, and item 1 of the chairman's direction on a11ign/a11ign#4627): the wire, the scale, and the reason on every line.

Closes a11ign/a11ign#4736, a11ign/agent-org#564

a11ign/a11ign#4627 stays open. The mirror's Done-when 2 (the first live `"via":"jev"` record after a release, quoted with its row and its outcome line) is still owed there, by product-manager; this PR makes that record possible and cannot show it.

## What changes, and why

- **The wire (mirror item 1).** `wire()` sent a `score` question as `{type, instructions}`; the API's `ScoreQuestion` requires `criteria`, an ordered array of level descriptions, and one invalid question rejects the whole request (the four valid `choice` questions fell back with it). `Question` (type `score`) now carries `levels`, five descriptions with level 1 first, taken from the text the instructions already held in `src/engineer-route.ts`; `wire()` sends them as `criteria`. No other `type: "score"` question exists in `src/` (grepped: `engineer-route.ts` is the only one). `ProviderQuestion` in `src/triage-provider.ts` (outside the Region, a type only) gains the array so the type matches the wire.
- **The scale (item 2).** The API scores a level by its position from zero and answers fractionally (`0.04` for the first level). `readAnswer` rounds to the nearest level and adds one, so the callers still see 1..5; a position that rounds outside the five levels is still malformed.
- **The wire is pinned (item 3).** The routing test's fake validates the posted body against the API's schema (`criteria` an array for the score, an object for each choice) and answers with the recorded 200 (`jev-1.13.0`, score `0.04`, 2026-10-09T23:10Z). Its control: the same request with `criteria` left off is the API's 422, every question falls back, and the log says so.
- **The reason on the line (item 4).** `routeEngineer`'s outcome line is now `route <route> via <via> (<why>)`, and `Routed.why` is that same text, so the work tick's `routed ...` journal line (`wake.ts`, unchanged) prints it too:
  - `fallback`: the provider's own failure, never the rule's gloss: `the use is switched off`, `no triage provider is declared`, `the state is too large to send`, `the API answered HTTP 422`, `the API timed out`, an answer under the floor (`yes at 0.44, under the floor 0.9`), `the API's answer was not a choice with a confidence`.
  - `refused`: what refused the row (`the row carries lane:ceo`, `its Region names .github/workflows/`, `it has no Acceptance command`).
  - `override`: the label (`tier:haiku`), and when Haiku was refused, `tier:haiku was refused: <the refusal>`.
  - `jev`: the answers that composed the route, each one `name=value` or `name=not given (<why>)`; a composed Haiku the switch refused adds its refusal.
- **Decisions that never reached the provider are logged (the chairman's check, beyond the Change).** A decision that stopped before the request (the use switched off, no provider, a state over the cap, an unreadable key) wrote no line at all, so the log could not say why a row fell back. Each now writes its line with the reason, and a switches file that exists and cannot be used says so (`the use is switched off: the switches file could not be used`), never echoing its text. The outcome line also keeps a structured `reason` field for readers that parse the JSON; the `outcome` label's `route X via Y` prefix is unchanged.
- **A test per `via`, and the named case (item 5).** `jev`, `fallback`, `refused` and `override` each pin the exact line; the named case pins that a fallback after the API's 422 reads `route sonnet/medium via fallback (the API answered HTTP 422)`, not `a small row`. A second test pins that the journal line equals the outcome line's text, and a table covers the six ways the provider fails to decide (switch off, no provider, HTTP 422, a timeout, a state too large, a malformed answer).

## Platform first, deleting first

platform: n/a (nothing in GitHub, systemd or git builds the decision seam's request; the shape is the provider's own OpenAPI schema).

Net lines: positive, almost all of it tests; the production change is a field, one conversion, and the reason carried to the two lines that already existed. No function was added where an existing one could take it.

## How you verified it

The tests need `AGENT_ORG_HOST` pointing at a checkout that holds `.agent-org/project.json` (this worktree has none, and the Acceptance command as written refuses without it, on `main` too); I ran with it set to a long-lived checkout's `host.json`. The Acceptance line is the mirror's command without its `cd /home/agent/repos/agent-org`: that path holds `main`, which carries this change only after the merge, so a run there says nothing about the diff (it passed there before the change was in it).

```
$ npx rstest run --config scripts/rstest/rstest.config.* src/decision-provider.test.ts src/engineer-route.test.ts
VERDICT pass: 39 tests in 2 files
$ node --import tsx --test src/class-match.test.ts src/ci-failure-class.test.ts src/duplicate-row.test.ts src/review-depth.test.ts src/class-repeat.test.ts src/triage-provider.test.ts src/engineer-escalation.test.ts
ℹ tests 145   ℹ pass 145   ℹ fail 0
$ npx tsc --noEmit -p .     # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

Mutations, each turning named tests red and restoring green: the score's `criteria` left off `wire()` (3 red: the wire test, its recorded-200 sibling, the request-shape test); `Math.trunc` for `Math.round` in `readAnswer` (the rounding table red); the outcome line without its `(<why>)` (4 red); a fallback's `why` left as the rule's gloss (4 red); a refused row's `why` replaced by `the ordinary profile` (2 red).

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/decision-provider.test.ts src/engineer-route.test.ts`

Mutation: the score's `criteria` left off `wire()` -> 3 tests red; `Math.trunc` for `Math.round` in `readAnswer` -> the rounding table red; the outcome line without `(<why>)` -> 4 red; all restored green.

## Anything a reviewer should be sceptical of

- **The line grew.** The outcome label is longer (`route X via Y (<why>)`); anything that matched the whole label rather than its prefix would stop matching. I grepped `src/` and the docs for `via fallback`, `via jev` and `route .* via`: the only readers are this module's tests and `recordOutcome`'s test. The decision log's own readers on the host (`jq`, `grep`) were not searched.
- **A `jev` line is longer still**: five `name=value` pairs. That is the point (the first live record must show what composed it), but it is the longest line the log carries.
- **Rounding at the boundary.** `Math.round` sends `x.5` up, so `-0.5` is level 1 and `4.5` is outside; a provider answering exactly on a half is unlikely and either choice is arbitrary.
- **The levels are the row's own five descriptions.** The recorded 200 used the probe's own five criteria, not these, so it shows the wire and the scale and says nothing about how well these descriptions separate rows. The log's later `merged-first-pass` / `not-first-pass` outcomes will show that: this PR makes the provider answer, not answer well.
- **`instructions` no longer says "from 1 to 5".** The provider scores by position from zero, and a model told "1 to 5" beside a zero-based legend invites an off-by-one; the levels now carry the scale.
- **Nothing observable changes until a release carries this** and the host's decision log is read again.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
