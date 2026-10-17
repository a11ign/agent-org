---
"agent-org": minor
---

A ticket-mode reviewer's verdict is no longer lost when its post fails. The verdict door (`pr-review-verdict`) posts once more when the reviewer's App token was not minted or was rejected (HTTP 401), and exits `6` with the cause when that second post fails too. The ticket pool checks, after a reviewer has ended, that its review is on its pull request: one that is not gets its verdict file posted again through the door, with the token minted first, up to three attempts per head (remembered on disk), and a reviewer that wrote no file is prompted once. A verdict that still is not posted is said on the run, as `verdict not posted: <reason>`, in the log and on the board. A11-83.
