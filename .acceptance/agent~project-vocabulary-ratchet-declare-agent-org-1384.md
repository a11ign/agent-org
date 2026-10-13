Declares `ticket-mode/board-view.ts "blocked"` in `DECLARED_NON_VOCABULARY_HITS`: the ticket board's own `RunStatus` member, never the `blocked` GitHub label. Unblocks agent-org#1383, whose head holds the literal at lines 114, 120 and 164.

Acceptance:

```bash
node --test src/packaging/project-vocabulary.test.ts
```

Mutation: with the declaration present, a probe `"blocked"` literal appended to `src/ticket-mode/board-view.ts` passes the ratchet (17 of 17). With the declaration removed, the same probe fails "#2619 ACCEPTANCE, MUTATION TARGET" naming `ticket-mode/board-view.ts "blocked"`. The file was restored from a scratchpad copy and `cmp`'d byte-identical.

Consumer-declaration: none -- one declaration on a test list, no code path changes.
