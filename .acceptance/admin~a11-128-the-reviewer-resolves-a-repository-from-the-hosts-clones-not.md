## What it is

`agent-org ticket:review https://github.com/a11ign/plugin/pull/<n>` was refused with "a11ign/plugin is not a repository the project declares" (2026-10-19), because the atomic reviewer found a seat only for the primary repository and for one listed under `code` in `.agent-org/project.json`. Declaring `a11ign/plugin` there would drag a small private repository into the old org's standards, and that declaration cannot merge while the product repository's CI is red. The host already names its repositories under `clones` in `host.json` (A11-128).

## Change

- `src/ticket-mode/reviewer-port.ts`: `seatOf` takes a third route after the primary and the declared repositories: a repository the host clones (`clonedSeatOf`, pure), when it is under the primary's owner and its name is a `clones` key. Its seat key is the clone's name, so the seat is `reviewer-<name>-<n>`. A name that cannot be a reviewer key, or that is the declared key of another repository, is refused by name. `repositoryOfKey` falls back to the clones, so the sweep finds a cloned-only reviewer's pull request and retires it.
- For a cloned-only seat the port passes the clone as the checkout's `repoRoot` (`prepareReviewCheckout`, `removeReviewCheckout`), and passes `GH_REPO` and the host file's path to the spawned reviewer and to the verdict door, since the gate reads the declaration for both and a cloned-only key has none. A primary or declared seat passes nothing extra.
- `atomicReviewerPort` takes `clones` (default `{}`); `pool-context.ts` and `review-command.ts` pass `settings.clones`.
- `src/ticket-mode/config-schema.ts`: the `clones` explanation says a cloned repository's pull requests are reviewed with no declaration.
- The gate's own modules (`src/wake/*`) are not changed: their refusal of an undeclared key is deliberate.

## Acceptance

Typecheck and lint are clean. The named test files pass, including the new cases: a cloned-only repository is started in its clone with `GH_REPO` set, is live, listed and retired from its clone, and its verdict posts to its own repository; a repository neither declared nor cloned, or cloned under another owner, is refused naming `project.json` and `host.json`; a clone named as a reviewer key cannot be, and a clone named as another repository's declared key is refused; a declared repository whose name is also a clone keeps its declared key and passes no clone.

```bash
set -e
npm run typecheck
npm run lint
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/review-command.test.ts src/ticket-mode/config-schema.test.ts
```

Consumer-declaration: none -- `clones` keeps its shape and its readers; a repository the host clones is now reviewable by `ticket:review` and the pool's reviewer, and no key of the host file or the project changes.
