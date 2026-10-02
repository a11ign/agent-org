<!--
This repository holds the agent-org tool only. `gate` (ci.yml) runs a path check over the workflows and a leak scan over the
whole tree; it does NOT run the tool's test suite yet (see the header of ci.yml for why), so what you ran is what tells the reviewer
the change works. The repository is PUBLIC: nothing in this body or the diff may carry a private address, a key path or a token.
-->

Closes a11ign/a11ign#

<!-- The row lives in a11ign/a11ign, so name it in the full form: the short one points at an issue of THIS repository. A PR that finishes no row replaces the line with the opt-out and a reason (`pr-open` names the exact words). -->

## What changes, and why

<!-- The why matters more than the what; the diff shows the what. -->

## Platform first, deleting first

<!-- Two chairman rules (2026-10-02, a11ign/a11ign#3021). A PR that reimplements a platform feature is refused, and so is one that grows this repository without a reason. -->

platform: <!-- what you checked: does GitHub, pnpm, systemd or git already do this? -->

Net lines: <!-- non-test lines added minus removed; if positive, why removing or reusing could not do it -->

## How you verified it

<!-- The command and what it printed. A number without its command is a claim, not a reading. -->

## Anything a reviewer should be sceptical of

<!-- An assumption you could not check, a path you could not test. -->
