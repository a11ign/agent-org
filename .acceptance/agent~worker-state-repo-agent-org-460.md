`worker:state blocked <row>` resolves the row's tracker and refuses a closed row (a11ign/agent-org#460, follow-up to #618, which merged before the product-manager's row write of 2026-10-10 on the row was read). **The incident:** a live `worker:state blocked 460` by `worker-agent-org-460` labelled `answer:product-manager` and commented on `a11ign/a11ign#460`, a row closed 2026-09-08, because the command used the home tracker's repository for every number, and it woke the product-manager there.

**What changes.**
- *Resolve, never default.* A keyed reference (`agent-org#460`, or by `owner/name`) names its tracker; an undeclared key is refused `unknown-tracker`, listing the declared ones. A bare number is looked up in every declared tracker: one row, that one; several, the one whose row carries `session:<this session>`; otherwise refused `ambiguous-row` naming each as its keyed spelling; none is `no-such-row`; a read that failed is `unreadable-row` and writes nothing.
- *A closed row is refused* `row-closed`, naming the state and `gh issue reopen <n> --repo <repo>` (by a person).
- *The declaration records the resolved repository* (`repo`), and the gate reads a `blocked` declaration for another repository's row of the same number as `lapsed`, not as an excuse. A declaration written before this has no `repo` and is read as before.
- The tests use `gh` as a recording fixture; no live tracker is read or written.

Mutation: five, each red and each restore byte-identical (copy in the scratchpad and `diff`): the first tracker winning where several have the row (3 red); the claim label not breaking the tie (2); a closed row accepted (1); an undeclared key defaulting (1); the repository ignored by the excuse (1).

Evidence: `src/worker-state.test.ts` 28 of 28 (the original 20 and eight new: the incident resolved to `a11ign/agent-org`, the POSITIVE CONTROL that the replaced call targeted `a11ign/a11ign`, ambiguous refused naming both with the keyed spelling resolving, unknown tracker, closed refused with the reopening, no such row and unreadable row, `ghRowLook`, another repository's declaration lapsed). The four related files pass (214 together with this one). `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `main` has. The whole suite: 36 of 8682 fail; 35 are in files that fail identically on a clean `origin/main` (13 files, measured there for the six that were not in the older baseline), and the one that was mine, `gh-call-inventory`, is regenerated and passes.

Not done: Done-when 2 and 3 of #460 are live items for a seat the `worker:*` resource ban does not cover; this change does not close the row.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/worker-state.test.ts`

Closes: none -- #460's Done-when 2 and 3 are live runs of `worker:state` (and a live tick or the 2026-10-09 replay) that this seat's resource ban does not allow it to make; the row stays open for a seat that can.

Outside-Region: src/work-gate/claim-stall-tick.ts — the gate hands the claim's repository to `declarationReading`, which is where the declaration is read against the claim.
Outside-Region: docs/gh-call-inventory.json — the committed inventory of `gh` call shapes; the one new `issue view` (the row's state and labels) is in it, regenerated with the generator.
Outside-Region: .changeset/worker-state-names-its-tracker.md — the entry a project that pins a tag reads.

platform: n/a (no GitHub, pnpm, systemd or git feature beyond `gh issue view`, `gh label create`, `gh issue edit --add-label` and `gh issue comment`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
