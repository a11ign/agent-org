---
"agent-org": minor
---

The Tickets page has a project picker and searches the whole workspace (A11-378). The sidebar's Projects now list every open project the tracker has, after "My tickets, all projects". Picking a project reads only that project's open tickets, a page at a time, and the Assignee row then filters within it. The page opens on the project this browser picked last, or on your own tickets on a first visit. Choosing Anyone no longer pages through every open ticket in the workspace. The search box also asks the tracker for open tickets that match by key or by words, whoever holds them and whatever their project. Any it finds outside the list are shown below it, can be opened, and can be queued. Tracker contract 1.9 adds the optional `projects`, `projectPage` and `search`, and Linear implements all three.
