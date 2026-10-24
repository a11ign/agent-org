import { useState } from "react";
import { CommandLine } from "./CopyButton.tsx";
import { usePage } from "./PageContext.ts";
import {
  addPluginChange, chosenSkill, claudeSaid, claudeStatusOf, healthLinesOf, heldText, isPluginEntry, listedPlugins, needsOf, removePluginChange, skillChange, skillOptions, SKILL_JOBS,
  type ClaudePlugin, type SkillJob, type Tone,
} from "./plugins-model.ts";

function Dot({ tone }: Readonly<{ tone: Tone }>) {
  return <span className={`plugin-dot tone-dot-${tone}`} aria-hidden="true" />;
}

/** What a Claude plugin's health says, line by line: whether workers get it, then each way its contract and this machine disagree. */
function Health({ plugin }: Readonly<{ plugin: ClaudePlugin }>) {
  const { answer, instance } = usePage();
  return (
    <div className="plugin-section">
      <div className="plugin-subhead">Health</div>
      {healthLinesOf(plugin, instance, answer.claude).map((line) => (
        <div key={line.text} className={`plugin-check tone-text-${line.tone}`}>
          <span className="plugin-check-dot"><Dot tone={line.tone} /></span>
          <div className="plugin-check-text">
            {line.text}
            {line.fix === null ? null : <div className="plugin-check-fix"><CommandLine label="Fix:" text={line.fix} what="fix" /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The select that names the skill doing a job: its choices are what the contract provides there. A key that names no single skill of this plugin shows its text instead. */
function SkillSelect({ job, plugin }: Readonly<{ job: SkillJob; plugin: ClaudePlugin }>) {
  const { view, viewWords, controls, changes } = usePage();
  const text = heldText(view, job.key);
  const chosen = chosenSkill(job, text, plugin);
  const id = `skill-${job.point}-${plugin.name}`;
  const provided = skillOptions(job, plugin);
  const options = chosen === null || provided.includes(chosen) ? provided : [chosen, ...provided];
  const pick = (skill: string) => changes.change([skillChange(job, text, plugin, skill)], claudeSaid.skill(job, skill));
  let control;
  if (view === null) control = <span className="plugin-value">{viewWords}</span>;
  else if (job.point === "writer" && chosen === null) control = <code className="plugin-value">{text ?? "Not set"}</code>;
  else {
    control = (
      <select id={id} className="settings-select" value={chosen ?? ""} disabled={!controls || changes.busy} onChange={(event) => pick(event.target.value)}>
        {chosen === null ? <option value="">Not set</option> : null}
        {options.map((skill) => <option key={skill} value={skill}>{skill}</option>)}
      </select>
    );
  }
  return (
    <div className="plugin-job">
      <label htmlFor={id}><span className="settings-label settings-label-block">{job.label}</span><span className="plugin-job-words">{job.words}</span></label>
      {control}
    </div>
  );
}

/** "Which skill does each job": the jobs this plugin's contract provides a skill for, and the plan file its planner writes. */
function Skills({ plugin }: Readonly<{ plugin: ClaudePlugin }>) {
  const jobs = SKILL_JOBS.filter((job) => skillOptions(job, plugin).length > 0);
  const planFile = plugin.contract?.provides.planner?.planFile;
  if (jobs.length === 0 && planFile === undefined) return null;
  return (
    <div className="plugin-section">
      <div className="plugin-subhead">Which skill does each job</div>
      <div className="plugin-rows">
        {jobs.map((job) => <SkillSelect key={job.point} job={job} plugin={plugin} />)}
        {planFile === undefined ? null : (
          <div className="plugin-job">
            <div><span className="settings-label settings-label-block">Plan file name</span><span className="plugin-job-words">What this plugin's planner writes. Must match <code>tickets.plan</code>.</span></div>
            <code className="plugin-value">{planFile}</code>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Needs from this machine": each connector and command the contract needs, and whether this machine has it. */
function Needs({ plugin }: Readonly<{ plugin: ClaudePlugin }>) {
  const { instance } = usePage();
  const needs = needsOf(plugin, instance);
  if (needs.length === 0) return null;
  return (
    <div className="plugin-section">
      <div className="plugin-subhead">Needs from this machine</div>
      <div className="plugin-rows">
        {needs.map((need) => (
          <div key={`${need.label}|${need.value}`} className="plugin-job">
            <div><span className="settings-label settings-label-block">{need.label}</span><code className="plugin-value">{need.value}</code></div>
            <span className={`plugin-status tone-text-${need.tone}`}><Dot tone={need.tone} />{need.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClaudeCard({ plugin }: Readonly<{ plugin: ClaudePlugin }>) {
  const { answer, instance, controls, changes } = usePage();
  const status = claudeStatusOf(plugin, instance);
  const remove = () => changes.change([removePluginChange(listedPlugins(answer.claude), plugin.entry)], claudeSaid.removed(plugin.entry));
  return (
    <section className="plugin-card" aria-label={plugin.name}>
      <div className="plugin-claude-head">
        <span className="plugin-claude-name">{plugin.name}</span>
        {plugin.contract === null ? null : <span className="plugin-chip">contract {plugin.contract.contract}</span>}
        {plugin.contract === null ? null : <span className="plugin-chip">agent-org {plugin.contract.agentOrg}</span>}
        <span className="plugin-spacer" />
        <span className={`plugin-status tone-text-${status.tone}`}><Dot tone={status.tone} />{status.text}</span>
      </div>
      <div className="plugin-claude-body">
        <Health plugin={plugin} />
        <Skills plugin={plugin} />
        <Needs plugin={plugin} />
        {controls ? (
          <div className="plugin-actions">
            <button type="button" className="ghost" disabled={changes.busy} onClick={remove}>Remove from workers</button>
            <span className="plugin-lock">Stops loading it into new runs. It stays installed.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The form that adds a Claude plugin to `tickets.plugins` by its `name@marketplace`. */
function AddForm() {
  const { answer, changes } = usePage();
  const [entry, setEntry] = useState("");
  const listed = listedPlugins(answer.claude);
  const text = entry.trim();
  const ready = isPluginEntry(text) && !listed.includes(text) && !changes.busy;
  const add = () => {
    if (!ready) return;
    changes.change([addPluginChange(listed, text)], claudeSaid.added(text));
    setEntry("");
  };
  return (
    <form className="plugin-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <label className="plugin-add-field">
        <span className="visually-hidden">Plugin to add, as name@marketplace</span>
        <input type="text" className="plugin-add-input" placeholder="name@marketplace" value={entry} onChange={(event) => setEntry(event.target.value)} />
      </label>
      <button type="submit" className="primary primary-small" disabled={!ready}>Add Claude plugin</button>
    </form>
  );
}

/**
 * The Claude plugins tab: the plugins `tickets.plugins` lists and loads into every worker's session, kept apart from the agent-org plugins by its own intro and its own cards. A change is a key
 * of the host file, previewed and saved through the Settings routes; it never touches an agent-org plugin.
 */
export function ClaudeTab() {
  const { answer, controls } = usePage();
  return (
    <div className="plugin-tab plugin-tab-claude">
      <p className="plugin-lede">Listed in <code>tickets.plugins</code> and loaded into every worker's session. Install on the host with <code>claude plugin install &lt;plugin&gt; --scope user</code>.</p>
      {answer.claude.plugins.map((plugin) => <ClaudeCard key={plugin.entry} plugin={plugin} />)}
      {controls ? <AddForm /> : null}
    </div>
  );
}
