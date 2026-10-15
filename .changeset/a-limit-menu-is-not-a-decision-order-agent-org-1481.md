---
"agent-org": patch
---

The usage-limit menu is no longer raised as a decision order (agent-org#1481). `raisePaneDialogs` read the menu as a dialog and sent its owner an order offering "switch to usage credits", so each time the allowance was spent every seat on the account became a decision order. A pane that shows the limit menu is now read as showing no dialog: the dated account wait and `limitMenuTick` own that screen. A non-limit dialog is raised exactly as before.
