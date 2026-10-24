import type { SettingsView } from "../api/types.ts";

/** What the Conventions plugin's section says of the plugins workers run with. */
const PLUGINS_WORDS = "Plugins each worker runs with, and whether a worker's session loads each one";

/** What the contract mismatches are. */
const CONTRACT_WORDS = "Contract mismatches: what a plugin declares that this host's keys do not meet";

/**
 * What `ui.html` says in its Conventions plugin section besides the keys: which plugins each worker runs with and whether its session loads each, the contract mismatches, and each connector
 * and deny rule in plain words. A closed disclosure on the Machine page. Nothing when the instance sends none of them.
 */
export function ConventionsNotes({ view }: Readonly<{ view: SettingsView }>) {
  const { plugins, contract, words } = view;
  if (plugins.length === 0 && contract.length === 0 && words.length === 0) return null;
  return (
    <details className="settings-conventions">
      <summary className="settings-conventions-summary">Conventions plugin</summary>
      <div className="settings-conventions-body">
        <p className="setting-meta">{PLUGINS_WORDS}</p>
        <ul className="settings-conventions-list">
          {plugins.map(({ plugin, installed, loads }) => <li key={plugin}>{plugin}: {installed}; {loads}</li>)}
        </ul>
        {contract.length === 0 ? null : (
          <>
            <p className="setting-meta">{CONTRACT_WORDS}</p>
            <ul className="settings-conventions-list">
              {contract.map(({ why }) => <li key={why}>Mismatch: {why}</li>)}
            </ul>
          </>
        )}
        <ul className="settings-conventions-list">
          {words.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </details>
  );
}
