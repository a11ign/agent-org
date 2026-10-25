import type { ConfigView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { ChoiceSection } from "./ChoiceSection.tsx";
import { SettingsSkeleton } from "./SettingsSkeleton.tsx";
import { useChoices } from "./use-choices.ts";
import { usePool } from "./use-pool.ts";
import { WorkerPool } from "./WorkerPool.tsx";

/** The model and effort selects of Models, over the config the instance answers: loading, the failure, or the selects. */
export function Models() {
  const { client, connection } = useShell();
  const config = usePoll<ConfigView>(client.config, { connection, repeat: false, isEmpty: () => false });
  return (
    <Lifecycle view={config} skeleton={<SettingsSkeleton label="Loading models" />} empty={null} connection={connection?.name ?? ""}>
      {(data) => <Choices config={data} refresh={config.refresh} cached={config.cached} />}
    </Lifecycle>
  );
}

/** The selects over the config; while it is the tab's kept copy (A11-270) they wait for the instance's own answer. */
function Choices({ config, refresh, cached }: Readonly<{ config: ConfigView; refresh: () => void; cached: boolean }>) {
  const { client } = useShell();
  return <ChoiceSection config={config} choices={useChoices(client, config, refresh)} disabled={cached} />;
}

/** The worker pool of Workers: the number of workers and whether they are started, over the queue the shell polls. */
export function Workers() {
  const { client, queue } = useShell();
  return <WorkerPool pool={usePool(client, queue)} />;
}

