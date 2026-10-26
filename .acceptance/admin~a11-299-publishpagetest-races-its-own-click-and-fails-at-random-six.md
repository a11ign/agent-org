## What it is

`ui/test/publish/publish.page.test.ts` clicked Publish, waited for `page.waitForRequest`, and read the stand-in's list of calls (`Asked.requests`). `waitForRequest` resolves when the page sends the request; `serveInstance` records the call afterwards, in its `context.route` handler, so the list could still be empty: `AssertionError: expected [] to deeply equal [ { keys: [ 'A11-180' ] } ]` (six CI runs, two merge-queue ejections).

## Change

- `ui/test/instance-routes.ts`: `answeredAfter(page, suffix, act)` runs `act` and waits for the answer to the call ending `suffix` (10 s deadline). The handler records a call before it answers, so the call is in `requests` once the answer is back.
- `ui/test/publish/publish.page.test.ts`: both clicks use `answeredAfter`. A new test holds the call 300 ms in a route registered after the stand-in and still reads the call.
- `.github/workflows/ui-publish-repeat.yml`: on a pull request that touches the publish test, the helper or the workflow (not a draft, not the merge queue, not part of `gate`), runs the publish page test 30 times in separate processes and fails on the first red.
- The other `*.page.test.ts` files that read captured calls after a click (`new-ticket`, `tickets`, `runs`, `settings`, `plugins/badge`) were read: each waits for something drawn from the answer, a resource-timing entry, or `networkidle` before it reads, all of which happen after the stand-in recorded the call. None has the pattern, so none changed.

Acceptance:
```bash
cd ui && pnpm install --frozen-lockfile && pnpm build && for run in $(seq 1 5); do pnpm exec rstest run --config rstest.config.ts test/publish/publish.page.test.ts || exit 1; done
```

Mutation: the `publisher.publish` call was taken out of Run detail's press handler and the site rebuilt; the posting test and the late-recording test went red (`page.waitForResponse: Timeout 10000ms exceeded`). Restored, they pass. With the old `waitForRequest` line put back, the late-recording test fails with the ticket's `expected [] to deeply equal [ { keys: [ 'A11-180' ] } ]`.
