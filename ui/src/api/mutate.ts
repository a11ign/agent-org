import type { Answer } from "./answer.ts";
import { send, type Target } from "./request.ts";

/**
 * Every change to an instance goes through here: a `POST`, answered as data. A refusal comes back as the server's own sentence (`{ ok: false, refusal }`),
 * never thrown, so a page shows the backend's real words.
 */
export function mutate<T>(target: Target, path: string, body?: unknown): Promise<Answer<T>> {
  return send<T>(target, { method: "POST", path, body });
}
