A finished run that ended with something to say offers Talk to it, which resumes the run's own Claude session in a new pane with a prompt telling the agent a person is here. The run goes back on the queue as a talk session, starts in the same place it ran (a batch's folder for a batch's run), sets its old outcome aside so the stop hook asks for a new one, and ends as any run does. A run with no saved session is refused with its reason, and one whose pane fails to start goes back on the board as it was. Every action and link on a run's row is an icon with a title and its words in a screen-reader-only span.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/reviewer-port.test.ts
```

Mutation: seven changes were made in turn, and each time one or more of the new pool tests went red; all were restored and the suites passed again. They were: the guard that a run can be talked to (`canTalk`) made always true; the restore of the finished run on a failed start taken out; the old outcome not set aside; the session lookup (`talkSession`) returning nothing; Remove on a queued talk session no longer putting the finished run back; the outcome file not put back after a failed start; and the pull requests a talk session borrows to stay linked not dropped when it ends on a pull request outcome.

Consumer-declaration: none -- the new `talk` run action, `talk`/`talkFrom` entry fields and `/api/queue/<key>/talk` route are read only by the pool, the server and the page; a queue file written before them has none of the fields and reads as before.
