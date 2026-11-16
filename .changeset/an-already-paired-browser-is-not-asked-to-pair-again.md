---
"agent-org": patch
---

A browser that is already paired with the board is no longer stuck on the pairing page. iPad Chrome left the board's `SameSite=Strict` session cookie off its page loads but sent it with the Pair button's request, so the board showed the pairing page and then answered every code with `no route POST /pair`. The cookie is now `SameSite=Lax`, so a page load carries it, and a Pair from a browser that is already paired is answered as paired, without spending the code, so the page reloads onto the board.
