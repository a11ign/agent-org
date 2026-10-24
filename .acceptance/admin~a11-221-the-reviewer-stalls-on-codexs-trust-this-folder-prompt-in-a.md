The atomic reviewer makes Codex trust the review's repository before it starts Codex, when the host file names that repository. `agent-org doctor` lists each host repository Codex does not trust, with the fix, and onboard's `codex trust` step trusts every chosen repository.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts plugins/atomic-reviewer/codex-trust.test.ts plugins/atomic-reviewer/port.test.ts plugins/atomic-reviewer/checks.test.ts plugins/atomic-reviewer/onboard.test.ts plugins/atomic-reviewer/index.test.ts src/install/doctor.test.ts src/install/onboard.test.ts
```

Live check against a copy of the machine's Codex config (the real `~/.codex/config.toml` is never written): doctor lists the host repositories the copy lacks, onboard's step trusts them in the copy, and doctor then passes.
```bash
TMP=$(mktemp -d)
cp "$HOME/.codex/config.toml" "$TMP/config.toml"
CODEX_HOME="$TMP" node src/bin.ts doctor | grep "codex trust"
CODEX_HOME="$TMP" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { ONBOARD_STEPS } from "./plugins/atomic-reviewer/onboard.ts";
const clones = JSON.parse(readFileSync(`${process.env.HOME}/.agent-org/host.json`, "utf8")).clones;
const answer = await ONBOARD_STEPS.find(({ name }) => name === "codex trust").run({}, { env: process.env, clones, home: process.env.HOME });
console.log(answer.detail);
process.exit(answer.ok ? 0 : 1);'
CODEX_HOME="$TMP" node src/bin.ts doctor | grep "ok    codex trust"
rm -rf "${TMP:?}"
```

Mutation: `ensureTrusted` was made to write for any root, and the test that a root outside the host file leaves the config untouched went red; it was made to rewrite an existing entry, and the byte-identical test went red; restored, the suite passed again.

Consumer-declaration: none -- `codex-trust.ts` is read only by the atomic reviewer's port, doctor rows and onboard step.
