The Pick view is driven by a project picker and a workspace search (A11-378). On an instance whose tracker lists projects, the sidebar's Projects list "My tickets, all projects" and then every open project the tracker has. Picking a project reads `/api/tickets?project=` a page at a time, and the Assignee row starts on Anyone and filters that project only. The page opens on the project this browser picked last, or on My tickets on a first visit. Such an instance offers no whole-workspace scope: `/api/people` and `?assignee=` answer 404, and the config's `scopes` is false. The search box asks `/api/search` for the whole workspace's open tickets, by key or by words. Matches the list does not hold are drawn below it with their owner and project, and can be queued. Tracker contract 1.9 adds the optional `projects`, `projectPage` and `search`. Linear reads them through `projects`, the `tickets.pick` project query and `searchIssues`, each value passed as a GraphQL variable.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/linear/linear.test.ts plugins/linear/conformance.test.ts src/plugins/fakes/tracker.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/loop-load-routes.test.ts
(cd ui && npx rstest run --config rstest.config.ts src/tickets/tickets-projects.test.tsx)
```

Consumer-declaration: none -- no host file key changes meaning.
