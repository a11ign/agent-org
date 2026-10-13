A ticket-mode worker's brief carries the files attached to its ticket (`attachedUploads`, `downloadName` and `download` in `src/ticket-mode/linear.ts`), its parent ticket's quoted description and files (`parent` on `Ticket` in `source.ts`, `parentOf` in `pool.ts`, `parentText` in `worker-files.ts`), the ticket as Linear has it at the start rather than as queued (`current` in `pool.ts`), and a check of the diff against the ticket's criteria and binding decisions before the commit (`briefText`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- the brief gains sections and a step, and a ticket with no attachments and no parent is briefed as before apart from that step; `Ticket` gains `parent`, which a run queued before this release lacks and is briefed without.
