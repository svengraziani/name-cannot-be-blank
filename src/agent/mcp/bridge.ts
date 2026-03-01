/**
 * MCP ↔ AgentTool Bridge
 *
 * Bridges MCP server tools to the existing AgentTool interface.
 * When an MCP server starts, its tools are registered in the ToolRegistry.
 * When it stops, the tools are unregistered.
 */

import { toolRegistry } from '../tools';
import type { AgentTool } from '../tools/types';
import type { McpToolInfo } from './types';
import { callTool } from './client';

/** Track which tools belong to which MCP server */
const serverToolNames = new Map<string, string[]>();

/**
 * Register MCP tools in the ToolRegistry.
 *
 * Tool names are prefixed: mcp_{serverName}_{toolName}
 * This prevents collisions with built-in tools and between MCP servers.
 */
export function registerMcpTools(serverId: string, serverName: string, tools: McpToolInfo[]): string[] {
  const registeredNames: string[] = [];
  const prefix = sanitizeName(serverName);

  for (const mcpTool of tools) {
    const fullName = `mcp_${prefix}_${mcpTool.name}`;

    const agentTool: AgentTool = {
      name: fullName,
      description: `${mcpTool.description} [via MCP: ${serverName}]`,
      inputSchema: mcpTool.inputSchema as AgentTool['inputSchema'],
      execute: async (input: Record<string, unknown>) => {
        return callTool(serverId, mcpTool.name, input);
      },
    };

    toolRegistry.register(agentTool);
    registeredNames.push(fullName);
  }

  serverToolNames.set(serverId, registeredNames);
  console.log(`[mcp] Registered ${registeredNames.length} tools from ${serverName}: ${registeredNames.join(', ')}`);
  return registeredNames;
}

/**
 * Unregister all MCP tools for a server from the ToolRegistry.
 */
export function unregisterMcpTools(serverId: string): number {
  const names = serverToolNames.get(serverId);
  if (!names) return 0;

  for (const name of names) {
    toolRegistry.unregister(name);
  }

  serverToolNames.delete(serverId);
  console.log(`[mcp] Unregistered ${names.length} tools for server ${serverId}`);
  return names.length;
}

/**
 * Get all tool names registered for a specific MCP server.
 */
export function getMcpToolNames(serverId: string): string[] {
  return serverToolNames.get(serverId) || [];
}

/**
 * Get all registered MCP tool names across all servers.
 */
export function getAllMcpToolNames(): string[] {
  const allNames: string[] = [];
  for (const names of serverToolNames.values()) {
    allNames.push(...names);
  }
  return allNames;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
