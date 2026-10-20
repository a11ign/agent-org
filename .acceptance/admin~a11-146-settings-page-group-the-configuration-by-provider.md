## What it is

The Settings page listed every key of the host file and the project file in one flat list, each with a paragraph of explanation, so a provider's few settings were buried among the machine's plumbing. It now draws one collapsible section per group, in the order the schema gives them: each provider's section, the conventions plugin's, and the rest, with `Machine` (schema, home, binDir, projects, tool and the other plumbing) closed on load. Each row is one line, with its value, its state, its source and whether it is `Editable` or `Read-only`; what the key does and what breaks if it is wrong sit behind a `Details` disclosure. A search box filters the rows by key or explanation.

## Change

- `src/ticket-mode/settings-search.ts` (new): the search, a plain case-insensitive substring over each row's key and explanation. It imports nothing, so the page runs it as it is.
- `src/ticket-mode/settings-view.ts`: each row gains `editable`, `why` (why a key is not changed in place) and `alias` (the new key an old key stands for, shown in place of its value). A provider whose block is missing says `set by aliases` while one of its old keys is set.
- `src/ticket-mode/ui-server.ts`: serves `settings-search.ts` as `/settings-search.js`.
- `src/ticket-mode/ui.html`: the sections are `details`, with the open state the person last left kept across a redraw; the search box and its status line; the row layout and the Details disclosure. Editing (A11-132) is unchanged: an editable row still gets its Edit control.
- Tests: `settings-search.test.ts` (new); `settings-view.test.ts` for the row model, aliases, `set by aliases` and the groups; `ui.test.ts` for the sections, the search and its status line, the Details disclosure and the Editable and Read-only words.

## Acceptance

Acceptance:
```bash
P=$(mktemp -d) && cp -r src/packaging/fixtures/project-tree/. "$P" && sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json" && git -C "$P" init -q && git -C "$P" add -A && git -C "$P" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "the fixture project" && AGENT_ORG_HOST="$P/.agent-org/host.json" pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings-search.test.ts src/ticket-mode/settings-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-css.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/settings-read.test.ts
```

Consumer-declaration: none -- the page reads the same view it always did. Only the way the view is drawn changed.
