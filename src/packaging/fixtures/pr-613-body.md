## Owned paths, signed off

| fact | state |
|---|---|
| `provisionRevision` | **unchanged** — none of `$ENVIRONMENT_FILES`' five files is in this diff |
| `CAPTURE_PROTOCOL_VERSION` | **unchanged** — nothing here changes what the evidence means; a capture taken before and after this ships is the same evidence, which is precisely why adoption must not move the key |
| `environmentKey` | **changed** — deliberately, and additively: `browserProfile` defaults to `adopted`, so every key already on disk computes to the same value it did before. Verified by asserting `environmentKey({})` deep-equals `environmentKey({ browserProfile: "adopted" })` |
| `weights` | **unchanged** — no model artefact is touched |

## A warm profile and a cold one are different evidence, and they shared a cache entry

`environmentKey` keys on the screen reader, the driver, the browser, the OS, the protocol and the NVDA settings — every one of them for the same stated reason: **it changes what NVDA says before this project ever sees it.** The Edge profile belongs to that class and was not in it.

`browser-profile.mjs`'s own header states the mechanism: a fresh `--user-data-dir` shows Edge's first-run welcome surface, and on a page with no headings **NVDA's quick-nav escapes the empty document into that surface and records it as page content.** A cold profile does not merely differ from a warm one — it injects content that is not the page. The U+FFFC incident measured the same variable from the other end: the autofill icon reached **3%, then 8%, then 31%** of affected captures *as the profile learned*, with **26 good/bad pairs disagreeing about it**.

## `gate:stability` cannot close this, and it is the axis rather than the gate

That gate compares captures taken minutes apart **within one run**. A uniformly cold profile is stable by construction — five cold captures agree with each other exactly. It caught U+FFFC only because the profile was **warming during the run**, a moving variable.

**Nothing compares evidence across runs.** That is the cache key's job, which is why this had to be a key and not a check. Reaching for the stability gate here would have been a check that cannot express the fault.

## MISSING and CHANGED are different states, and the difference is a whole recapture

On the day this ships, **every guest has a profile and no stamp.** If that read as *changed*, every cached capture would miss at once — the `os`-key recapture paid a second time, for a field that has just been introduced and has told us nothing yet.

| state | what it means | what happens |
|---|---|---|
| no stamp, profile **Edge has used** | predates the stamp — this is the profile the corpus was taken against | **adopted**: stamped `adopted`, **key does not move** |
| no stamp, profile absent **or never used** | not a survivor; a cold profile | fresh id, **key moves** |
| stamp differs | not the profile the evidence was taken against | **key moves** — the point of the row |
| stamp present, unreadable | not the same as absent | reports `unreadable`, key moves rather than adopting a cold profile as the corpus's own |

The literal `adopted` is **exactly what `environmentKey` defaults an absent field to**, so a live guest and a record predating the field produce the same key. That equality is asserted, not reasoned about. It is the same device `screenReaderSettings: "default"` already uses one field up: the absent value is a **fact** about how those captures were taken, not an admission that we cannot tell.

**`Local State` is the discriminator** — Edge writes it into the profile root the first time it runs there. Without that test, an empty directory recreated by anything other than this code would be adopted while stone cold. That is the one hole this design has and this is how it is closed.

**Not memoised, deliberately.** `fileProductVersion` memoised on process lifetime and reported a stale Edge version for five days while Edge updated underneath a running worker — captures stamped with a version they were not taken under, sharing a key with evidence from another build. A profile can be wiped under a running worker exactly as Edge can update under one, and noticing is the whole point.

## Acceptance:

```
npx tsx --test packages/nvda-worker/src/profile-identity.test.ts packages/lab/src/training/capture-cache.test.ts
```

26 tests. The load-bearing pair is asserted in **both** directions and in **both** packages, because they sit either side of a dependency boundary — `packages/lab` depends on `packages/nvda-worker`, so the worker cannot import `environmentKey` back without a cycle.

**The proof needs a real guest and is not claimed here.** On a box that already has a profile: `/health.environment.browserProfile` must read **`adopted`** and not a fresh id, the worker log must carry *"adopted an existing profile"*, and `fleet:status` must stay **CONSISTENT** across all nine. Run by whoever drives the fleet — a gate that reads a live fleet is reported by its driver, not by me, and the standing resource ban keeps this session off it.

## Mutation:

```
npm run mutate -- --file=packages/nvda-worker/src/browser-profile.mjs --mutate="perl -0pi -e 's/return \{ identity: ADOPTED_PROFILE, write: ADOPTED_PROFILE, adopted: true,/return { identity: freshId, write: freshId, adopted: false,/' packages/nvda-worker/src/browser-profile.mjs" --test="npx tsx --test packages/nvda-worker/src/profile-identity.test.ts"
```

**Three mutations, all reporting THE GUARD BITES:**

1. **the adoption inverted** — MISSING read as CHANGED, which is the day-one recapture;
2. **the field stops reaching the key** — `browserProfile` hardcoded in `environmentKey`;
3. **the `Local State` discriminator removed** — a never-used directory adopted as warm.

The first is the one that matters: **a test asserting only that a changed stamp changes the key passes with the adoption inverted**, and that inversion is the expensive direction.

## Verification run here

`packages/nvda-worker/src/*.test.ts` and `packages/worker-fleet/src/*.test.ts` — 735 pass, 0 fail. `packages/lab/src/training/*.test.ts` — 405 pass, 0 fail. `lint` 0 errors, `typecheck` clean. `fleet-consistency`'s `MUST_MATCH` gains `browserProfile` with its reason, for the same grounds `browserVersion` and `guidepupVersion` are there. No `runs/`-reading gate was run and none is reported.

Closes #561

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ru7EVccpCdAHYPq5faTNiM

