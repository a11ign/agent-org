---
"agent-org": minor
---

`node src/trace/growth.ts --from=<ISO> --to=<ISO> --by-command` adds a "Bash by command" table beneath the by-tool one: the `Bash` row split by the command's first word (`gh`, `git` and `pnpm` by their first subcommand, `node` by what it runs), over the same requests and the same derivation, so its rows sum to the Bash row and a sum check beside it says so. A piped or chained line is its first command; a bare assignment, `export`, `set` and a `cd <dir> &&` in front of it are setup and skipped (read literally they were 61% of a week's Bash growth and named nothing); a line the splitter cannot read is `(unparsed)`, and parallel Bash calls of different commands are `(several commands)`. Without the flag the output is unchanged. a11ign/a11ign#4181.
