Step 2 of 2. When a reviewer's Codex still stops on a dialog, the board sees it in the pane. Reviewer contract 1.6 adds the optional `ReviewerPort.unblock`: for a reviewer herdr shows `blocked`, the atomic reviewer answers Codex's "Trust this folder?" with `enter` when the repository root it names is one of the host file's `clones` (it trusts the root in Codex's config first), at most twice per seat and head. Any other dialog, and a trust dialog for a root the host file does not name, is left with no key sent: the pool shows `the reviewer stopped on a dialog it cannot answer: "<first line>"` on the pull request's review line and hands the run that holds it to a person as Needs you, until a look finds no dialog.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts plugins/atomic-reviewer/reviewer-dialog.test.ts plugins/atomic-reviewer/port.test.ts plugins/atomic-reviewer/conformance.test.ts plugins/atomic-reviewer/index.test.ts src/ticket-mode/pool-reviewer-dialog.test.ts src/ticket-mode/board-view/reviewer-dialog-note.test.ts src/ticket-mode/board-view/stale-block.test.ts src/ticket-mode/pool-reviewers.test.ts src/plugins/built-in.test.ts src/plugins/cli.test.ts
```

Live check, from step 1, against a copy of the machine's Codex config (the real `~/.codex/config.toml` is never written): doctor lists the host repositories the copy lacks, onboard's step trusts them in the copy, and doctor then passes.
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

Mutation: the answer was made to press without the host-repository check, to ignore the answer limit, to read the pane of a reviewer that is not blocked, to press with the first option not selected, to look at a head that has a review posted, to skip the pool's flag on the run, to clear the note on a sweep that read nothing, and to leave the note on a merged pull request; each time the test for that behaviour went red, and the suite passed again once restored.

Consumer-declaration: the reviewer contract's new `unblock` is optional and read only by `pool-reviewers.ts`; `ReviewerBoard.herdr.readDialogLines` is read only by the atomic reviewer's `reviewer-dialog.ts`; a reviewer of 1.5 without the method is read as one that reports no dialog (`pool-reviewer-dialog.test.ts`).
