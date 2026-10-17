Ticket mode's reviewer port closes a reviewer's workspace once its verdict on the head it was started for is posted, keeping its checkout; the pool's merge sweep (`releaseReviewers`, on the server's own interval beside `watchFeedback`) retires a pull request's reviewer once that pull request has merged or closed: every workspace under its seat's label closes, then its `~/reviews/<seat>` checkout is removed (a dirty one is reported first, with its changed paths), then the pool forgets the pull request. A pull request still open, or whose state cannot be read, is left alone.

Acceptance:

```bash
grep -q "a reviewer is closed once its verdict on its head is posted" src/ticket-mode/pool.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Mutation: each of ten breaks run and restored, each confirmed with `cmp`: no close after a verdict (3 tests red), a working reviewer closed (1), the busy close never asked again (1), the discard report dropped (2), the checkout removed before the workspaces close (1), an unreadable checkout removed anyway (1), the memory not written after a forget (2), a merged pull request never retired (5), a reviewer started for a merged pull request (1), and a forget that keeps the started key (2).
