// A test-support module (A11-160, step 9): the fake code host with some of its `rows` operations ASKING THE `run` THEY ARE HANDED. The fake acts on its own state and ignores that `run`, but the work gate's WAVE
// (`readWithFirstWaveTogether`) is the executor's policy over the calls its readers make through `run`: it rehearses the readers, sends what they asked as one batch, and replays the answers. A test of that policy
// names the operations whose call it wants seen, and each one makes ONE call to its `run` first, named by the operation and the thing it is about (`fake:<operation> <detail>`, never GitHub's argument list),
// then answers from the world as ever. A refusal the batch replays is thrown by that call, so the operation is refused as the plugin's would be. `substituteCodeHost(host)` puts it where core finds it.
import type { CodeHost } from "../contracts/code-host.ts";

/** The name a stand-in call is made under: `fake:<operation>` then its details. */
export const standIn = (operation: string, ...details: (string | number | null | undefined)[]): string[] => [`fake:${operation}`, ...details.filter((d) => d !== undefined && d !== null).map(String)];

/**
 * `host`, with each operation in `asking` making the call `asking[operation](request)` names through the request's `run`, aimed as the caller aimed it, before it answers.
 * @returns the same host, so a test writes `substituteCodeHost(askingRunFirst(createFakeCodeHost(), {...}))`
 */
export function askingRunFirst<H extends CodeHost>(host: H, asking: Record<string, (request: any) => string[]>): H {
  const rows = host.rows as unknown as Record<string, (request: { run: (args: string[]) => string }) => unknown>;
  for (const [operation, call] of Object.entries(asking)) {
    const answer = rows[operation].bind(host.rows);
    rows[operation] = (request) => {
      request.run(call(request));
      return answer(request);
    };
  }
  return host;
}
