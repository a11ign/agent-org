---
"@a11ign/agent-org": patch
---

The `gh` call ledger's 10th field names the read cache's verdict for a read it looked at: `miss-absent`, `miss-generation-moved`, `miss-no-snapshot`, `hit-ttl` and the others, with the arguments' digest, the key's digest and the repository. The ledger held the subcommand and never the arguments, so why the gate's and the tick's polling reads missed the cache (agent-org#742, a11ign#4148) could not be read off it. A line from before it reads unchanged.
