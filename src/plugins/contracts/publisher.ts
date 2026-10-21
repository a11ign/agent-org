// @ts-check
// module: the publisher contract, version 1.1 -- the publish run's seam (A11-158, A11-161)
//
// A TYPE FILE: it imports nothing at run time. Publishing is an agent run the board starts (`startPublish` in `pool-start.ts`), so no Slack call is made by core:
// a publisher says what the run is told (`publishBriefText`, `worker-files.ts`), which connectors it may call (`tickets.providers.publish.connectors`, enforced by
// `publishConnectors` in `hook.ts`), what model and effort the run runs on, and how its outcome file reads (`publishResult`, `pool-outcome.ts`). The run itself stays the board's. A host
// with no publisher publishes nothing: the board refuses to queue a publish run. 1.1 added `agent()`, which the plugin owns because the model and effort are its settings (A11-161).

/** The publisher contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const PUBLISHER_CONTRACT_VERSION = "1.1";

/** The file a publish run writes in its folder, holding `{ "links": [...] }`: the protocol both the brief and the outcome reading name. */
export const PUBLISHED_FILE = "published.json";

/** A pull request a person chose to publish: its repository and its web address. */
export type PublishedPull = Readonly<{ repo: string; url: string }>;

/** What a publish run settled on: the web address of each message it posted (possibly none), or why it failed. */
export type PublishResult = Readonly<{ links: readonly string[] } | { failure: string }>;

/** A publisher plugin. */
export interface Publisher {
  /** The run's brief, as markdown: post the pull requests with this machine's instruction, `run`, and write down the messages posted. `{prs}` and `{dir}` are filled in. */
  briefText(request: Readonly<{ dir: string; prs: readonly PublishedPull[]; run: string }>): string;
  /** The connector tools the run may call, as regular expressions anchored at `^mcp__`. */
  connectors(): readonly string[];
  /** The model and effort the publish run runs on (1.1). */
  agent(): Readonly<{ model: string; effort: string }>;
  /** How the run ended, from its outcome file's text and the links file beside it in `dir`, which this reads. */
  result(outcomeText: string, dir: string): PublishResult;
}
