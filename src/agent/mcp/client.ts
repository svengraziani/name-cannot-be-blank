/**
 * MCP Protocol Client
 *
 * Connects to MCP servers using the official @modelcontextprotocol/sdk.
 * Supports both SSE (HTTP) and stdio (Docker attach) transports.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig, McpToolInfo } from './types';
import type { ToolResult } from '../tools/types';

/** Active MCP client connections, keyed by server ID. */
const activeClients = new Map<string, Client>();
const activeTransports = new Map<string, SSEClientTransport | StdioClientTransport>();

/**
 * Connect to an MCP server and return the client.
 * Retries with exponential backoff for SSE transport.
 */
export async function connectToServer(config: McpServerConfig): Promise<Client> {
  // Disconnect existing client if any
  await disconnectServer(config.id);

  const client = new Client(
    { name: 'loop-gateway', version: '1.0.0' },
    { capabilities: {} },
  );

  let transport: SSEClientTransport | StdioClientTransport;

  if (config.transport === 'sse') {
    if (!config.hostPort) {
      throw new Error('SSE transport requires a hostPort');
    }

    const url = new URL(`http://127.0.0.1:${config.hostPort}/sse`);

    // Retry connection with exponential backoff
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        transport = new SSEClientTransport(url);
        await client.connect(transport);
        activeClients.set(config.id, client);
        activeTransports.set(config.id, transport);
        console.log(`[mcp] Connected to ${config.name} via SSE on port ${config.hostPort}`);
        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
        console.log(`[mcp] Connection attempt ${attempt + 1} failed for ${config.name}, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
    throw new Error(`Failed to connect to ${config.name} after 5 attempts: ${lastError?.message}`);
  } else {
    // stdio transport — connect via docker attach
    if (!config.containerId) {
      throw new Error('stdio transport requires a containerId');
    }

    transport = new StdioClientTransport({
      command: 'docker',
      args: ['attach', '--sig-proxy=false', config.containerId],
    });

    await client.connect(transport);
    activeClients.set(config.id, client);
    activeTransports.set(config.id, transport);
    console.log(`[mcp] Connected to ${config.name} via stdio`);
    return client;
  }
}

/**
 * Discover tools from a connected MCP server.
 */
export async function discoverTools(serverId: string): Promise<McpToolInfo[]> {
  const client = activeClients.get(serverId);
  if (!client) {
    throw new Error(`No active client for server ${serverId}`);
  }

  const result = await client.listTools();
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
  }));
}

/**
 * Call a tool on a connected MCP server.
 */
export async function callTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const client = activeClients.get(serverId);
  if (!client) {
    return { content: `MCP server ${serverId} is not connected`, isError: true };
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: args });

    // MCP tool results have content array with text/image blocks
    const textParts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          textParts.push(String((block as { text: string }).text));
        } else if (typeof block === 'string') {
          textParts.push(block);
        }
      }
    } else if (typeof result.content === 'string') {
      textParts.push(result.content);
    }

    return {
      content: textParts.join('\n') || 'No output',
      isError: result.isError === true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `MCP tool error: ${msg}`, isError: true };
  }
}

/**
 * Disconnect from an MCP server and clean up resources.
 */
export async function disconnectServer(serverId: string): Promise<void> {
  const transport = activeTransports.get(serverId);
  if (transport) {
    try {
      await transport.close();
    } catch {
      // Ignore close errors
    }
    activeTransports.delete(serverId);
  }

  const client = activeClients.get(serverId);
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
    activeClients.delete(serverId);
  }
}

/**
 * Check if a server has an active client connection.
 */
export function isConnected(serverId: string): boolean {
  return activeClients.has(serverId);
}

/**
 * Get count of active connections.
 */
export function getActiveConnectionCount(): number {
  return activeClients.size;
}

/**
 * Disconnect all active MCP clients.
 */
export async function disconnectAll(): Promise<void> {
  const ids = Array.from(activeClients.keys());
  for (const id of ids) {
    await disconnectServer(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
