---
"agent-org": patch
---

`messaging:watch` can now send: the Telegram provider is registered in its default `providers`, built from the token file and the chairman file the `messaging` key names. It was written and never registered, so every run exited 1 with "no implementation of it yet" and the `chairman-watch` unit never sent the chairman anything; every test injected its own provider, so none could see it. A token file at the wrong mode, or a checkout never paired, now ends the run with a line naming that file and exit 1, with no stack trace and no secret. `main` takes an injectable `fetch`, and a provider factory is called with `(config, { fetch, log })`.
