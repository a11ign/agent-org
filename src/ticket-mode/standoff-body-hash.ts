// module: the hash a stand-off round keeps of a pull request's description (A11-290) -- the board writes it when the round begins and the Stop hook compares it, so both hash the same text
import { createHash } from "node:crypto";

/** The hash of a description, trimmed: a description edited only at its ends is the same description. */
export const bodyHash = (body: string): string => createHash("sha256").update(body.trim()).digest("hex");
