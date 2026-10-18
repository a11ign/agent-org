---
"agent-org": minor
---

The host's `gh` wrapper now has one writer, and that writer refuses a wrapper that names no GitHub App while `host.json` declares one, or that would drop the Apps an installed wrapper already names. On 2026-10-17 a wrapper with an empty App table replaced one with four, and no App token was minted for any role for an hour and twenty minutes. `host:install --allow-no-apps` is the one way past the downgrade guard, for a host that really dropped its Apps. A tick that is refused says so as a note and writes nothing.

`doctor` checks the installed wrapper against the one `host.json` declares, and mints a token for each declared role, naming the minter's reason when one fails. The instance checks the wrapper at start-up: a divergence is logged as an error and re-rendered through the same writer, and a role whose mint fails is logged on every start. Ticket workers may not write the host's `gh` or `agent-org` in its bin directory, by a file tool or a command, and may not run `host:install`. The tests never write the real home's bin directory.
