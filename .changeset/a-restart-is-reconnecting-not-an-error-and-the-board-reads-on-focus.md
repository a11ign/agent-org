---
"agent-org": patch
---

The board page no longer shows a red error while `agent-org update` restarts the instance or the page's service: a read with no answer, or a 502 or 503 from a proxy, shows a quiet "Reconnecting…" line, tried again after 2 s, 4 s, 8 s ... up to 60 s, and the line clears by itself when the instance answers. The page also reads the queue again at once when its tab is shown or its window is focused, so a tab left open comes back to current state with fresh Open terminal links, and an Open terminal link older than 5 s reads the run's pane again when clicked. The board UI's `usePoll` does the same and reports `reconnecting`. Red stays for an error the server answered with.
