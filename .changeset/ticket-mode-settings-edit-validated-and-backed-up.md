---
"agent-org": minor
---

The Settings page now changes values the schema describes in the machine's `host.json` (including its `tickets` block) and in the primary project's `.agent-org/project.json`. A change is checked by the same readers that load the file before anything is written, and a value they refuse is not written: the page shows the reader's message, which names the field. Before a save the page shows each key's old and new value and when it takes effect, and asks to confirm; a key whose wrong value can break the board asks for a second confirmation that names what it can break. Each save first copies the file to a backup beside it and then replaces the file in one step, keeping its prose keys, its key order and its layout. The page can restore the backup. A secret's path can be changed; its contents are never read or written from the page, and a remote instance offers no edit.
