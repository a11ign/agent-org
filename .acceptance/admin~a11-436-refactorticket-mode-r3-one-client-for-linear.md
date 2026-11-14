The board's `gh` calls go through the one outside client (A11-436, step 2 of 3): the code host plugin is handed the client bound to GitHub, and its loop runner (`asyncGhRunner`) makes each `gh` through it. A read that met a connection reset is tried again and counted once; a write is made once, so it is never repeated; a `gh` that is not installed is not retried; one GitHub answered (a 404) is not tried again and is not a failed call; ten failed attempts in a row open GitHub's breaker, and the next call is refused at once with "GitHub is unavailable"; a thrown `GhFailure` is classed by the same rule (`programKindOf`), so a reset is transient and a 401 is not; a `gh` the client made is not counted again by `exec`. Step 1's Linear behaviour is unchanged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outside-client.test.ts plugins/github/gh.test.ts plugins/linear/linear.test.ts src/plugins/loader.test.ts
```

Mutation: in `plugins/github/gh.ts`, make `runGh` call `deps.execAsync` directly, and the connection-reset test fails (`asyncGhRunner` rejects with the reset, and the figure is empty). In `src/ticket-mode/outside-client.ts`, drop the `network` entry of `PROGRAM_SAYS`, and the one-rule test fails (`connection reset by peer` classes as `refused`). Drop `once: !isRead(args)` from `runGh`, and the write test fails (`runs.length` is 4). Drop `countedByCaller: true` from `runGh`, and the connection-reset test fails (`countedByCaller` is `undefined`).

Consumer-declaration: none -- no host file key changes. `ExecOptions` gains `countedByCaller`, and the code host is now handed `PluginDeps.outside`; the only code host plugin is bundled and moves with it.
