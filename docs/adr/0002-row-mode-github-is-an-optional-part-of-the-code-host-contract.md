# Row mode's GitHub operations are an optional `rows` part of the codeHost contract

## Context

A11-157 moves every `gh` call into `plugins/github`. Ticket mode uses GitHub only as its code host: pull requests, reviews, checks and stacks. Row mode also uses GitHub issues as its tracker (`TicketPort`, implemented by `src/ticket-port/github-adapter.ts`), and project items and labels as its queue. A11-158 made the tracker contract ticket mode's `TicketSource`, and a plugin's manifest declares one concern.

## Decision

`plugins/github` implements the codeHost contract. Row mode's GitHub operations are one optional member group of that contract, `rows`. A code host without `rows` serves ticket mode only, and a row-mode entry refuses to start without it, by name.

## Why

It keeps one plugin per integration, and one concern per manifest. It also keeps the ticket-mode contract small, because a third-party code host (Decision 4) implements only what ticket mode asks. And it lets row mode be retired later by removing `rows` in a major version, with nothing else changing.

## Considered

- **A second plugin for row mode's GitHub tracker**: rejected. Both would spawn `gh` with the same identity and wrapper, and the ratchet's single exempt directory would split.
- **A generic `gh(args)` pass-through in the contract**: rejected. It keeps GitHub's command language in core (Decision 2), and the ratchet would still count its arguments.
- **Deleting row mode instead of moving it**: not this ticket's decision. No ticket retires row mode.

## Paths

- `agent-org:plugins/github/`
- `agent-org:src/plugins/contracts/code-host.ts`
