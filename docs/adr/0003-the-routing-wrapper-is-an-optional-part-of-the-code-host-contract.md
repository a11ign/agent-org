# The `gh` routing wrapper is an optional `wrapper` part of the codeHost contract, and what core still holds of it moves with its callers

## Context

Every `gh` an agent runs on an org host goes through one shell script, `host/gh`: it decides which account or GitHub App a role acts as, mints the App's token, records the call and queues a write GitHub refused. A11-160 moves every `gh` call behind the codeHost contract, so the wrapper, its renderer, the App-token minter and the checks of both are GitHub's. But core installs, compares and re-writes the wrapper (`host:install`, `host:check`, the tick, the instance's start-up), and a plugin imports core's types only (ADR 0001) while core imports no plugin's code (A11-159's boundary test, which has no allow-list).

## Decision

1. **The wrapper is one optional member group of the codeHost contract, `wrapper` (contract 1.3).** The plugin renders it and answers the rules about writing it (`file`, `appRoles`, `refusal`, `divergence`, `identityStale`, `mintFailure`); core writes the file, after asking `refusal`. A code host with no `wrapper` installs none. The inputs are the host file's facts (`HostPlace`: the bin directory, the installed tool, the primary checkout and the state directory's entries), the two accounts' folders and each role's identity, which core reads and hands over.
2. **The plugin's own `doctorChecks` and `onboardSteps` say the rest** (`gh wrapper`, `wrapper roles`, `app token <role>`, the App's key), and ask for the place through `deps.place()`.
3. **What core still holds, it holds because a core caller still needs it, and each moves with that caller:** the cache reader `src/app-token-cache.ts` (wake's reviewer-token refresh, step 3), the App JWT signer in `event-tunnel.ts` (the event feed, step 8), `gh-identity.ts` (`work-gate.ts`, `review-trust.ts`, org-health), `gh-conditional.ts` (the gate), `app-role-silent.ts` and the `gh-author-fallback` signal (the tick's and org-health's ledger readers). `app-token-cache.test.ts` holds each pair that is written down on both sides to one.

## Why

Without a `wrapper` group the plugin could not own the template, and core could not ask for it without importing it. A generic "owned files" bag would give every contract a place for host files and push the A11-84 rules (a wrapper that names no App must never replace one that does) into core again, where the incident came from. A contract operation per decision core takes keeps those rules in the plugin and the writing in the one writer.

## Considered

- **Core keeps the wrapper and the plugin only checks it**: rejected. The wrapper is GitHub's command language (`gh pr create` refusals, ledger fields, rate-limit queueing) and would stay in core against Decision 2 of A11-157.
- **Core imports the plugin's renderer**: rejected. The boundary test forbids it, and it is what lets a third-party code host exist.
- **A `gh(args)` pass-through**: rejected, as in ADR 0002.
- **Moving every identity module in this step**: rejected. `gh-identity.ts`, `gh-conditional.ts`, `app-role-silent.ts` and the author-fallback signal are read by gate and org-health code that moves in steps 6 and 8, and a contract operation for each would be deleted when its caller joins the plugin.

## Paths

- `agent-org:plugins/github/`
- `agent-org:src/plugins/contracts/code-host.ts`
- `agent-org:src/plugins/host-place.ts`
- `agent-org:src/host-units/`
