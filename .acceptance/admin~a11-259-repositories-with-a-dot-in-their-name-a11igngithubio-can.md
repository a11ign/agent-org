## What it is

A repository whose name has a dot (`a11ign.github.io`) could never be reviewed: the atomic reviewer's key was the host clone's name, and `clonedSeatOf` refused a name that is not already a reviewer key (lowercase letters, digits and hyphens, not ending in `-<digits>`) on every tick. The key is now made by `derivedName` (`src/derived-name.ts`), the one function that herdr's agent name (`herdrAgentName`, A11-241) also goes through, each with its own rule.

## Change

- `src/derived-name.ts` (new): `derivedName(real, rule)`, the two rules (`HERDR_AGENT_RULE`, `REVIEWER_KEY_RULE`), `isReviewerKey`, and `cloneKeys(clones, declaredKeys)`, which keeps the clones' keys distinct from each other and from the declared keys.
- `src/herdr-agents.ts`: `herdrAgentName` is `derivedName(full, HERDR_AGENT_RULE)`; its names are unchanged.
- `src/review-attribution.ts`: `reviewerInstance` tests a key with `isReviewerKey`.
- `src/plugins/manifest.ts`, `src/plugins/reviewing-helpers.ts`: `attribution.cloneKeys` reaches the plugin as `reviewerSeat` does.
- `plugins/atomic-reviewer/port.ts`: `clonedSeatOf` takes its key from `cloneKeys` (no more refusal of a name that is not a key), and still refuses a clone named as a declared key, which is that repository's checkout (`clones` is by key); `repositoryOfKey` maps a key back to the clone's real repository through the same `cloneKeys`.

## Acceptance

`a11ign.github.io` gets the key `a11ign-github-io` and its pull request #3 gets the seat `reviewer-a11ign-github-io-3`, checked out in its clone and posting to `<owner>/a11ign.github.io`; the seat is read back, listed and retired as that repository. `lab-2` becomes `lab-2-repo`, and `lab2` is unchanged. `a.b` and `a_b` get two different keys; a clone already named as a key keeps it. herdr's tests pass unchanged.

Acceptance:
```bash
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/derived-name.test.ts src/herdr-agent-name.test.ts plugins/atomic-reviewer/dotted-repository.test.ts plugins/atomic-reviewer/port.test.ts plugins/atomic-reviewer/long-seat-name.test.ts
npm run typecheck
```

Consumer-declaration: `clonedSeatOf` (exported, used only by the reviewer port and its test) takes `keys` as well, and refuses only a clone named as a declared key. `herdrAgentName` and `reviewerInstance` return what they returned for every name they accepted before.
