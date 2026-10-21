// @ts-check
// module: what the Linear plugin's manifest declares of its MCP, read once from its own package.json (A11-159)
//
// The manifest (`package.json`'s `agentOrg.tooling`) is the one place the connector patterns are written; the plugin's code reads them from it, so onboard adds exactly what the
// registry and the hook know.
import { readFileSync } from "node:fs";

type Manifest = { agentOrg: { tooling: { mcpServers: string[]; connectors: string[] } } };

const { agentOrg } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as Manifest;

/** Linear's MCP tools a worker may call: its reads, and a comment on its own ticket. Never a save of an issue, a state or a relation. */
export const CONNECTORS: readonly string[] = Object.freeze([...agentOrg.tooling.connectors]);
/** The name Linear's MCP is registered under in Claude Code. */
export const MCP_NAME = agentOrg.tooling.mcpServers[0];
export const MCP_URL = "https://mcp.linear.app/mcp";
