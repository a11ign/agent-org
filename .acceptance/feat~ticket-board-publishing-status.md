A ticket-mode run Ready to merge shows as Publishing, with the yellow spinning ring and an Open terminal link to the publish run's own herdr pane, from the press of Publish until the publish run ends (`isBeingPublished`, `shownStatus`, `statusCounts`, `runsShown` and `publishTerminalLink` in `src/ticket-mode/board-view.ts`; the Publishing icon, colour and filter, and the link on each row, in `ui.html`). The page reads the publish run's `workspace` and `pane` from `GET /api/queue`, which `markPublishRunning` in `queue.ts` and `startPublish` in `pool.ts` already record. A run the publish run does not post, a run already Published, and a run after the publish run finished are not Publishing, and a failed publish run leaves its runs Ready to merge.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a new status and filter on the board page, read from fields the queue already holds; no host key, no action and no refusal changes.
