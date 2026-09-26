// @ts-check
// #2658 (child 3g of #69): WHICH REPOSITORY THE TOOL SERVES, for the 30 files of this package that used to import it from
// `scripts/repo-identity.mjs` -- a product file, and one of the nine imports (ADR 0040, decision 4) that kept `agent-org` from
// being a tool that imports nothing outside itself.
//
// It is `project-config.mjs`'s answer and nothing more: the first code repository of `.agent-org/project.json`, which is also
// what `scripts/repo-identity.mjs`'s own `REPO` reads, so the two agree by construction rather than by a test that compares
// two literals. The product's scripts keep `repo-identity.mjs` (they read the declaration directly, which is why its format is
// JSON); the tool does not import it.
//
// READ AT IMPORT, like the file it replaces: a missing or malformed declaration REFUSES here, naming the field, and is never
// answered with a11ign's repository (`project-config.mjs` says why). `PRODUCT_REPO` and the URL constants are NOT here: no file of
// the tool imported them, and they name the product rather than the project the tool serves.
import { homeProjectDeclaration } from "./project-config.mjs";

export const REPO = homeProjectDeclaration().repo;
