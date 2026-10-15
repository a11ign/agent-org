---
"@a11ign/agent-org": patch
---

`pr-open create` refuses a `Closes` of a row whose Region spans two or more repositories while another repository's pull request, still open, also names that row (a11ign/agent-org#923). The refusal names that pull request and the first-half declaration that is the right one for this half: a `none` line whose reason names the row. A single-repository row, a row with no other open pull request, and a pull request in the row's own repository that names it all pass as before. An open-pull list that cannot be read refuses by name, so a failed `gh` is never read as "nothing is open" (#1286). The open-pull read is `openPullsOf` in `src/ticket-port/open-pulls.ts`, with `gh` handed in by `pr-open.ts`, so the gh-call baseline does not grow.
